import path from "node:path";

/** Beast only ever listens on loopback. This is intentionally not configurable. */
export const HOST = "127.0.0.1";

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  return {
    port: positiveInt(env.PORT, 3100, "PORT"),
    linearApiKey: nonEmpty(env.LINEAR_API_KEY),
    linearApiUrl: nonEmpty(env.LINEAR_API_URL) ?? "https://api.linear.app/graphql",
    linearWebhookSecret: nonEmpty(env.LINEAR_WEBHOOK_SECRET),
    readyLabel: nonEmpty(env.BEAST_READY_LABEL) ?? "Beast Ready",
    agent: (nonEmpty(env.BEAST_AGENT) ?? "codex").toLowerCase(),
    dataDir: path.resolve(cwd, nonEmpty(env.BEAST_DATA_DIR) ?? "data"),
    projectsFile: path.resolve(cwd, nonEmpty(env.BEAST_PROJECTS_FILE) ?? "config/projects.json"),
    workspaceRoot: path.resolve(nonEmpty(env.BEAST_WORKSPACE_ROOT) ?? "/home/ubuntu/projects"),
    agentTimeoutMs: positiveInt(env.BEAST_AGENT_TIMEOUT_MS, 60 * 60 * 1000, "BEAST_AGENT_TIMEOUT_MS"),
    verifyTimeoutMs: positiveInt(env.BEAST_VERIFY_TIMEOUT_MS, 10 * 60 * 1000, "BEAST_VERIFY_TIMEOUT_MS"),
    verifyScripts: (nonEmpty(env.BEAST_VERIFY_SCRIPTS) ?? "test,lint,typecheck,build")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    webhookToleranceMs: positiveInt(env.BEAST_WEBHOOK_TOLERANCE_MS, 60_000, "BEAST_WEBHOOK_TOLERANCE_MS"),
    codexBin: nonEmpty(env.BEAST_CODEX_BIN) ?? "codex",
    codexModel: nonEmpty(env.BEAST_CODEX_MODEL),
  };
}
