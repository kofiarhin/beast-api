import fs from "node:fs/promises";
import path from "node:path";
import { childEnv, runCommand } from "../util/exec.js";
import { gitHead, gitStatus } from "../workspace/git.js";

export type CheckStatus = "passed" | "failed" | "timed_out" | "skipped";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  exitCode?: number | null;
  durationMs?: number;
  outputTail?: string;
}

export interface VerificationResult {
  agentExitCode: number | null;
  agentTimedOut: boolean;
  gitStatus: string;
  changedFiles: string[];
  headBefore: string | null;
  headAfter: string | null;
  newCommits: boolean;
  checks: CheckResult[];
  passed: boolean;
}

export interface VerifyOptions {
  workspacePath: string;
  headBefore: string | null;
  agentExitCode: number | null;
  agentTimedOut: boolean;
  scripts: string[];
  timeoutMs: number;
}

async function readScripts(workspacePath: string): Promise<Record<string, string> | null> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(workspacePath, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts ?? {};
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

/**
 * Inspect the workspace after the agent finished. Read-only with respect to Git:
 * never commits, stashes, resets, pushes or deploys.
 */
export async function verifyWorkspace(opts: VerifyOptions): Promise<VerificationResult> {
  const status = await gitStatus(opts.workspacePath);
  const headAfter = await gitHead(opts.workspacePath);
  const checks: CheckResult[] = [];

  if (!status.ok) checks.push({ name: "git status", status: "failed", detail: status.error });

  const scripts = await readScripts(opts.workspacePath);
  const hasDeps = await exists(path.join(opts.workspacePath, "node_modules"));

  for (const name of opts.scripts) {
    if (!scripts) {
      checks.push({ name, status: "skipped", detail: "no package.json" });
      continue;
    }
    if (!scripts[name]) {
      checks.push({ name, status: "skipped", detail: "script not defined" });
      continue;
    }
    if (!hasDeps) {
      checks.push({ name, status: "skipped", detail: "node_modules not installed" });
      continue;
    }
    const res = await runCommand("npm", ["run", "--silent", name], {
      cwd: opts.workspacePath,
      timeoutMs: opts.timeoutMs,
      // CI=true keeps test runners (e.g. vitest, jest) out of watch mode.
      env: childEnv({ CI: "true", FORCE_COLOR: "0" }),
      maxOutputChars: 4_000,
    });
    checks.push({
      name,
      status: res.timedOut ? "timed_out" : res.exitCode === 0 ? "passed" : "failed",
      exitCode: res.exitCode,
      durationMs: res.durationMs,
      detail: res.spawnError,
      outputTail: (res.stdout + "\n" + res.stderr).trim().slice(-2_000),
    });
  }

  const agentOk = opts.agentExitCode === 0 && !opts.agentTimedOut;
  return {
    agentExitCode: opts.agentExitCode,
    agentTimedOut: opts.agentTimedOut,
    gitStatus: status.output,
    changedFiles: status.files,
    headBefore: opts.headBefore,
    headAfter,
    newCommits: opts.headBefore !== headAfter,
    checks,
    passed: agentOk && status.ok && checks.every((c) => c.status === "passed" || c.status === "skipped"),
  };
}
