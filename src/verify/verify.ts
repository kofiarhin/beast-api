import fs from "node:fs/promises";
import path from "node:path";
import { childEnv, runCommand } from "../util/exec.js";
import { redactSecrets } from "../util/redact.js";
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
  /** Approval-gated Git actions the agent performed (see workspace/approval.ts). */
  approvalViolations: string[];
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
  approvalViolations?: string[];
}

/** Output that shows a verification script tried to gain root (blocked by no-new-privs). */
const ESCALATION_ATTEMPT = /"no new privileges" flag is set|\bsu: Authentication failure\b|pkexec must be setuid root|\bsudo: .*(?:a terminal is required|a password is required|unable to)/i;

export const ESCALATION_BLOCKED_DETAIL =
  "verification script attempted privilege escalation (sudo/su/pkexec); blocked by no-new-privs. Beast never runs verification with root privileges";

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
    const passed = !res.timedOut && res.exitCode === 0;
    const escalation = !passed && ESCALATION_ATTEMPT.test(res.stdout + "\n" + res.stderr);
    checks.push({
      name,
      status: res.timedOut ? "timed_out" : passed ? "passed" : "failed",
      exitCode: res.exitCode,
      durationMs: res.durationMs,
      detail: escalation ? ESCALATION_BLOCKED_DETAIL : res.spawnError && redactSecrets(res.spawnError),
      outputTail: redactSecrets((res.stdout + "\n" + res.stderr).trim().slice(-2_000)),
    });
  }

  const agentOk = opts.agentExitCode === 0 && !opts.agentTimedOut;
  const approvalViolations = opts.approvalViolations ?? [];
  return {
    agentExitCode: opts.agentExitCode,
    agentTimedOut: opts.agentTimedOut,
    gitStatus: status.output,
    changedFiles: status.files,
    headBefore: opts.headBefore,
    headAfter,
    newCommits: opts.headBefore !== headAfter,
    approvalViolations,
    checks,
    passed: agentOk && status.ok && approvalViolations.length === 0 && checks.every((c) => c.status === "passed" || c.status === "skipped"),
  };
}
