import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueGrant } from "../src/admin/authorize.js";
import { DisabledExecutor, DryRunExecutor, executionProblem } from "../src/admin/executor.js";
import { agentSpawnProblem, toWireRequest } from "../src/admin/protocol.js";
import { MAX_OUTPUT_BYTES, sanitizeResult } from "../src/admin/result.js";
import { validateOperation, type ValidatedOperation } from "../src/admin/validate.js";
import { loadConfig } from "../src/config.js";
import { FakeExecutor, FakeProbe, policyWith } from "./admin-helpers.js";
import { makeTmpDir, removeTmpDir } from "./helpers.js";

const auth = { requesters: ["req"], approvers: ["appr"] };
let root: string;
beforeEach(() => (root = makeTmpDir()));
afterEach(() => removeTmpDir(root));

async function op(name: string, params: Record<string, unknown>, requestId = "r1"): Promise<ValidatedOperation> {
  const res = await validateOperation({ op: name, params }, { requestId, policy: policyWith(), probe: new FakeProbe(), beastPaths: [] });
  if (!res.ok) throw new Error(res.reason);
  return res.operation;
}

function grantFor(o: ValidatedOperation, approval?: { digest: string; approverId: string }) {
  const res = issueGrant(auth, o, { issueId: "i1", requesterId: "req", approval, beastUserId: "bot" });
  if (!res.ok) throw new Error(res.reason);
  return res.grant;
}

describe("executor interface", () => {
  it("the disabled executor refuses everything", async () => {
    const o = await op("nginx.test", {});
    const res = await new DisabledExecutor().execute(o, grantFor(o));
    expect(res).toMatchObject({ status: "denied", op: "nginx.test" });
  });

  it("the dry-run executor describes the action and performs nothing", async () => {
    const o = await op("pm2.restart", { app: "ideahub-api" });
    const res = await new DryRunExecutor().execute(o, grantFor(o));
    expect(res).toMatchObject({ status: "dry_run", fields: { mode: "dry-run", plannedAction: "restart PM2 app ideahub-api" } });
  });

  it("refuses operations that were not validated, forged grants and mismatched pairs", async () => {
    const executor = new FakeExecutor();
    const a = await op("nginx.test", {}, "r1");
    const b = await op("nginx.reload", {}, "r2");
    const lookAlike = { ...a } as ValidatedOperation;
    expect((await executor.execute(lookAlike, grantFor(a))).status).toBe("denied");
    expect((await executor.execute(a, { ...grantFor(a) })).status).toBe("denied");
    expect((await executor.execute(a, grantFor(b))).status).toBe("denied");
    expect(executor.executed).toHaveLength(0);
    expect((await executor.execute(a, grantFor(a))).status).toBe("succeeded");
  });

  it("cannot grant class C without an approval, or an approval to class A/B", async () => {
    const dir = path.join(root, "d");
    fs.mkdirSync(dir);
    const c = await op("filesystem.chown", { path: dir, owner: "ubuntu", group: "ubuntu", recursive: false });
    expect(issueGrant(auth, c, { issueId: "i1", requesterId: "req", beastUserId: "bot" }).ok).toBe(false);
    expect(issueGrant(auth, c, { issueId: "i1", requesterId: "req", approval: { digest: "x", approverId: "appr" }, beastUserId: "bot" }).ok).toBe(false);
    expect(issueGrant(auth, c, { issueId: "i1", requesterId: "req", approval: { digest: "a".repeat(64), approverId: "bot" }, beastUserId: "bot" }).ok).toBe(false);
    expect(issueGrant(auth, c, { issueId: "i1", requesterId: "nobody", approval: { digest: "a".repeat(64), approverId: "appr" }, beastUserId: "bot" }).ok).toBe(false);
    const a = await op("nginx.test", {});
    expect(issueGrant(auth, a, { issueId: "i1", requesterId: "req", approval: { digest: "a".repeat(64), approverId: "appr" }, beastUserId: "bot" }).ok).toBe(false);
    expect(executionProblem(c, grantFor(c, { digest: "a".repeat(64), approverId: "appr" }))).toBeUndefined();
  });

  it("turns executor exceptions into a failed result instead of escalating or retrying", async () => {
    const executor = new FakeExecutor();
    let calls = 0;
    executor.behaviour = () => {
      calls++;
      throw new Error("permission denied, falling back to sudo?");
    };
    const o = await op("nginx.reload", {});
    const res = await executor.execute(o, grantFor(o));
    expect(res.status).toBe("failed");
    expect(calls).toBe(1);
  });

  it("the wire request carries typed fields only, never a command", async () => {
    const o = await op("pm2.restart", { app: "ideahub-api" });
    const wire = toWireRequest(o, grantFor(o));
    expect(Object.keys(wire).sort()).toEqual(["facts", "grant", "op", "opVersion", "params", "requestId", "v"]);
    expect(JSON.stringify(wire)).not.toMatch(/"(cmd|command|argv|args|shell)"/);
  });

  it("validates agent.spawn requests structurally", () => {
    const ok = { v: 1, jobId: "123e4567-e89b-12d3-a456-426614174000", kind: "agent", adapter: "claude", workspace: "/home/ubuntu/projects/app" };
    expect(agentSpawnProblem(ok, "/home/ubuntu/projects")).toBeUndefined();
    expect(agentSpawnProblem({ ...ok, kind: "verify", script: "test" }, "/home/ubuntu/projects")).toBeUndefined();
    expect(agentSpawnProblem({ ...ok, adapter: "bash" }, "/home/ubuntu/projects")).toBeDefined();
    expect(agentSpawnProblem({ ...ok, workspace: "/etc" }, "/home/ubuntu/projects")).toBeDefined();
    expect(agentSpawnProblem({ ...ok, workspace: "/home/ubuntu/projects/../x" }, "/home/ubuntu/projects")).toBeDefined();
    expect(agentSpawnProblem({ ...ok, kind: "verify", script: "deploy" }, "/home/ubuntu/projects")).toBeDefined();
    expect(agentSpawnProblem({ ...ok, command: "id" }, "/home/ubuntu/projects")).toBeDefined();
  });
});

describe("result handling", () => {
  it("bounds output, drops non-scalar fields and unknown statuses", async () => {
    const o = await op("system.logs", { app: "ideahub-api", lines: 500 });
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i} ${"x".repeat(50)}`).join("\n");
    const res = sanitizeResult({ status: "exploded", output: big, fields: { ok: 1, obj: { a: 1 }, "bad key": "x", fn: () => 1 } }, o, Date.now());
    expect(res.status).toBe("failed");
    expect(Buffer.byteLength(res.output!)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(res.output!.split("\n").length).toBeLessThanOrEqual(500);
    expect(res.fields).toEqual({ ok: 1 });
  });

  it("withholds output when redaction fails (fail closed)", async () => {
    const o = await op("system.logs", { app: "ideahub-api", lines: 10 });
    const res = sanitizeResult({ status: "succeeded", output: "secret stuff", fields: { a: "b" } }, o, Date.now(), () => {
      throw new Error("redactor broke");
    });
    expect(res.output).toBeUndefined();
    expect(res.fields).toEqual({});
    expect(res.reason).toMatch(/redaction failed/);
  });
});

describe("admin configuration", () => {
  it("is off by default and refuses enforce in this phase", () => {
    expect(loadConfig({}).adminMode).toBe("off");
    expect(loadConfig({ BEAST_ADMIN_MODE: "dry-run" }).adminMode).toBe("dry-run");
    expect(() => loadConfig({ BEAST_ADMIN_MODE: "enforce" })).toThrow(/not available/);
    expect(() => loadConfig({ BEAST_ADMIN_MODE: "root" })).toThrow();
  });

  it("accepts only Linear user ID lists for requesters and approvers", () => {
    expect(loadConfig({ BEAST_ADMIN_REQUESTERS: "a-1, b-2" }).adminRequesters).toEqual(["a-1", "b-2"]);
    expect(() => loadConfig({ BEAST_ADMIN_APPROVERS: "a;rm -rf /" })).toThrow();
  });
});

describe("static safety of the admin module", () => {
  const dir = path.resolve(import.meta.dirname, "../src/admin");
  const sources = fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")] as const);

  it("never imports child_process, enables a shell or calls sudo/su", () => {
    for (const [file, src] of sources) {
      expect(src, file).not.toMatch(/node:child_process|from "child_process"/);
      expect(src, file).not.toMatch(/shell:\s*true|execSync|spawnSync|(?<![.\w])exec\(/);
      expect(src, file).not.toMatch(/runCommand\(\s*"(sudo|su|bash|sh)"/);
      expect(src, file).not.toMatch(/execRoot|runAsRoot/);
    }
  });

  it("only the read-only probe runs host commands", () => {
    const runners = sources.filter(([, src]) => src.includes("runCommand(")).map(([f]) => f);
    expect(runners).toEqual(["probe.ts"]);
  });
});
