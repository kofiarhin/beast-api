import fs from "node:fs";
import path from "node:path";
import { CAPTURE_FILE_TOKEN, type SpawnEvent, type SpawnRequest } from "../admin/protocol.js";
import { SAFE_PATH } from "./config.js";
import type { Account, BrokerHost } from "./host.js";
import { startProc } from "./proc.js";

/**
 * Start one agent / verification / Git process as the unprivileged agent user. The
 * process never runs as root: setpriv drops to the agent's uid/gid, clears every
 * capability and sets no-new-privs before the program is executed. The environment is
 * built here from scratch; the client can only set a few harmless variables.
 */
export const MAX_CAPTURE_BYTES = 256 * 1024;

export interface SpawnHandle {
  done: Promise<void>;
  stop(): void;
}

function cwdProblem(cwd: string): string | undefined {
  try {
    if (fs.realpathSync(cwd) !== cwd) return `${cwd} contains a symlink`;
    if (!fs.statSync(cwd).isDirectory()) return `${cwd} is not a directory`;
  } catch {
    return `${cwd} does not exist`;
  }
  return undefined;
}

/** Read the capture file only if it is a plain, single-link file owned by the agent. */
function readCapture(file: string, agent: Account): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== agent.uid || st.nlink !== 1 || st.size > MAX_CAPTURE_BYTES) return undefined;
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return buf.toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export async function startSpawn(req: SpawnRequest, host: BrokerHost, send: (e: SpawnEvent) => void): Promise<SpawnHandle> {
  const cfg = host.cfg;
  const fail = (spawnError: string): SpawnHandle => {
    send({ type: "exit", exitCode: null, signal: null, timedOut: false, durationMs: 0, spawnError });
    return { done: Promise.resolve(), stop: () => undefined };
  };

  const agent = await host.account(cfg.agentUser);
  if (!agent) return fail(`agent account ${cfg.agentUser} is not available`);
  const bad = cwdProblem(req.cwd);
  if (bad) return fail(`spawn ${req.program} ENOENT (${bad})`);

  let captureDir: string | undefined;
  let args = req.args;
  if (req.captureFile) {
    const base = path.join(cfg.stateDir, "capture");
    fs.mkdirSync(base, { recursive: true, mode: 0o711 });
    captureDir = fs.mkdtempSync(path.join(base, "run-"));
    fs.chownSync(captureDir, agent.uid, agent.gid);
    fs.chmodSync(captureDir, 0o700);
    const file = path.join(captureDir, "out");
    args = args.map((a) => (a === CAPTURE_FILE_TOKEN ? file : a));
  }

  const env: NodeJS.ProcessEnv = {
    HOME: agent.home,
    USER: agent.name,
    LOGNAME: agent.name,
    SHELL: "/bin/bash",
    PATH: SAFE_PATH,
    LANG: "C.UTF-8",
    ...req.env,
  };
  const [bin, argv] = host.dropTo(agent, cfg.programs[req.program], args);
  const handle = startProc(bin, argv, {
    cwd: req.cwd,
    env,
    timeoutMs: req.timeoutMs,
    input: req.input,
    maxOutputChars: 1, // streamed to the client; nothing needs to be kept here
    onOutput: (stream, data) => send({ type: "out", stream, data }),
  });

  const done = handle.result.then((r) => {
    let captured: string | undefined;
    if (captureDir) {
      captured = readCapture(path.join(captureDir, "out"), agent);
      fs.rmSync(captureDir, { recursive: true, force: true });
    }
    send({ type: "exit", exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, durationMs: r.durationMs, spawnError: r.spawnError, captured });
  });
  return { done, stop: handle.stop };
}
