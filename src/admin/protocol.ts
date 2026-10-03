import path from "node:path";
import type { AuthorizationGrant } from "./authorize.js";
import { ACCOUNT_NAME, COMMIT_SHA, DEPLOY_TARGET_NAME, UNIT_NAME } from "./names.js";
import { checkPathSyntax } from "./paths.js";
import type { ValidatedOperation } from "./validate.js";

/**
 * Wire contract between Beast API (the `beast` user) and the privileged broker
 * (`beast-executor`, root). One newline-delimited JSON message per line over a Unix socket
 * that only root and the `beast` group can open. There is no message that carries a
 * command string: admin requests name a typed operation, probes name a fixed lookup, and
 * spawns name one of a few fixed programs that always run as `beast-agent`.
 */

export interface ExecutorWireRequest {
  v: 1;
  type: "admin";
  requestId: string;
  op: string;
  opVersion: number;
  params: Readonly<Record<string, string | number | boolean>>;
  /** Facts the operation was validated against; the broker re-checks them before acting. */
  facts: Readonly<Record<string, string>>;
  grant: {
    class: "A" | "B" | "C";
    issueId: string;
    requester: string;
    digest: string | null;
    approver: string | null;
  };
}

export function toWireRequest(op: ValidatedOperation, grant: AuthorizationGrant): ExecutorWireRequest {
  return {
    v: 1,
    type: "admin",
    requestId: op.requestId,
    op: op.op,
    opVersion: op.opVersion,
    params: op.params,
    facts: op.facts,
    grant: {
      class: grant.riskClass,
      issueId: grant.issueId,
      requester: grant.requesterId,
      digest: grant.digest,
      approver: grant.approverId,
    },
  };
}

/** Read-only host lookups Beast API needs for validation (it cannot see everything unprivileged). */
export type ProbeRequest =
  | { v: 1; type: "probe"; what: "unit"; name: string }
  | { v: 1; type: "probe"; what: "pm2Apps" }
  | { v: 1; type: "probe"; what: "userId" | "groupId"; name: string }
  | { v: 1; type: "probe"; what: "lstat"; path: string }
  | { v: 1; type: "probe"; what: "deployment"; op: string; target: string; commit?: string };

/** Admin operations that take a deployment target. */
export const DEPLOY_OPS = ["deploy.status", "deploy.run", "deploy.rollback"] as const;

/** Programs the broker may start as `beast-agent`. Their absolute paths are fixed broker-side. */
export const SPAWN_PROGRAMS = ["claude", "codex", "npm", "git"] as const;
export type SpawnProgram = (typeof SPAWN_PROGRAMS)[number];

/** Verification scripts `npm` may run. */
export const SPAWN_NPM_SCRIPTS = ["test", "lint", "typecheck", "build"] as const;

/** Environment variables a spawn may set; everything else is fixed by the broker. */
export const SPAWN_ENV_KEYS = ["CI", "FORCE_COLOR", "GIT_TERMINAL_PROMPT", "GIT_OPTIONAL_LOCKS"] as const;

/** Placeholder replaced by a private per-run file whose contents are returned on exit. */
export const CAPTURE_FILE_TOKEN = "@@BEAST_CAPTURE_FILE@@";

/**
 * Start an agent, a verification script or a Git command as the unprivileged
 * `beast-agent` user, under no-new-privs, in (or at) the workspace root. Internal to
 * Beast; never an admin operation a ticket can request.
 */
export interface SpawnRequest {
  v: 1;
  type: "spawn";
  program: SpawnProgram;
  args: string[];
  cwd: string;
  input: string;
  env: Partial<Record<(typeof SPAWN_ENV_KEYS)[number], string>>;
  timeoutMs: number;
  captureFile: boolean;
}

/** Client -> broker while a spawn runs. */
export interface SpawnKill {
  type: "kill";
}

/** Broker -> client while a spawn runs, then exactly one `exit`. */
export type SpawnEvent =
  | { type: "out"; stream: "stdout" | "stderr"; data: string }
  | {
      type: "exit";
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      durationMs: number;
      spawnError?: string;
      captured?: string;
    };

export type BrokerRequest = ExecutorWireRequest | ProbeRequest | SpawnRequest;

const MAX_ARGS = 64;
const MAX_ARG_CHARS = 64 * 1024;
const MAX_INPUT_CHARS = 512 * 1024;
const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINEAR_ID = /^[A-Za-z0-9-]{1,64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(obj).every((k) => allowed.includes(k));
}

function insideRoot(root: string, p: string, allowRoot: boolean): boolean {
  if (!path.isAbsolute(p) || path.normalize(p) !== p || p.endsWith("/")) return false;
  if (p === root) return allowRoot;
  return p.startsWith(root + "/");
}

/** Structural check of an admin request. Semantic checks (policy, targets, facts) happen in the broker. */
export function adminRequestProblem(req: Record<string, unknown>): string | undefined {
  if (!onlyKeys(req, ["v", "type", "requestId", "op", "opVersion", "params", "facts", "grant"])) return "unknown fields";
  if (typeof req.requestId !== "string" || !UUID.test(req.requestId)) return "invalid requestId";
  if (typeof req.op !== "string" || req.op.length > 64) return "invalid op";
  if (!Number.isSafeInteger(req.opVersion)) return "invalid opVersion";
  if (!isPlainObject(req.params)) return "params must be an object";
  if (!isPlainObject(req.facts) || !Object.values(req.facts).every((v) => typeof v === "string")) return "facts must be an object of strings";
  const g = req.grant;
  if (!isPlainObject(g) || !onlyKeys(g, ["class", "issueId", "requester", "digest", "approver"])) return "invalid grant";
  if (g.class !== "A" && g.class !== "B" && g.class !== "C") return "invalid grant class";
  if (typeof g.issueId !== "string" || !LINEAR_ID.test(g.issueId)) return "invalid grant issueId";
  if (typeof g.requester !== "string" || !LINEAR_ID.test(g.requester)) return "invalid grant requester";
  if (g.class === "C") {
    if (typeof g.digest !== "string" || !/^[0-9a-f]{64}$/.test(g.digest)) return "class C requires an approval digest";
    if (typeof g.approver !== "string" || !LINEAR_ID.test(g.approver)) return "class C requires an approver";
  } else if (g.digest !== null || g.approver !== null) {
    return `class ${g.class} takes no approval`;
  }
  return undefined;
}

export function probeRequestProblem(req: Record<string, unknown>): string | undefined {
  switch (req.what) {
    case "pm2Apps":
      return onlyKeys(req, ["v", "type", "what"]) ? undefined : "unknown fields";
    case "unit":
      if (!onlyKeys(req, ["v", "type", "what", "name"])) return "unknown fields";
      return typeof req.name === "string" && UNIT_NAME.test(req.name) ? undefined : "invalid unit name";
    case "userId":
    case "groupId":
      if (!onlyKeys(req, ["v", "type", "what", "name"])) return "unknown fields";
      return typeof req.name === "string" && ACCOUNT_NAME.test(req.name) ? undefined : "invalid account name";
    case "lstat":
      if (!onlyKeys(req, ["v", "type", "what", "path"])) return "unknown fields";
      // Probes walk paths one component at a time, so only plain absolute paths are accepted.
      return typeof req.path === "string" && (req.path === "/" || !checkPathSyntax(req.path)) ? undefined : "invalid path";
    case "deployment":
      if (!onlyKeys(req, ["v", "type", "what", "op", "target", "commit"])) return "unknown fields";
      if (!(DEPLOY_OPS as readonly unknown[]).includes(req.op)) return "invalid deployment op";
      if (typeof req.target !== "string" || !DEPLOY_TARGET_NAME.test(req.target)) return "invalid deployment target";
      if (req.op === "deploy.run" ? typeof req.commit !== "string" || !COMMIT_SHA.test(req.commit) : req.commit !== undefined) return "invalid commit";
      return undefined;
    default:
      return "unknown probe";
  }
}

export function spawnRequestProblem(req: Record<string, unknown>, workspaceRoot: string): string | undefined {
  if (!onlyKeys(req, ["v", "type", "program", "args", "cwd", "input", "env", "timeoutMs", "captureFile"])) return "unknown fields";
  if (!SPAWN_PROGRAMS.includes(req.program as SpawnProgram)) return "program not allowed";
  const args = req.args;
  if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((a) => typeof a === "string" && a.length <= MAX_ARG_CHARS && !a.includes("\0"))) {
    return "invalid args";
  }
  if (typeof req.cwd !== "string" || !insideRoot(workspaceRoot, req.cwd, req.program === "git")) return "cwd must be inside the workspace root";
  if (typeof req.input !== "string" || req.input.length > MAX_INPUT_CHARS) return "invalid input";
  if (!isPlainObject(req.env) || !Object.entries(req.env).every(([k, v]) => (SPAWN_ENV_KEYS as readonly string[]).includes(k) && typeof v === "string" && v.length <= 64)) {
    return "env may only set CI, FORCE_COLOR, GIT_TERMINAL_PROMPT and GIT_OPTIONAL_LOCKS";
  }
  if (!Number.isSafeInteger(req.timeoutMs) || (req.timeoutMs as number) <= 0 || (req.timeoutMs as number) > MAX_TIMEOUT_MS) return "invalid timeout";
  if (typeof req.captureFile !== "boolean") return "invalid captureFile";
  const captureUses = (args as string[]).filter((a) => a === CAPTURE_FILE_TOKEN).length;
  if (captureUses !== (req.captureFile ? 1 : 0)) return "capture file token must appear exactly once when requested";

  if (req.program === "npm") {
    const a = args as string[];
    if (a.length !== 3 || a[0] !== "run" || a[1] !== "--silent" || !(SPAWN_NPM_SCRIPTS as readonly string[]).includes(a[2]!)) {
      return "npm may only run test, lint, typecheck or build";
    }
  }
  if (req.program === "git") {
    const a = args as string[];
    // Always `git -C <dir> <subcommand> ...` with the directory equal to cwd.
    if (a[0] !== "-C" || a[1] !== req.cwd) return "git must be run as git -C <cwd> ...";
  }
  return undefined;
}

/** Validate the envelope and dispatch to the per-type structural check. */
export function brokerRequestProblem(raw: unknown, workspaceRoot: string): string | undefined {
  if (!isPlainObject(raw)) return "request must be a JSON object";
  if (raw.v !== 1) return "unsupported version";
  switch (raw.type) {
    case "admin":
      return adminRequestProblem(raw);
    case "probe":
      return probeRequestProblem(raw);
    case "spawn":
      return spawnRequestProblem(raw, workspaceRoot);
    default:
      return "unknown request type";
  }
}

/** Splits a byte stream into newline-delimited JSON messages, refusing oversized lines. */
export class LineDecoder {
  private buffer = "";
  constructor(private readonly maxLine = 2 * 1024 * 1024) {}

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      out.push(JSON.parse(line));
    }
    if (this.buffer.length > this.maxLine) throw new Error("message too large");
    return out;
  }
}

export const encode = (msg: unknown): string => JSON.stringify(msg) + "\n";
