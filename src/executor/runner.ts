import { SPAWN_ENV_KEYS, type SpawnProgram, type SpawnRequest } from "../admin/protocol.js";
import type { CommandRunner, ExecOptions, ExecResult } from "../util/exec.js";
import type { BrokerClient } from "./client.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const tail = (text: string, max: number) => (text.length > max ? text.slice(text.length - max) : text);

/**
 * Runs Beast's child processes through beast-executor as `beast-agent`. Only the
 * configured agent binaries, npm and git map to a broker program; anything else is
 * reported as not runnable. The caller's environment is never forwarded: only the few
 * variables the broker accepts are passed, so Beast API's secrets cannot reach a job.
 */
export class BrokerCommandRunner implements CommandRunner {
  constructor(
    private readonly client: BrokerClient,
    private readonly programs: Readonly<Record<string, SpawnProgram>>,
  ) {}

  killAll(): number {
    return this.client.closeAll();
  }

  async run(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
    const started = Date.now();
    const base: ExecResult = { exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, durationMs: 0 };
    const program = Object.hasOwn(this.programs, cmd) ? this.programs[cmd] : undefined;
    if (!program) return { ...base, spawnError: `${cmd} cannot be run through the executor` };

    const env: SpawnRequest["env"] = {};
    for (const key of SPAWN_ENV_KEYS) {
      const value = opts.env?.[key];
      if (typeof value === "string") env[key] = value;
    }
    const req: SpawnRequest = {
      v: 1,
      type: "spawn",
      program,
      args,
      cwd: opts.cwd,
      input: opts.input ?? "",
      env,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      captureFile: opts.captureFile === true,
    };

    const max = opts.maxOutputChars ?? 20_000;
    let stdout = "";
    let stderr = "";
    try {
      const exit = await this.client.spawn(
        req,
        (e) => {
          if (e.type !== "out") return;
          if (e.stream === "stdout") stdout = tail(stdout + e.data, max);
          else stderr = tail(stderr + e.data, max);
          opts.onOutput?.(e.stream, e.data);
        },
        opts.signal,
      );
      return {
        exitCode: exit.exitCode,
        signal: exit.signal as NodeJS.Signals | null,
        stdout,
        stderr,
        timedOut: exit.timedOut,
        aborted: opts.signal?.aborted === true,
        durationMs: exit.durationMs,
        spawnError: exit.spawnError,
        captured: exit.captured,
      };
    } catch (err) {
      return { ...base, stdout, stderr, aborted: opts.signal?.aborted === true, durationMs: Date.now() - started, spawnError: err instanceof Error ? err.message : String(err) };
    }
  }
}
