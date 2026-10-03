import { spawn } from "node:child_process";

/**
 * The broker's only way to start a process: an absolute program path with a fixed
 * argument vector, no shell, an explicit environment, its own process group, a hard
 * timeout and bounded output. Callers never pass a command string.
 */
export interface ProcOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  input?: string;
  /** Only the last N characters of each stream are kept. */
  maxOutputChars?: number;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  killGraceMs?: number;
}

export interface ProcResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  spawnError?: string;
}

export interface ProcHandle {
  result: Promise<ProcResult>;
  /** Stop the whole process group: SIGTERM, then SIGKILL after the grace period. */
  stop(): void;
}

const tail = (text: string, max: number) => (text.length > max ? text.slice(text.length - max) : text);

export function startProc(file: string, args: readonly string[], opts: ProcOptions): ProcHandle {
  if (!file.startsWith("/")) throw new Error("program path must be absolute");
  const max = opts.maxOutputChars ?? 64_000;
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let stopping = false;
  let exited = false;

  const child = spawn(file, [...args], {
    cwd: opts.cwd ?? "/",
    env: opts.env,
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const killGroup = (sig: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* already gone */
    }
  };
  const stop = () => {
    if (stopping || exited) return;
    stopping = true;
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), opts.killGraceMs ?? 10_000).unref();
  };

  const result = new Promise<ProcResult>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    const finish = (r: Pick<ProcResult, "exitCode" | "signal" | "spawnError">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopping) killGroup("SIGKILL");
      exited = true;
      resolve({ ...r, stdout, stderr, timedOut, durationMs: Date.now() - started });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout = tail(stdout + c, max);
      opts.onOutput?.("stdout", c);
    });
    child.stderr.on("data", (c: string) => {
      stderr = tail(stderr + c, max);
      opts.onOutput?.("stderr", c);
    });
    child.on("error", (err) => finish({ exitCode: null, signal: null, spawnError: err.message }));
    child.on("close", (code, sig) => finish({ exitCode: code, signal: sig }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input ?? "");
  });

  return { result, stop };
}

export function runProc(file: string, args: readonly string[], opts: ProcOptions): Promise<ProcResult> {
  return startProc(file, args, opts).result;
}
