import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueGrant } from "../src/admin/authorize.js";
import { BrokerExecutor } from "../src/admin/executor.js";
import { BrokerHostProbe } from "../src/admin/probe.js";
import { brokerRequestProblem } from "../src/admin/protocol.js";
import { operationIds } from "../src/admin/registry.js";
import { validateOperation, type ValidationContext } from "../src/admin/validate.js";
import { silentLogger } from "../src/logger.js";
import { Broker } from "../src/executor/broker.js";
import { BrokerClient } from "../src/executor/client.js";
import type { BrokerConfig } from "../src/executor/config.js";
import { readHistory } from "../src/executor/deploy.js";
import { parseDeployments } from "../src/executor/deployments.js";
import { BrokerHost, type Account } from "../src/executor/host.js";
import type { LinearIssue } from "../src/linear/types.js";
import { APPROVER, FakeProbe, REQUESTER, adminIssue, commentBody, makeAdminHarness, policyWith, type AdminHarness } from "./admin-helpers.js";
import { makeTmpDir, removeTmpDir, sign, webhookBody } from "./helpers.js";

const SHA_A = "a".repeat(40);
const SHA_C = "c".repeat(40);

describe("deploy operations: validation (Beast API side)", () => {
  let root: string;
  let probe: FakeProbe;
  let ctx: ValidationContext;
  beforeEach(() => {
    root = makeTmpDir();
    probe = new FakeProbe();
    ctx = { requestId: "req-1", policy: policyWith(), probe, beastPaths: [path.join(root, "beast")] };
  });
  afterEach(() => removeTmpDir(root));
  const validate = (op: string, params: unknown) => validateOperation({ op, params }, ctx);

  it("deploy.run is always class C and binds the target's facts and the exact commit", async () => {
    const v = await validate("deploy.run", { target: "test-app", commit: SHA_C });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.operation.riskClass).toBe("C");
    expect(v.operation.facts).toMatchObject({ "deploy.commit": SHA_C, "target.currentCommit": SHA_A, "deployment.definitionHash": "d".repeat(64) });
  });

  it("deploy.rollback is class C and deploy.status is class A", async () => {
    const rb = await validate("deploy.rollback", { target: "test-app" });
    const st = await validate("deploy.status", { target: "test-app" });
    expect(rb.ok && rb.operation.riskClass).toBe("C");
    expect(st.ok && st.operation.riskClass).toBe("A");
  });

  it("denies unknown targets", async () => {
    const v = await validate("deploy.run", { target: "banging-prices", commit: SHA_C });
    expect(v).toMatchObject({ ok: false, code: "unsupported_target" });
  });

  it("denies when the executor cannot inspect the target (uncertain means deny)", async () => {
    probe.deployments["test-app"] = null;
    expect(await validate("deploy.run", { target: "test-app", commit: SHA_C })).toMatchObject({ ok: false, code: "uncertain" });
  });

  it.each([
    [{ target: "test-app", commit: "main" }, "invalid_params"],
    [{ target: "test-app", commit: "abc1234" }, "invalid_params"],
    [{ target: "test-app", commit: SHA_C.toUpperCase() }, "invalid_params"],
    [{ target: "test-app", commit: "HEAD~1" }, "shell_syntax"],
    [{ target: "test-app", commit: `${SHA_C};rm -rf /` }, "shell_syntax"],
    [{ target: "test-app", commit: "$(reboot)" }, "shell_syntax"],
    [{ target: "test-app; reboot", commit: SHA_C }, "shell_syntax"],
    [{ target: "test-app`id`", commit: SHA_C }, "shell_syntax"],
    [{ target: "--upload-pack=evil", commit: SHA_C }, "invalid_params"],
    [{ target: "../etc", commit: SHA_C }, "invalid_params"],
    [{ target: "Test-App", commit: SHA_C }, "invalid_params"],
    [{ target: "test-app", commit: 1234 }, "invalid_params"],
    [{ target: "test-app" }, "invalid_params"],
    [{ target: "test-app", commit: SHA_C, command: "npm run deploy" }, "invalid_params"],
    [{ target: "test-app", commit: SHA_C, script: "build" }, "invalid_params"],
  ])("rejects malformed or injected input %j before the executor is asked", async (params, code) => {
    const v = await validate("deploy.run", params);
    expect(v).toMatchObject({ ok: false, code });
    expect(probe.deploymentQueries).toHaveLength(0);
  });

  it("denies deploy operations that are not enabled in the policy", async () => {
    ctx = { ...ctx, policy: policyWith(operationIds().filter((o) => !o.startsWith("deploy."))) };
    expect(await validate("deploy.run", { target: "test-app", commit: SHA_C })).toMatchObject({ ok: false, code: "operation_disabled" });
  });
});

describe("deploy operations: approval flow", () => {
  let h: AdminHarness;
  afterEach(async () => {
    await h?.admin.idle();
    removeTmpDir(h.root);
  });

  function post(body: string) {
    return request(h.app)
      .post("/webhooks/linear")
      .set("Content-Type", "application/json")
      .set({ "Linear-Signature": sign(body), "Linear-Delivery": randomUUID() })
      .send(body);
  }
  async function requestAdmin(issue: LinearIssue) {
    h.linear.issues[issue.id] = issue;
    h.linear.labelAdders[`${issue.id}:label-admin`] = REQUESTER;
    await post(webhookBody(issue));
    await h.admin.idle();
  }
  let seq = 0;
  async function comment(issueId: string, body: string) {
    const id = `deploy-comment-${++seq}`;
    h.linear.apiComments[id] = { id, body, issueId, userId: APPROVER, edited: false };
    await post(commentBody({ id, body, issueId }));
    await h.admin.idle();
  }
  const lastJob = () => h.store.listAdminJobs().at(-1)!;

  it("never deploys without an approval: the plan waits, then expires", async () => {
    h = makeAdminHarness();
    const issue = adminIssue("deploy.run", { target: "test-app", commit: SHA_C });
    await requestAdmin(issue);
    expect(lastJob()).toMatchObject({ state: "awaiting_approval", riskClass: "C" });
    expect(h.executor.executed).toHaveLength(0);
    const plan = h.linear.comments.find((c) => c.body.includes("Approval required"))!.body;
    expect(plan).toContain(SHA_C);
    expect(plan).toContain("target.currentCommit");

    h.clock.now += 16 * 60 * 1000;
    await h.admin.sweepExpired();
    expect(lastJob().state).toBe("expired");
    expect(h.executor.executed).toHaveLength(0);
  });

  it("runs exactly the approved deployment once, and a wrong digest approves nothing", async () => {
    h = makeAdminHarness();
    const issue = adminIssue("deploy.run", { target: "test-app", commit: SHA_C });
    await requestAdmin(issue);
    await comment(issue.id, `/beast approve ${"0".repeat(64)}`);
    expect(h.executor.executed).toHaveLength(0);

    await comment(issue.id, `/beast approve ${lastJob().digest}`);
    expect(h.executor.executed).toHaveLength(1);
    expect(h.executor.executed[0]!.op.params).toEqual({ target: "test-app", commit: SHA_C });
    expect(h.executor.executed[0]!.grant).toMatchObject({ riskClass: "C", digest: lastJob().digest });
    expect(lastJob().state).toBe("succeeded");
  });

  it("voids the approval when the deployed commit changed after the plan", async () => {
    h = makeAdminHarness();
    const issue = adminIssue("deploy.run", { target: "test-app", commit: SHA_C });
    await requestAdmin(issue);
    h.probe.deployments["test-app"]!.currentCommit = "e".repeat(40);
    await comment(issue.id, `/beast approve ${lastJob().digest}`);
    expect(h.executor.executed).toHaveLength(0);
    expect(lastJob().reason).toMatch(/changed since approval/);
  });
});

describe("deployment definitions (root-owned executor file)", () => {
  const limits = { workspaceRoot: "/home/ubuntu/projects", deployRoots: ["/home/ubuntu/apps"], beastPaths: ["/home/ubuntu/apps/beast-api"] };
  const valid = () => ({
    id: "demo",
    project: "Demo",
    production: false,
    mechanism: "pm2-git",
    source: { workspace: "/home/ubuntu/projects/demo", branch: "main" },
    target: { checkout: "/home/ubuntu/apps/demo", pm2App: "demo" },
    install: "npm-ci",
    preDeploy: ["test"],
    build: ["build"],
    health: { url: "http://127.0.0.1:3199/health", expectStatus: 200, attempts: 5, intervalMs: 1000 },
    rollback: "previous-commit",
  });
  const parse = (def: unknown) => () => parseDeployments({ version: 1, deployments: [def] }, limits);

  it("accepts a well-formed definition", () => {
    expect(parse(valid())().deployments[0]!.id).toBe("demo");
  });

  it.each([
    ["an unknown key (command)", { ...valid(), command: "bash deploy.sh" }],
    ["an unknown mechanism", { ...valid(), mechanism: "shell" }],
    ["a non-loopback health URL", { ...valid(), health: { ...valid().health, url: "http://example.com/health" } }],
    ["a health URL with a query", { ...valid(), health: { ...valid().health, url: "http://127.0.0.1:3199/h?x=1" } }],
    ["a script with shell syntax", { ...valid(), build: ["build && curl x"] }],
    ["a script starting with -", { ...valid(), build: ["--prefix=/"] }],
    ["a checkout outside the deploy roots", { ...valid(), target: { checkout: "/var/www/demo", pm2App: "demo" } }],
    ["Beast's own checkout", { ...valid(), target: { checkout: "/home/ubuntu/apps/beast-api", pm2App: "demo" } }],
    ["a checkout covering Beast", { ...valid(), target: { checkout: "/home/ubuntu/apps", pm2App: "demo" } }],
    ["a source outside the workspace root", { ...valid(), source: { workspace: "/home/ubuntu/apps/demo", branch: "main" } }],
    ["a non-canonical source", { ...valid(), source: { workspace: "/home/ubuntu/projects/../apps/demo", branch: "main" } }],
    ["a branch with ..", { ...valid(), source: { workspace: "/home/ubuntu/projects/demo", branch: "main..x" } }],
    ["Beast's own PM2 app", { ...valid(), target: { checkout: "/home/ubuntu/apps/demo", pm2App: "beast-api" } }],
    ["PM2 'all'", { ...valid(), target: { checkout: "/home/ubuntu/apps/demo", pm2App: "all" } }],
  ])("rejects %s", (_name, def) => {
    expect(parse(def)).toThrow();
  });

  it("rejects duplicate ids and checkouts", () => {
    expect(() => parseDeployments({ version: 1, deployments: [valid(), valid()] }, limits)).toThrow(/duplicate/);
  });
});

describe("deployment probe wire format", () => {
  const ROOT = "/home/ubuntu/projects";
  it.each([
    [{ v: 1, type: "probe", what: "deployment", op: "deploy.run", target: "demo", commit: SHA_C }, undefined],
    [{ v: 1, type: "probe", what: "deployment", op: "deploy.status", target: "demo" }, undefined],
    [{ v: 1, type: "probe", what: "deployment", op: "deploy.run", target: "demo" }, "invalid commit"],
    [{ v: 1, type: "probe", what: "deployment", op: "deploy.status", target: "demo", commit: SHA_C }, "invalid commit"],
    [{ v: 1, type: "probe", what: "deployment", op: "deploy.run", target: "demo", commit: "main; reboot" }, "invalid commit"],
    [{ v: 1, type: "probe", what: "deployment", op: "shell", target: "demo" }, "invalid deployment op"],
    [{ v: 1, type: "probe", what: "deployment", op: "deploy.status", target: "../x" }, "invalid deployment target"],
    [{ v: 1, type: "probe", what: "deployment", op: "deploy.status", target: "demo", cmd: "id" }, "unknown fields"],
  ])("%j -> %s", (msg, problem) => {
    expect(brokerRequestProblem(msg, ROOT)).toBe(problem);
  });
});

/**
 * Real deployments through the broker socket: real Git repositories, real npm scripts,
 * a fake PM2 binary and a local health endpoint. Only account switching is faked (every
 * step runs as the current user instead of beast-agent / the PM2 owner).
 */
describe("deployment through the broker (end to end)", () => {
  class DeployHost extends BrokerHost {
    override async account(name: string): Promise<Account | null> {
      return { name, uid: process.getuid!(), gid: process.getgid!(), home: os.homedir() };
    }
    override dropTo(_a: Account, file: string, args: readonly string[]): [string, string[]] {
      return [file, [...args]];
    }
  }

  let dir: string;
  let src: string;
  let checkout: string;
  let restarts: string;
  let server: net.Server;
  let health: http.Server;
  let client: BrokerClient;
  let host: DeployHost;
  const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
  const sh = (cwd: string, args: string[]) => execFileSync("git", [...GIT, "-C", cwd, ...args], { encoding: "utf8" }).trim();

  function commit(files: Record<string, string>, branch = "main"): string {
    if (sh(src, ["symbolic-ref", "--short", "HEAD"]) !== branch) sh(src, ["checkout", "-q", branch]);
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(src, f), c);
    sh(src, ["add", "-A"]);
    sh(src, ["commit", "-q", "-m", `change ${Object.keys(files).join(",")}`]);
    return sh(src, ["rev-parse", "HEAD"]);
  }

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bdeploy")));
    const projects = path.join(dir, "projects");
    const apps = path.join(dir, "apps");
    src = path.join(projects, "demo");
    checkout = path.join(apps, "demo");
    restarts = path.join(dir, "restarts.log");
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(apps);
    execFileSync("git", ["init", "-q", "-b", "main", src]);
    fs.writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({ name: "demo", private: true, scripts: { test: "node -e \"process.exit(require('fs').existsSync('FAIL')?1:0)\"", build: "node -e \"require('fs').writeFileSync('built.txt','yes')\"" } }),
    );
    fs.writeFileSync(path.join(src, ".gitignore"), "built.txt\n");
    commit({ "health.txt": "ok" });
    execFileSync("git", ["clone", "-q", src, checkout]);

    health = http.createServer((_req, res) => {
      const ok = fs.readFileSync(path.join(checkout, "health.txt"), "utf8").trim() === "ok";
      res.writeHead(ok ? 200 : 503).end();
    });
    await new Promise<void>((r) => health.listen(0, "127.0.0.1", r));
    const port = (health.address() as net.AddressInfo).port;

    const pm2 = path.join(dir, "fake-pm2");
    fs.writeFileSync(
      pm2,
      `#!/usr/bin/env node
const fs = require("node:fs");
const [cmd, app] = process.argv.slice(2);
if (cmd === "jlist") process.stdout.write(JSON.stringify([{ name: "demo", pid: 4242, pm2_env: { status: "online", pm_cwd: ${JSON.stringify(checkout)}, pm_exec_path: "server.js", restart_time: 0 } }]));
else if (cmd === "restart" && app === "demo") fs.appendFileSync(${JSON.stringify(restarts)}, "restart\\n");
else process.exit(1);
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(dir, "deployments.json"),
      JSON.stringify({
        version: 1,
        deployments: [
          {
            id: "demo",
            project: "Demo",
            production: false,
            mechanism: "pm2-git",
            source: { workspace: src, branch: "main" },
            target: { checkout, pm2App: "demo" },
            install: "none",
            preDeploy: ["test"],
            build: ["build"],
            health: { url: `http://127.0.0.1:${port}/health`, expectStatus: 200, attempts: 2, intervalMs: 250 },
            rollback: "previous-commit",
          },
        ],
      }),
    );
    fs.writeFileSync(path.join(dir, "policy.json"), JSON.stringify({ version: 1, enabledOperations: operationIds() }));
    const cfg: BrokerConfig = {
      policyFile: path.join(dir, "policy.json"),
      deploymentsFile: path.join(dir, "deployments.json"),
      deployRoots: [apps],
      stateDir: path.join(dir, "state"),
      workspaceRoot: projects,
      agentUser: "beast-agent",
      pm2User: "ubuntu",
      programs: { claude: "/bin/false", codex: "/bin/false", npm: "/usr/bin/npm", git: "/usr/bin/git" },
      bins: { setpriv: "/usr/bin/setpriv", systemctl: "/bin/false", journalctl: "/bin/false", nginx: "/bin/false", dpkgQuery: "/bin/false", getent: "/usr/bin/getent", pm2, tail: "/usr/bin/tail", rm: "/usr/bin/rm" },
      nginxLogs: { access: "/nonexistent", error: "/nonexistent" },
      beastPaths: ["/home/ubuntu/apps/beast-api"],
    };
    fs.mkdirSync(cfg.stateDir);
    host = new DeployHost(cfg);
    const sock = path.join(dir, "s.sock");
    const broker = new Broker({ host, logger: silentLogger });
    server = net.createServer((s) => broker.handle(s));
    await new Promise<void>((r) => server.listen(sock, r));
    client = new BrokerClient(sock, 60_000);
  });

  afterEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (health) await new Promise((r) => health.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const auth = { requesters: [REQUESTER], approvers: [APPROVER] };
  const restartCount = () => (fs.existsSync(restarts) ? fs.readFileSync(restarts, "utf8").split("\n").filter(Boolean).length : 0);
  const head = () => sh(checkout, ["rev-parse", "HEAD"]);

  /** Validate through the broker's probe (as Beast API does), then execute with a class C grant. */
  async function run(op: string, params: Record<string, unknown>) {
    const v = await validateOperation({ op, params }, { requestId: randomUUID(), policy: policyWith(), probe: new BrokerHostProbe(client), beastPaths: [] });
    if (!v.ok) return { validation: v };
    const g = issueGrant(auth, v.operation, {
      issueId: "issue-1",
      requesterId: REQUESTER,
      ...(v.operation.riskClass === "C" ? { approval: { digest: randomUUID().replaceAll("-", "").padEnd(64, "0"), approverId: APPROVER } } : {}),
      beastUserId: "beast-bot",
    });
    if (!g.ok) throw new Error(g.reason);
    return { validation: v, result: await new BrokerExecutor(client).execute(v.operation, g.grant) };
  }

  it("deploys an approved commit: verified, checked out, built, restarted and healthy", async () => {
    const before = head();
    const c2 = commit({ "feature.txt": "new" });
    const { result } = await run("deploy.run", { target: "demo", commit: c2 });
    expect(result).toMatchObject({ status: "succeeded", fields: { deployed: true, deployedCommit: c2, previousCommit: before, healthStatus: 200 } });
    expect(head()).toBe(c2);
    expect(fs.readFileSync(path.join(checkout, "built.txt"), "utf8")).toBe("yes");
    expect(restartCount()).toBe(1);
    expect(readHistory(host, "demo").at(-1)).toMatchObject({ op: "deploy.run", commit: c2, previous: before, status: "succeeded" });

    const status = await run("deploy.status", { target: "demo" });
    expect(status.result).toMatchObject({ status: "succeeded", fields: { deployedCommit: c2, healthy: true, pm2Status: "online" } });
  });

  it("leaves production untouched when pre-deployment verification fails", async () => {
    const before = head();
    const bad = commit({ FAIL: "1" });
    const { result } = await run("deploy.run", { target: "demo", commit: bad });
    expect(result).toMatchObject({ status: "failed", fields: { stage: "pre-deploy", deployed: false } });
    expect(result!.output).toMatch(/FAIL\s+pre-deploy: npm run test/);
    expect(head()).toBe(before);
    expect(restartCount()).toBe(0);
  });

  it("rolls back automatically when the health check fails", async () => {
    const before = head();
    const broken = commit({ "health.txt": "broken" });
    const { result } = await run("deploy.run", { target: "demo", commit: broken });
    expect(result).toMatchObject({ status: "failed", fields: { rolledBack: true, rollbackHealthy: true, deployedCommit: before } });
    expect(head()).toBe(before);
    expect(restartCount()).toBe(2);
  });

  it("supports an approved explicit rollback to the commit before Beast's last deployment", async () => {
    const before = head();
    const c2 = commit({ "feature.txt": "new" });
    await run("deploy.run", { target: "demo", commit: c2 });
    const rb = await run("deploy.rollback", { target: "demo" });
    expect(rb.validation.ok && rb.validation.operation.facts["rollback.toCommit"]).toBe(before);
    expect(rb.result).toMatchObject({ status: "succeeded", fields: { fromCommit: c2, toCommit: before } });
    expect(head()).toBe(before);
    // Nothing further to roll back to.
    expect((await run("deploy.rollback", { target: "demo" })).validation).toMatchObject({ ok: false, code: "unsupported_target" });
  });

  it("refuses commits that are not on the deploy branch, not fast-forwards, unknown, or already deployed", async () => {
    sh(src, ["checkout", "-q", "-b", "feature"]);
    const side = commit({ "side.txt": "x" }, "feature");
    expect((await run("deploy.run", { target: "demo", commit: side })).validation).toMatchObject({ ok: false, reason: expect.stringMatching(/not on branch main/) });
    expect((await run("deploy.run", { target: "demo", commit: "f".repeat(40) })).validation).toMatchObject({ ok: false, reason: expect.stringMatching(/does not exist/) });
    expect((await run("deploy.run", { target: "demo", commit: head() })).validation).toMatchObject({ ok: false, reason: expect.stringMatching(/already deployed/) });
    expect((await run("deploy.run", { target: "nope", commit: side })).validation).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown deployment target/) });
    expect(restartCount()).toBe(0);
  });

  it("refuses to deploy over local changes in the production checkout", async () => {
    const c2 = commit({ "feature.txt": "new" });
    fs.writeFileSync(path.join(checkout, "health.txt"), "edited locally");
    expect((await run("deploy.run", { target: "demo", commit: c2 })).validation).toMatchObject({ ok: false, reason: expect.stringMatching(/modified tracked files/) });
  });

  it("the broker refuses a deployment whose target moved after Beast validated it", async () => {
    const c2 = commit({ "feature.txt": "new" });
    const v = await validateOperation({ op: "deploy.run", params: { target: "demo", commit: c2 } }, { requestId: randomUUID(), policy: policyWith(), probe: new BrokerHostProbe(client), beastPaths: [] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const c3 = commit({ "other.txt": "x" });
    execFileSync("git", ["-C", checkout, "pull", "-q", "--ff-only", src, "main"]);
    expect(head()).toBe(c3);
    const g = issueGrant(auth, v.operation, { issueId: "issue-1", requesterId: REQUESTER, approval: { digest: "1".repeat(64), approverId: APPROVER }, beastUserId: "beast-bot" });
    const res = await new BrokerExecutor(client).execute(v.operation, (g as Extract<typeof g, { ok: true }>).grant);
    expect(res.status).toBe("denied");
    expect(restartCount()).toBe(0);
  });
});
