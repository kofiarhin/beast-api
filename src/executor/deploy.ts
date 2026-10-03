import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lstatPath, type DeploymentProbe, type DeploymentQuery } from "../admin/probe.js";
import type { ValidatedOperation } from "../admin/validate.js";
import { SAFE_PATH } from "./config.js";
import { definitionFacts, loadDeployments, type DeploymentDefinition } from "./deployments.js";
import type { Account, BrokerHost } from "./host.js";
import type { RawResult } from "./operations.js";
import { runProc, type ProcResult } from "./proc.js";

/**
 * Production deployment (IDE-82), executed by the root broker. Root itself runs no
 * deployment step: Git, npm and PM2 run through setpriv (no capabilities, no-new-privs)
 *
 * - as the agent user for everything that touches the source workspace (which agents can
 *   write), including pre-deployment verification in an isolated clone of the exact commit;
 * - as the PM2 owner (the account that already runs the app) in the production checkout.
 *
 * Every step is a fixed program with a fixed argument vector built from the root-owned
 * definition and the approved commit id. There is no shell and no command string.
 */
const GIT_TIMEOUT_MS = 2 * 60_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const SCRIPT_TIMEOUT_MS = 20 * 60_000;
const RESTART_TIMEOUT_MS = 2 * 60_000;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;
const MAX_HISTORY = 50;
/** Git must never run repository-configured programs (fsmonitor, hooks) during a deployment. */
const GIT_SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

type Failure = { ok: false; code: "unsupported_target" | "uncertain"; reason: string };

interface Context {
  def: DeploymentDefinition;
  /** PM2 owner: runs Git, npm and PM2 in the production checkout. */
  deployer: Account;
  /** Agent user: reads the source workspace and runs pre-deployment verification. */
  agent: Account;
}

export interface DeploymentRecord {
  requestId: string;
  op: "deploy.run" | "deploy.rollback";
  commit: string;
  previous: string;
  status: "succeeded" | "failed";
  rolledBack: boolean;
  at: string;
}

const unsupported = (reason: string): Failure => ({ ok: false, code: "unsupported_target", reason });
const uncertain = (reason: string): Failure => ({ ok: false, code: "uncertain", reason });
const succeeded = (r: ProcResult) => r.exitCode === 0 && !r.timedOut && !r.spawnError;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runAs(host: BrokerHost, account: Account, cwd: string, file: string, args: string[], timeoutMs: number): Promise<ProcResult> {
  const [bin, argv] = host.dropTo(account, file, args);
  return runProc(bin, argv, {
    cwd,
    env: {
      HOME: account.home,
      USER: account.name,
      LOGNAME: account.name,
      PATH: SAFE_PATH,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      CI: "true",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      npm_config_update_notifier: "false",
    },
    timeoutMs,
    maxOutputChars: 16_000,
  });
}

function git(host: BrokerHost, account: Account, dir: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<ProcResult> {
  return runAs(host, account, dir, host.cfg.programs.git, [...GIT_SAFE, "-C", dir, ...args], timeoutMs);
}

/** Every component must exist and none may be a symlink; returns the leaf, or a reason. */
async function walk(p: string): Promise<{ uid: number; type: string } | string> {
  let current = "";
  let leaf: { uid: number; type: string } | undefined;
  for (const part of p.slice(1).split("/")) {
    current += "/" + part;
    const st = await lstatPath(current);
    if (st === "missing") return `${current} does not exist`;
    if (st === "denied") return `${current} cannot be inspected`;
    if (st.type === "symlink") return `${current} is a symlink`;
    leaf = st;
  }
  return leaf ?? "empty path";
}

async function resolve(host: BrokerHost, target: string): Promise<{ ok: true; ctx: Context } | Failure> {
  const cfg = host.cfg;
  const load = loadDeployments(cfg.deploymentsFile, { workspaceRoot: cfg.workspaceRoot, deployRoots: cfg.deployRoots, beastPaths: cfg.beastPaths });
  if (!load.ok) return uncertain(load.error);
  const def = load.file.deployments.find((d) => d.id === target);
  if (!def) return unsupported(`unknown deployment target ${target}`);
  const deployer = await host.account(cfg.pm2User);
  const agent = await host.account(cfg.agentUser);
  if (!deployer || !agent) return uncertain("deployment accounts are not available");

  const checkout = await walk(def.target.checkout);
  if (typeof checkout === "string") return unsupported(`checkout: ${checkout}`);
  if (checkout.type !== "directory" || checkout.uid !== deployer.uid) return unsupported(`checkout ${def.target.checkout} must be a directory owned by ${deployer.name}`);
  const source = await walk(def.source.workspace);
  if (typeof source === "string") return unsupported(`source: ${source}`);
  if (source.type !== "directory") return unsupported(`source ${def.source.workspace} is not a directory`);
  return { ok: true, ctx: { def, deployer, agent } };
}

/** Live checkout state: the root of a Git repo, clean tracked files, and run by the named PM2 app. */
async function targetState(host: BrokerHost, ctx: Context): Promise<{ ok: true; head: string } | Failure> {
  const dir = ctx.def.target.checkout;
  const top = await git(host, ctx.deployer, dir, ["rev-parse", "--show-toplevel"]);
  if (!succeeded(top) || top.stdout.trim() !== dir) return unsupported(`${dir} is not the root of a Git checkout`);
  const head = await git(host, ctx.deployer, dir, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!succeeded(head)) return uncertain(`could not read the deployed commit of ${dir}`);
  const status = await git(host, ctx.deployer, dir, ["status", "--porcelain", "--untracked-files=no"]);
  if (!succeeded(status)) return uncertain(`could not read the Git status of ${dir}`);
  if (status.stdout.trim()) return unsupported(`${dir} has modified tracked files; Beast never deploys over local changes`);
  const apps = await host.pm2List();
  if (!apps) return uncertain("could not query PM2");
  const app = apps.filter((a) => a.name === ctx.def.target.pm2App);
  if (app.length !== 1) return unsupported(`PM2 app ${ctx.def.target.pm2App} ${app.length ? "is ambiguous" : "does not exist"}`);
  if (app[0]!.cwd !== dir) return unsupported(`PM2 app ${ctx.def.target.pm2App} does not run from ${dir}`);
  return { ok: true, head: head.stdout.trim() };
}

function historyFile(host: BrokerHost, id: string): string {
  return path.join(host.cfg.stateDir, "deployments", `${id}.json`);
}

export function readHistory(host: BrokerHost, id: string): DeploymentRecord[] {
  const file = historyFile(host, id);
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { records?: DeploymentRecord[] };
  return Array.isArray(data.records) ? data.records : [];
}

function record(host: BrokerHost, id: string, rec: DeploymentRecord): void {
  const file = historyFile(host, id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const records = [...readHistory(host, id), rec].slice(-MAX_HISTORY);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ records }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The commit a rollback returns to: only right after Beast's own successful deployment of the current commit. */
function rollbackPoint(host: BrokerHost, id: string, head: string): string | undefined {
  const last = readHistory(host, id).at(-1);
  return last && last.op === "deploy.run" && last.status === "succeeded" && last.commit === head ? last.previous : undefined;
}

/** Validation-time inspection (also used by the broker's own re-validation). Read-only. */
export async function probeDeployment(host: BrokerHost, q: DeploymentQuery): Promise<DeploymentProbe> {
  try {
    const r = await resolve(host, q.target);
    if (!r.ok) return r;
    const { def, agent } = r.ctx;
    const st = await targetState(host, r.ctx);
    if (!st.ok) return st;
    const facts: Record<string, string> = { ...definitionFacts(def), "target.currentCommit": st.head };

    if (q.op === "deploy.run") {
      const commit = q.commit!;
      if (commit === st.head) return unsupported(`commit ${commit} is already deployed`);
      const src = def.source.workspace;
      if (!succeeded(await git(host, agent, src, ["cat-file", "-e", `${commit}^{commit}`]))) return unsupported(`commit ${commit} does not exist in ${src}`);
      const onBranch = await git(host, agent, src, ["merge-base", "--is-ancestor", commit, `refs/heads/${def.source.branch}`]);
      if (onBranch.exitCode === 1) return unsupported(`commit ${commit} is not on branch ${def.source.branch}`);
      if (!succeeded(onBranch)) return uncertain(`could not check that ${commit} is on branch ${def.source.branch}`);
      if (!succeeded(await git(host, agent, src, ["cat-file", "-e", `${st.head}^{commit}`]))) {
        return unsupported(`the deployed commit ${st.head} is not in ${src}, so the deployment cannot be checked as a fast-forward`);
      }
      const ff = await git(host, agent, src, ["merge-base", "--is-ancestor", st.head, commit]);
      if (ff.exitCode === 1) return unsupported(`commit ${commit} does not descend from the deployed commit ${st.head}; use deploy.rollback to go back`);
      if (!succeeded(ff)) return uncertain("could not check that the deployment is a fast-forward");
      facts["deploy.commit"] = commit;
    } else if (q.op === "deploy.rollback") {
      if (def.rollback !== "previous-commit") return unsupported(`deployment target ${def.id} does not support rollback`);
      const to = rollbackPoint(host, def.id, st.head);
      if (!to) return unsupported(`the deployed commit ${st.head} was not deployed by Beast's last deployment, so there is no recorded commit to roll back to`);
      if (!succeeded(await git(host, r.ctx.deployer, def.target.checkout, ["cat-file", "-e", `${to}^{commit}`]))) return unsupported(`rollback commit ${to} is not in the checkout`);
      facts["rollback.toCommit"] = to;
    }
    return { ok: true, facts };
  } catch (err) {
    return uncertain(`could not inspect deployment target: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Step log returned as the (redacted, bounded) operation output. */
class Steps {
  readonly lines: string[] = [];
  ok(step: string, detail = ""): void {
    this.lines.push(`ok    ${step}${detail ? `: ${detail}` : ""}`);
  }
  fail(step: string, r?: ProcResult, detail = ""): void {
    const why = r ? (r.spawnError ?? (r.timedOut ? "timed out" : `exit ${r.exitCode}`)) : detail;
    this.lines.push(`FAIL  ${step}: ${why}`);
    const out = r ? (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim() : "";
    if (out) this.lines.push(...out.split("\n").slice(-30).map((l) => `      ${l}`));
  }
  get text(): string {
    return this.lines.join("\n");
  }
}

async function runStep(steps: Steps, step: string, run: () => Promise<ProcResult>): Promise<boolean> {
  const r = await run();
  if (succeeded(r)) steps.ok(step);
  else steps.fail(step, r);
  return succeeded(r);
}

/** Install and verify the exact commit in a throwaway clone, as the agent user. Production is not touched. */
async function verifyInClone(host: BrokerHost, ctx: Context, commit: string, steps: Steps): Promise<boolean> {
  const { def, agent } = ctx;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "beast-deploy-"));
  fs.chownSync(base, agent.uid, agent.gid);
  fs.chmodSync(base, 0o700);
  const dir = path.join(base, "src");
  try {
    if (!(await runStep(steps, "pre-deploy: clone source", () => runAs(host, agent, base, host.cfg.programs.git, [...GIT_SAFE, "clone", "--quiet", "--no-local", "--no-checkout", "--", def.source.workspace, dir], CLONE_TIMEOUT_MS)))) return false;
    if (!(await runStep(steps, `pre-deploy: check out ${commit}`, () => git(host, agent, dir, ["checkout", "--quiet", "--detach", commit])))) return false;
    const head = await git(host, agent, dir, ["rev-parse", "HEAD"]);
    if (!succeeded(head) || head.stdout.trim() !== commit) {
      steps.fail("pre-deploy: verify commit", undefined, "clone is not at the approved commit");
      return false;
    }
    if (def.install === "npm-ci" && !(await runStep(steps, "pre-deploy: npm ci", () => runAs(host, agent, dir, host.cfg.programs.npm, ["ci", "--no-audit", "--no-fund"], INSTALL_TIMEOUT_MS)))) return false;
    for (const script of def.preDeploy) {
      if (!(await runStep(steps, `pre-deploy: npm run ${script}`, () => runAs(host, agent, dir, host.cfg.programs.npm, ["run", "--silent", script], SCRIPT_TIMEOUT_MS)))) return false;
    }
    return true;
  } finally {
    // Removed as the agent, which owns everything inside; root never walks an agent-controlled tree.
    await runAs(host, agent, "/", host.cfg.bins.rm, ["-rf", "--", base], GIT_TIMEOUT_MS).catch(() => undefined);
  }
}

async function checkHealth(def: DeploymentDefinition, steps: Steps): Promise<{ ok: boolean; status: number }> {
  let status = 0;
  for (let attempt = 1; attempt <= def.health.attempts; attempt++) {
    await sleep(def.health.intervalMs);
    try {
      const res = await fetch(def.health.url, { redirect: "manual", signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) });
      status = res.status;
      await res.body?.cancel().catch(() => undefined);
      if (status === def.health.expectStatus) {
        steps.ok("health check", `HTTP ${status} after ${attempt} attempt(s)`);
        return { ok: true, status };
      }
    } catch {
      status = 0;
    }
  }
  steps.fail("health check", undefined, `expected HTTP ${def.health.expectStatus}, last ${status || "no response"} after ${def.health.attempts} attempt(s)`);
  return { ok: false, status };
}

/** Install, build, restart and health-check whatever commit the checkout is now at. */
async function activate(host: BrokerHost, ctx: Context, steps: Steps, label: string): Promise<{ ok: boolean; healthStatus: number }> {
  const { def, deployer } = ctx;
  const dir = def.target.checkout;
  if (def.install === "npm-ci" && !(await runStep(steps, `${label}: npm ci`, () => runAs(host, deployer, dir, host.cfg.programs.npm, ["ci", "--no-audit", "--no-fund"], INSTALL_TIMEOUT_MS)))) {
    return { ok: false, healthStatus: 0 };
  }
  for (const script of def.build) {
    if (!(await runStep(steps, `${label}: npm run ${script}`, () => runAs(host, deployer, dir, host.cfg.programs.npm, ["run", "--silent", script], SCRIPT_TIMEOUT_MS)))) {
      return { ok: false, healthStatus: 0 };
    }
  }
  const restart = await host.pm2(["restart", def.target.pm2App], RESTART_TIMEOUT_MS, 64_000);
  if (!restart || !succeeded(restart)) {
    steps.fail(`${label}: pm2 restart ${def.target.pm2App}`, restart ?? undefined, "PM2 owner account not found");
    return { ok: false, healthStatus: 0 };
  }
  steps.ok(`${label}: pm2 restart ${def.target.pm2App}`);
  const health = await checkHealth(def, steps);
  const app = (await host.pm2List())?.find((a) => a.name === def.target.pm2App);
  if (app?.status !== "online") {
    steps.fail(`${label}: PM2 status`, undefined, `PM2 reports ${app?.status ?? "unknown"}`);
    return { ok: false, healthStatus: health.status };
  }
  return { ok: health.ok, healthStatus: health.status };
}

async function headOf(host: BrokerHost, ctx: Context): Promise<string> {
  const r = await git(host, ctx.deployer, ctx.def.target.checkout, ["rev-parse", "--verify", "HEAD^{commit}"]);
  return succeeded(r) ? r.stdout.trim() : "unknown";
}

/** Move the checkout back to `to` (refuses if it would lose local changes), then activate it. */
async function rollBack(host: BrokerHost, ctx: Context, to: string, steps: Steps): Promise<{ ok: boolean; healthStatus: number }> {
  if (!(await runStep(steps, `rollback: git reset --keep ${to}`, () => git(host, ctx.deployer, ctx.def.target.checkout, ["reset", "--keep", "--quiet", to])))) {
    return { ok: false, healthStatus: 0 };
  }
  if ((await headOf(host, ctx)) !== to) {
    steps.fail("rollback: verify commit", undefined, "checkout is not at the rollback commit");
    return { ok: false, healthStatus: 0 };
  }
  return activate(host, ctx, steps, "rollback");
}

export async function runDeployment(op: ValidatedOperation, host: BrokerHost): Promise<RawResult> {
  const commit = String(op.params.commit);
  const previous = op.facts["target.currentCommit"]!;
  const r = await resolve(host, String(op.params.target));
  if (!r.ok) return { status: "denied", reason: r.reason };
  const ctx = r.ctx;
  const { def, deployer } = ctx;
  const dir = def.target.checkout;
  const steps = new Steps();
  const fields = (extra: Record<string, string | number | boolean>) => ({ target: def.id, production: def.production, commit, previousCommit: previous, ...extra });

  // 1. Pre-deployment verification of the exact commit, away from production.
  if (!(await verifyInClone(host, ctx, commit, steps))) {
    return { status: "failed", reason: "pre-deployment verification failed; production was not changed", output: steps.text, fields: fields({ stage: "pre-deploy", deployed: false }) };
  }

  // 2. Production must still be exactly what was approved.
  const st = await targetState(host, ctx);
  if (!st.ok || st.head !== previous) {
    return { status: "denied", reason: "the target changed while the commit was being verified; production was not changed", output: steps.text, fields: fields({ stage: "recheck", deployed: false }) };
  }

  // 3. Bring the commit into the checkout from the source branch and confirm it is on it.
  const fetched =
    (await runStep(steps, `fetch ${def.source.branch} from source`, () => git(host, deployer, dir, ["fetch", "--no-tags", "--quiet", "--", def.source.workspace, `refs/heads/${def.source.branch}`], CLONE_TIMEOUT_MS))) &&
    (await runStep(steps, `confirm ${commit} is on ${def.source.branch}`, () => git(host, deployer, dir, ["merge-base", "--is-ancestor", commit, "FETCH_HEAD"]))) &&
    (await runStep(steps, `fast-forward checkout to ${commit}`, () => git(host, deployer, dir, ["merge", "--ff-only", "--quiet", commit])));
  const at = await headOf(host, ctx);
  if ((!fetched || at !== commit) && at === previous) {
    // `merge --ff-only` changes nothing when it fails.
    return { status: "failed", reason: "could not check out the commit; production was not changed", output: steps.text, fields: fields({ stage: "checkout", deployed: false }) };
  }

  // 4. Install, build, restart, health check. Any failure (including an unexpected checkout
  // state) rolls back when supported.
  const live = fetched && at === commit ? await activate(host, ctx, steps, "deploy") : { ok: false, healthStatus: 0 };
  if (live.ok) {
    record(host, def.id, { requestId: op.requestId, op: "deploy.run", commit, previous, status: "succeeded", rolledBack: false, at: new Date().toISOString() });
    return { status: "succeeded", output: steps.text, fields: fields({ stage: "done", deployed: true, deployedCommit: commit, healthStatus: live.healthStatus, rolledBack: false }) };
  }

  let rolledBack = false;
  let rollbackHealthy = false;
  if (def.rollback === "previous-commit") {
    const rb = await rollBack(host, ctx, previous, steps);
    rolledBack = true;
    rollbackHealthy = rb.ok;
  }
  record(host, def.id, { requestId: op.requestId, op: "deploy.run", commit, previous, status: "failed", rolledBack, at: new Date().toISOString() });
  return {
    status: "failed",
    reason: rolledBack
      ? rollbackHealthy
        ? `deployment failed; rolled back to ${previous}, which is healthy`
        : `deployment failed and the rollback to ${previous} did not pass its health check; manual attention needed`
      : "deployment failed; this target has no automatic rollback; manual attention needed",
    output: steps.text,
    fields: fields({ stage: "activate", deployed: false, rolledBack, rollbackHealthy, deployedCommit: await headOf(host, ctx) }),
  };
}

export async function rollbackDeployment(op: ValidatedOperation, host: BrokerHost): Promise<RawResult> {
  const to = op.facts["rollback.toCommit"]!;
  const from = op.facts["target.currentCommit"]!;
  const r = await resolve(host, String(op.params.target));
  if (!r.ok) return { status: "denied", reason: r.reason };
  const steps = new Steps();
  const st = await targetState(host, r.ctx);
  if (!st.ok || st.head !== from) return { status: "denied", reason: "the target changed since approval; nothing was changed" };
  const rb = await rollBack(host, r.ctx, to, steps);
  record(host, r.ctx.def.id, { requestId: op.requestId, op: "deploy.rollback", commit: to, previous: from, status: rb.ok ? "succeeded" : "failed", rolledBack: true, at: new Date().toISOString() });
  return {
    status: rb.ok ? "succeeded" : "failed",
    reason: rb.ok ? undefined : "rollback did not complete or did not pass its health check; manual attention needed",
    output: steps.text,
    fields: { target: r.ctx.def.id, fromCommit: from, toCommit: to, deployedCommit: await headOf(host, r.ctx), healthStatus: rb.healthStatus },
  };
}

export async function deploymentStatus(op: ValidatedOperation, host: BrokerHost): Promise<RawResult> {
  const r = await resolve(host, String(op.params.target));
  if (!r.ok) return { status: "failed", reason: r.reason };
  const { def } = r.ctx;
  const steps = new Steps();
  const app = (await host.pm2List())?.find((a) => a.name === def.target.pm2App);
  const health = await checkHealth({ ...def, health: { ...def.health, attempts: 1, intervalMs: 250 } }, steps);
  const last = readHistory(host, def.id).at(-1);
  return {
    status: "succeeded",
    fields: {
      target: def.id,
      project: def.project,
      production: def.production,
      deployedCommit: await headOf(host, r.ctx),
      pm2Status: app?.status ?? "unknown",
      healthy: health.ok,
      healthStatus: health.status,
      lastDeployment: last ? `${last.op} ${last.commit} ${last.status} at ${last.at}` : "none",
    },
  };
}
