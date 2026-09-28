import { spawn } from "node:child_process";
import { SECRET_ENV_VARS } from "../config.js";

export interface ExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when the process was stopped through `signal` (cancel / shutdown). */
  aborted: boolean;
  durationMs: number;
  /** Set when the process could not be started (e.g. binary not found). */
  spawnError?: string;
}

export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  /** Only the last N characters of stdout/stderr are kept in memory. */
  maxOutputChars?: number;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Aborting stops the process and its whole process group. */
  signal?: AbortSignal;
  /** Delay between SIGTERM and SIGKILL when stopping the process group. */
  killGraceMs?: number;
}

/** Process groups of children that are still running. */
const activeGroups = new Set<number>();

function killGroupNow(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* already exited */
  }
}

/**
 * Immediately signal every running child process group. Used on Beast
 * shutdown so an agent cannot keep running after Beast has gone.
 */
export function killActiveProcessGroups(signal: NodeJS.Signals = "SIGKILL"): number {
  for (const pid of activeGroups) killGroupNow(pid, signal);
  return activeGroups.size;
}

/**
 * Environment for child processes: inherits the parent environment
 * minus Beast's own secrets, so agents and project scripts never see them.
 */
export function childEnv(extra: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  for (const name of SECRET_ENV_VARS) delete env[name];
  return env;
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

/** Run a command without a shell. Never throws; failures are reported in the result. */
export function runCommand(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  const max = opts.maxOutputChars ?? 20_000;
  const started = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let stopping = false;
    let settled = false;

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? childEnv(),
      shell: false,
      // Own process group so a timeout can kill the agent and everything it spawned.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid) killGroupNow(child.pid, signal);
    };

    // Stop the whole process group: SIGTERM first, SIGKILL after a grace period.
    const stop = () => {
      if (stopping) return;
      stopping = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), opts.killGraceMs ?? 10_000).unref();
    };

    const onAbort = () => {
      aborted = true;
      stop();
    };

    const finish = (result: Omit<ExecResult, "stdout" | "stderr" | "timedOut" | "aborted" | "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (child.pid) {
        // The leader is gone; make sure nothing it spawned outlives a stop.
        if (stopping) killGroup("SIGKILL");
        activeGroups.delete(child.pid);
      }
      resolve({ ...result, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started });
    };

    if (child.pid) activeGroups.add(child.pid);

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, opts.timeoutMs)
      : undefined;

    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = tail(stdout + chunk, max);
      opts.onOutput?.("stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = tail(stderr + chunk, max);
      opts.onOutput?.("stderr", chunk);
    });

    child.on("error", (err) => finish({ exitCode: null, signal: null, spawnError: err.message }));
    child.on("close", (code, signal) => finish({ exitCode: code, signal }));

    child.stdin.on("error", () => {
      /* child may exit before reading stdin */
    });
    child.stdin.end(opts.input ?? "");
  });
}
