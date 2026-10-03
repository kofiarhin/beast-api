import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrokerExecutor } from "../src/admin/executor.js";
import { BrokerHostProbe, type HostProbe } from "../src/admin/probe.js";
import { CAPTURE_FILE_TOKEN, encode, type SpawnRequest } from "../src/admin/protocol.js";
import { operationIds } from "../src/admin/registry.js";
import { validateOperation } from "../src/admin/validate.js";
import { issueGrant } from "../src/admin/authorize.js";
import { silentLogger } from "../src/logger.js";
import { Broker } from "../src/executor/broker.js";
import { BrokerClient } from "../src/executor/client.js";
import type { BrokerConfig } from "../src/executor/config.js";
import { BrokerHost, type Account } from "../src/executor/host.js";
import type { RawResult } from "../src/executor/operations.js";
import { BrokerCommandRunner } from "../src/executor/runner.js";
import { FakeProbe, policyWith } from "./admin-helpers.js";

/**
 * The broker over a real Unix socket. The host is faked only where root is needed:
 * "dropping" to the agent user runs the program as the current user, and lookups use
 * FakeProbe. Everything else (wire protocol, validation, facts, approvals, spawning,
 * capture files, kill on disconnect) is the production code.
 */
class TestHost extends BrokerHost {
  fake = new FakeProbe();
  override async account(name: string): Promise<Account | null> {
    return { name, uid: process.getuid!(), gid: process.getgid!(), home: os.tmpdir() };
  }
  override dropTo(_a: Account, file: string, args: readonly string[]): [string, string[]] {
    return [file, [...args]];
  }
  override probe(): HostProbe {
    return this.fake;
  }
}

let dir: string;
let sock: string;
let server: net.Server;
let host: TestHost;
let performed: string[];
let client: BrokerClient;

function writePolicy(enabled: string[]) {
  fs.writeFileSync(path.join(dir, "policy.json"), JSON.stringify({ version: 1, enabledOperations: enabled }));
}

function script(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bx-"));
  sock = path.join(dir, "s.sock");
  const ws = path.join(dir, "projects");
  fs.mkdirSync(path.join(ws, "app"), { recursive: true });
  execFileSync("git", ["init", "-q", path.join(ws, "app")]);
  writePolicy(operationIds());
  const cfg: BrokerConfig = {
    policyFile: path.join(dir, "policy.json"),
    stateDir: path.join(dir, "state"),
    workspaceRoot: fs.realpathSync(ws),
    agentUser: "beast-agent",
    pm2User: "ubuntu",
    programs: {
      claude: script("fake-claude", `process.stdout.write(JSON.stringify({ keys: Object.keys(process.env).sort(), cwd: process.cwd() })); setTimeout(() => {}, Number(process.argv[2] ?? 0));`),
      codex: script("fake-codex", `require("node:fs").writeFileSync(process.argv[process.argv.indexOf("--out") + 1], "last message");`),
      npm: script("fake-npm", `console.log("npm", process.argv.slice(2).join(" "))`),
      git: "/usr/bin/git",
    },
    bins: { setpriv: "/usr/bin/setpriv", systemctl: "/bin/false", journalctl: "/bin/false", nginx: "/bin/false", dpkgQuery: "/bin/false", getent: "/usr/bin/getent", pm2: "/bin/false", tail: "/usr/bin/tail" },
    nginxLogs: { access: "/nonexistent", error: "/nonexistent" },
    beastPaths: ["/home/ubuntu/apps/beast-api"],
  };
  fs.mkdirSync(cfg.stateDir);
  host = new TestHost(cfg);
  performed = [];
  const broker = new Broker({
    host,
    logger: silentLogger,
    perform: async (op): Promise<RawResult> => {
      performed.push(op.op);
      return { status: "succeeded", fields: { done: op.op }, output: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB" };
    },
  });
  server = net.createServer((s) => broker.handle(s));
  await new Promise<void>((r) => server.listen(sock, r));
  client = new BrokerClient(sock, 10_000);
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function raw(msg: unknown): Promise<{ type: string; reason?: string; result?: { status: string; reason?: string; output?: string } }> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sock);
    let buf = "";
    s.setEncoding("utf8");
    s.on("connect", () => s.write(typeof msg === "string" ? msg : encode(msg)));
    s.on("data", (c: string) => (buf += c));
    s.on("close", () => (buf ? resolve(JSON.parse(buf.split("\n")[0]!)) : reject(new Error("no reply"))));
    s.on("error", reject);
  });
}

async function wire(op: string, params: Record<string, unknown>, grant: Partial<{ class: string; digest: string | null; approver: string | null }> = {}, facts?: Record<string, string>) {
  const v = await validateOperation({ op, params }, { requestId: "123e4567-e89b-12d3-a456-426614174000", policy: policyWith(), probe: new FakeProbe(), beastPaths: [] });
  const f = v.ok ? v.operation.facts : {};
  return {
    v: 1,
    type: "admin",
    requestId: "123e4567-e89b-12d3-a456-426614174000",
    op,
    opVersion: 1,
    params,
    facts: facts ?? f,
    grant: { class: v.ok ? v.operation.riskClass : "A", issueId: "issue-1", requester: "user-kofi", digest: null, approver: null, ...grant },
  };
}

describe("broker: arbitrary and unknown requests are refused", () => {
  it("has no command execution message of any kind", async () => {
    for (const msg of [
      { v: 1, type: "exec", cmd: "id" },
      { v: 1, type: "shell", command: "id" },
      { v: 1, type: "run", argv: ["/bin/sh", "-c", "id"] },
      { v: 1, type: "admin", op: "shell.exec", command: "id" },
    ]) {
      const r = await raw(msg);
      expect(r.type).toBe("error");
      expect(r.reason).toMatch(/refused/);
    }
    expect(performed).toEqual([]);
  });

  it("refuses malformed input", async () => {
    expect((await raw("not json\n")).type).toBe("error");
    expect((await raw({ v: 2, type: "probe", what: "pm2Apps" })).reason).toMatch(/version/);
  });

  it("refuses spawning any program outside the fixed set", async () => {
    for (const program of ["bash", "sh", "sudo", "/bin/sh", "python3"]) {
      const r = await raw({ v: 1, type: "spawn", program, args: ["-c", "id"], cwd: host.cfg.workspaceRoot + "/app", input: "", env: {}, timeoutMs: 1000, captureFile: false });
      expect(r.reason).toMatch(/program not allowed/);
    }
  });

  it("refuses npm scripts other than the verification scripts, and cwd outside the workspace root", async () => {
    const base = { v: 1, type: "spawn", program: "npm", cwd: host.cfg.workspaceRoot + "/app", input: "", env: {}, timeoutMs: 1000, captureFile: false };
    expect((await raw({ ...base, args: ["exec", "--", "id"] })).reason).toMatch(/npm may only run/);
    expect((await raw({ ...base, args: ["run", "--silent", "deploy"] })).reason).toMatch(/npm may only run/);
    expect((await raw({ ...base, args: ["run", "--silent", "test"], cwd: "/etc" })).reason).toMatch(/workspace root/);
    expect((await raw({ ...base, args: ["run", "--silent", "test"], env: { NODE_OPTIONS: "--require /tmp/x.js" } })).reason).toMatch(/env may only set/);
  });
});

describe("broker: admin operations", () => {
  it("executes an authorized class A operation and redacts its output", async () => {
    const r = await raw(await wire("service.status", { unit: "nginx.service" }));
    expect(r.type).toBe("result");
    expect(r.result!.status).toBe("succeeded");
    expect(r.result!.output).not.toMatch(/ghp_/);
    expect(performed).toEqual(["service.status"]);
  });

  it("denies unknown and disabled operations", async () => {
    expect((await raw(await wire("system.shell", { cmd: "id" }))).result!.reason).toMatch(/unknown_operation/);
    writePolicy(["service.status"]);
    expect((await raw(await wire("pm2.restart", { app: "ideahub-api" }))).result!.reason).toMatch(/operation_disabled/);
    expect(performed).toEqual([]);
  });

  it("denies when the broker's classification differs from the grant", async () => {
    const r = await raw(await wire("pm2.restart", { app: "ideahub-api" }, { class: "A" }));
    expect(r.result!.reason).toMatch(/risk class mismatch/);
    const c = await raw(await wire("service.restart", { unit: "ssh.service" }, { class: "B" }));
    expect(c.result!.reason).toMatch(/risk class mismatch/);
    expect(performed).toEqual([]);
  });

  it("refuses restarting beast-api and beast-executor whatever the grant says", async () => {
    for (const unit of ["beast-api.service", "beast-executor.service"]) {
      const r = await raw(await wire("service.restart", { unit }, { class: "C", digest: "a".repeat(64), approver: "user-kofi" }));
      expect(r.result!.status).toBe("denied");
    }
    expect((await raw(await wire("pm2.restart", { app: "beast-api" }, { class: "B" }))).result!.status).toBe("denied");
    expect(performed).toEqual([]);
  });

  it("class C needs an approval digest and approver, and each digest works once", async () => {
    const t = fs.mkdtempSync(path.join(dir, "chown-"));
    const params = { path: t, owner: "ubuntu", group: "ubuntu", recursive: false };
    expect((await raw(await wire("filesystem.chown", params, { class: "C" }))).reason).toMatch(/approval digest/);
    const approved = await wire("filesystem.chown", params, { class: "C", digest: "b".repeat(64), approver: "user-kofi" });
    expect((await raw(approved)).result!.status).toBe("succeeded");
    expect((await raw(approved)).result!.reason).toMatch(/already been used/);
    expect(performed).toEqual(["filesystem.chown"]);
  });

  it("denies when the target changed since Beast validated it", async () => {
    const t = fs.mkdtempSync(path.join(dir, "chown-"));
    const params = { path: t, owner: "ubuntu", group: "ubuntu", recursive: false };
    const req = await wire("filesystem.chown", params, { class: "C", digest: "c".repeat(64), approver: "user-kofi" });
    const r = await raw({ ...req, facts: { ...req.facts, "path.ino": "1" } });
    expect(r.result!.reason).toMatch(/target changed/);
    expect(performed).toEqual([]);
  });

  it("works end to end through BrokerExecutor with a real grant", async () => {
    const v = await validateOperation({ op: "nginx.test", params: {} }, { requestId: "123e4567-e89b-12d3-a456-426614174001", policy: policyWith(), probe: new FakeProbe(), beastPaths: [] });
    if (!v.ok) throw new Error(v.reason);
    const g = issueGrant({ requesters: ["user-kofi"], approvers: [] }, v.operation, { issueId: "issue-1", requesterId: "user-kofi", beastUserId: null });
    if (!g.ok) throw new Error(g.reason);
    const res = await new BrokerExecutor(client).execute(v.operation, g.grant);
    expect(res.status).toBe("succeeded");
    expect(res.fields).toEqual({ done: "nginx.test" });
  });

  it("a broker that cannot be reached fails the operation, never falls back", async () => {
    const v = await validateOperation({ op: "nginx.test", params: {} }, { requestId: "123e4567-e89b-12d3-a456-426614174002", policy: policyWith(), probe: new FakeProbe(), beastPaths: [] });
    if (!v.ok) throw new Error(v.reason);
    const g = issueGrant({ requesters: ["user-kofi"], approvers: [] }, v.operation, { issueId: "issue-1", requesterId: "user-kofi", beastUserId: null });
    if (!g.ok) throw new Error(g.reason);
    const res = await new BrokerExecutor(new BrokerClient(path.join(dir, "missing.sock"))).execute(v.operation, g.grant);
    expect(res.status).toBe("failed");
  });
});

describe("broker: probes", () => {
  it("answers only the fixed lookups", async () => {
    const probe = new BrokerHostProbe(client);
    expect(await probe.unit("nginx.service")).toMatchObject({ loadState: "loaded" });
    expect(await probe.pm2Apps()).toContainEqual({ name: "ideahub-api", execPath: "/home/ubuntu/apps/ideahub-api/server.js" });
    expect(await probe.userId("ubuntu")).toBe(1000);
    expect((await probe.lstat("/tmp")) as object).toMatchObject({ type: "directory" });
    expect(await probe.lstat("/tmp/../etc")).toBe("denied");
    expect((await raw({ v: 1, type: "probe", what: "unit", name: "x; id" })).reason).toMatch(/invalid unit/);
  });
});

describe("broker: spawning jobs", () => {
  const app = () => host.cfg.workspaceRoot + "/app";
  const runner = () => new BrokerCommandRunner(client, { claude: "claude", codex: "codex", npm: "npm", git: "git" });

  it("runs the agent with a broker-built environment (no Beast secrets)", async () => {
    process.env.LINEAR_API_KEY = "lin_api_should_not_leak";
    try {
      const res = await runner().run("claude", ["0"], { cwd: app(), env: { ...process.env, CI: "true" }, timeoutMs: 10_000 });
      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as { keys: string[]; cwd: string };
      expect(out.keys).toEqual(["CI", "HOME", "LANG", "LOGNAME", "PATH", "SHELL", "USER"]);
      expect(out.cwd).toBe(app());
    } finally {
      delete process.env.LINEAR_API_KEY;
    }
  });

  it("runs git and the verification scripts", async () => {
    const r = runner();
    expect((await r.run("git", ["-C", app(), "rev-parse", "--is-inside-work-tree"], { cwd: app(), timeoutMs: 10_000 })).stdout.trim()).toBe("true");
    expect((await r.run("npm", ["run", "--silent", "test"], { cwd: app(), timeoutMs: 10_000 })).stdout).toMatch(/npm run --silent test/);
  });

  it("returns the capture file contents and removes the file", async () => {
    const res = await runner().run("codex", ["--out", CAPTURE_FILE_TOKEN], { cwd: app(), timeoutMs: 10_000, captureFile: true });
    expect(res.captured).toBe("last message");
    expect(fs.readdirSync(path.join(host.cfg.stateDir, "capture"))).toEqual([]);
  });

  it("refuses programs that are not mapped, without contacting the broker", async () => {
    const res = await runner().run("bash", ["-c", "id"], { cwd: app(), timeoutMs: 1000 });
    expect(res.spawnError).toMatch(/cannot be run through the executor/);
  });

  it("stops the process group when Beast aborts or disconnects", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runner().run("claude", ["60000"], { cwd: app(), timeoutMs: 120_000, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    const res = await pending;
    expect(res.aborted).toBe(true);
    expect(res.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("enforces the timeout broker-side", async () => {
    const req: SpawnRequest = { v: 1, type: "spawn", program: "claude", args: ["60000"], cwd: app(), input: "", env: {}, timeoutMs: 300, captureFile: false };
    const exit = await client.spawn(req, () => undefined);
    expect(exit.timedOut).toBe(true);
  });
});

describe("static safety of the executor", () => {
  const srcDir = path.resolve(import.meta.dirname, "../src/executor");
  const sources = fs.readdirSync(srcDir).map((f) => [f, fs.readFileSync(path.join(srcDir, f), "utf8")] as const);

  it("starts processes only through proc.ts, never with a shell", () => {
    for (const [file, src] of sources) {
      expect(src, file).not.toMatch(/shell:\s*true|execSync|spawnSync|execFile|(?<![.\w])exec\(/);
      if (file !== "proc.ts") expect(src, file).not.toMatch(/node:child_process/);
    }
  });

  it("names no shell or privilege-escalation binary (the agent's SHELL variable aside)", () => {
    for (const [file, src] of sources) {
      const code = src.split("\n").filter((l) => !/^\s*SHELL: "\/bin\/bash",$/.test(l)).join("\n");
      expect(code, file).not.toMatch(/"\/bin\/(ba)?sh"|"\/usr\/bin\/sudo"|"sudo"|"\/bin\/su"|pkexec/);
    }
  });
});
