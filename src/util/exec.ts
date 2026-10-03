import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CAPTURE_FILE_TOKEN } from "../admin/protocol.js";
import { SECRET_ENV_VARS } from "../config.js";

/**
 * Every child Beast starts (agents, verification scripts, Git, host probes) runs under
 * `setpriv --no-new-privs`. With that flag set the kernel ignores setuid binaries, so
 * `sudo`, `su` and `pkexec` cannot raise privileges anywhere in the child's process tree.
 * There is deliberately no option to turn this off.
 */
export const SETPRIV_BIN = "/usr/bin/setpriv";

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
  /** Contents of the capture file, when `captureFile` was requested. */
  captured?: string;
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
  /**
   * Replace the single CAPTURE_FILE_TOKEN argument with a private temporary file and
   * return that file's contents in `captured` (used for Codex's last message).
   */
  captureFile?: boolean;
}

/**
 * Where child processes run. By default they run locally as this process's user. In
 * production Beast API installs the broker runner, so every agent, verification script
 * and Git command runs as `beast-agent` through beast-executor instead.
 */
export interface CommandRunner {
  run(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult>;
  /** Stop everything this runner started; returns how many were running. */
  killAll(): number;
}

let installedRunner: CommandRunner | undefined;

export function setCommandRunner(runner: CommandRunner | undefined): void {
  installedRunner = runner;
}

export const MAX_CAPTURE_CHARS = 256 * 1024;

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
  return activeGroups.size + (installedRunner?.killAll() ?? 0);
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

/** Minimal environment for host probes: no inherited variables, so no inherited secrets. */
export function minimalEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...extra };
}

/** Resolve `cmd` the way spawn would, so a missing binary is still reported as a spawn error. */
function resolveExecutable(cmd: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const executable = (file: string) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (cmd.includes("/")) {
    const file = path.resolve(cwd, cmd);
    return executable(file) ? file : undefined;
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, cmd);
    if (executable(file)) return file;
  }
  return undefined;
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

/**
 * Run a command without a shell, under no-new-privs. Never throws; failures are reported
 * in the result. If setpriv is unavailable the command is not run at all (fail closed).
 */
export function runCommand(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  if (installedRunner) return installedRunner.run(cmd, args, opts);
  if (!opts.captureFile) return runLocal(cmd, args, opts);
  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "beast-capture-"));
  } catch (err) {
    return Promise.resolve({ exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, durationMs: 0, spawnError: `could not create capture file: ${String(err)}` });
  }
  const file = path.join(dir, "out");
  return runLocal(cmd, args.map((a) => (a === CAPTURE_FILE_TOKEN ? file : a)), opts).then((res) => {
    let captured: string | undefined;
    try {
      captured = fs.readFileSync(file, "utf8").slice(0, MAX_CAPTURE_CHARS);
    } catch {
      captured = undefined;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return { ...res, captured };
  });
}

function runLocal(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  const max = opts.maxOutputChars ?? 20_000;
  const started = Date.now();
  const env = opts.env ?? childEnv();

  const notRun = (spawnError: string): Promise<ExecResult> =>
    Promise.resolve({ exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, durationMs: 0, spawnError });
  if (!fs.existsSync(SETPRIV_BIN)) {
    return notRun(`${SETPRIV_BIN} is unavailable; refusing to run ${cmd} without no-new-privs`);
  }
  if (!fs.existsSync(opts.cwd)) return notRun(`spawn ${cmd} ENOENT (working directory ${opts.cwd} does not exist)`);
  const resolved = resolveExecutable(cmd, opts.cwd, env);
  if (!resolved) return notRun(`spawn ${cmd} ENOENT`);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let stopping = false;
    let settled = false;

    const child = spawn(SETPRIV_BIN, ["--no-new-privs", "--", resolved, ...args], {
      cwd: opts.cwd,
      env,
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
