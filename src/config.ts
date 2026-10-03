import path from "node:path";
import type { AdminMode } from "./admin/types.js";

/** Beast only ever listens on loopback. This is intentionally not configurable. */
export const HOST = "127.0.0.1";

/** The only permitted development workspace root. Intentionally not configurable. */
export const WORKSPACE_ROOT = "/home/ubuntu/projects";

export interface Config {
  port: number;
  linearApiKey: string | undefined;
  linearApiUrl: string;
  linearWebhookSecret: string | undefined;
  readyLabel: string;
  agent: string;
  dataDir: string;
  projectsFile: string;
  workspaceRoot: string;
  agentTimeoutMs: number;
  verifyTimeoutMs: number;
  verifyScripts: string[];
  webhookToleranceMs: number;
  codexBin: string;
  codexModel: string | undefined;
  claudeBin: string;
  claudeModel: string | undefined;
  adminMode: AdminMode;
  adminLabel: string;
  adminRequesters: string[];
  adminApprovers: string[];
  adminPolicyFile: string;
  /** Where child processes run: `local` (this process's user) or `broker` (as beast-agent via beast-executor). */
  runner: "local" | "broker";
  executorSocket: string;
  /**
   * Beast's Linear API key belongs to a human approver (shared identity). Comments Beast
   * itself posted are still never accepted as approvals.
   */
  adminSharedLinearIdentity: boolean;
}

/** Environment variables that must never be passed to child processes (agents, verification). */
export const SECRET_ENV_VARS = ["LINEAR_API_KEY", "LINEAR_WEBHOOK_SECRET"] as const;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const LINEAR_USER_ID = /^[A-Za-z0-9-]{1,64}$/;

function userIdList(value: string | undefined, name: string): string[] {
  const ids = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids) if (!LINEAR_USER_ID.test(id)) throw new Error(`${name} must be a comma-separated list of Linear user IDs`);
  return [...new Set(ids)];
}

function adminMode(value: string | undefined): AdminMode {
  const mode = (nonEmpty(value) ?? "off").toLowerCase();
  if (mode === "off" || mode === "dry-run" || mode === "enforce") return mode;
  throw new Error("BEAST_ADMIN_MODE must be off, dry-run or enforce");
}

function runner(value: string | undefined): "local" | "broker" {
  const r = (nonEmpty(value) ?? "local").toLowerCase();
  if (r === "local" || r === "broker") return r;
  throw new Error("BEAST_RUNNER must be local or broker");
}

function flag(value: string | undefined, name: string): boolean {
  const v = (nonEmpty(value) ?? "false").toLowerCase();
  if (v === "true" || v === "false") return v === "true";
  throw new Error(`${name} must be true or false`);
}

export const DEFAULT_EXECUTOR_SOCKET = "/run/beast-executor/executor.sock";

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const requestedRoot = nonEmpty(env.BEAST_WORKSPACE_ROOT);
  if (requestedRoot && path.resolve(requestedRoot) !== WORKSPACE_ROOT) {
    throw new Error(`BEAST_WORKSPACE_ROOT must be ${WORKSPACE_ROOT}`);
  }
  const config: Config = {
    port: positiveInt(env.PORT, 3100, "PORT"),
    linearApiKey: nonEmpty(env.LINEAR_API_KEY),
    linearApiUrl: nonEmpty(env.LINEAR_API_URL) ?? "https://api.linear.app/graphql",
    linearWebhookSecret: nonEmpty(env.LINEAR_WEBHOOK_SECRET),
    readyLabel: nonEmpty(env.BEAST_READY_LABEL) ?? "Beast Ready",
    agent: (nonEmpty(env.BEAST_AGENT) ?? "codex").toLowerCase(),
    dataDir: path.resolve(cwd, nonEmpty(env.BEAST_DATA_DIR) ?? "data"),
    projectsFile: path.resolve(cwd, nonEmpty(env.BEAST_PROJECTS_FILE) ?? "config/projects.json"),
    workspaceRoot: WORKSPACE_ROOT,
    agentTimeoutMs: positiveInt(env.BEAST_AGENT_TIMEOUT_MS, 60 * 60 * 1000, "BEAST_AGENT_TIMEOUT_MS"),
    verifyTimeoutMs: positiveInt(env.BEAST_VERIFY_TIMEOUT_MS, 10 * 60 * 1000, "BEAST_VERIFY_TIMEOUT_MS"),
    verifyScripts: (nonEmpty(env.BEAST_VERIFY_SCRIPTS) ?? "test,lint,typecheck,build")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    webhookToleranceMs: positiveInt(env.BEAST_WEBHOOK_TOLERANCE_MS, 60_000, "BEAST_WEBHOOK_TOLERANCE_MS"),
    codexBin: nonEmpty(env.BEAST_CODEX_BIN) ?? "codex",
    codexModel: nonEmpty(env.BEAST_CODEX_MODEL),
    claudeBin: nonEmpty(env.BEAST_CLAUDE_BIN) ?? "claude",
    claudeModel: nonEmpty(env.BEAST_CLAUDE_MODEL),
    adminMode: adminMode(env.BEAST_ADMIN_MODE),
    adminLabel: nonEmpty(env.BEAST_ADMIN_LABEL) ?? "Beast Admin",
    adminRequesters: userIdList(env.BEAST_ADMIN_REQUESTERS, "BEAST_ADMIN_REQUESTERS"),
    adminApprovers: userIdList(env.BEAST_ADMIN_APPROVERS, "BEAST_ADMIN_APPROVERS"),
    adminPolicyFile: path.resolve(cwd, nonEmpty(env.BEAST_ADMIN_POLICY_FILE) ?? "config/admin-policy.json"),
    runner: runner(env.BEAST_RUNNER),
    executorSocket: nonEmpty(env.BEAST_EXECUTOR_SOCKET) ?? DEFAULT_EXECUTOR_SOCKET,
    adminSharedLinearIdentity: flag(env.BEAST_ADMIN_SHARED_LINEAR_IDENTITY, "BEAST_ADMIN_SHARED_LINEAR_IDENTITY"),
  };
  // Real privileged execution is safe only when agents cannot reach the executor socket:
  // they must run as a different user (beast-agent) through the broker.
  if (config.adminMode === "enforce" && config.runner !== "broker") {
    throw new Error("BEAST_ADMIN_MODE=enforce requires BEAST_RUNNER=broker, so agents never run as the Beast API user");
  }
  return config;
}
