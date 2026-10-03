import fs from "node:fs/promises";
import { minimalEnv, runCommand } from "../util/exec.js";

/**
 * Unprivileged, read-only host lookups used during validation, before any privilege
 * escalation. Every method fails closed: an error is reported as "unknown", and the
 * validator denies the request.
 */
export interface UnitInfo {
  loadState: string;
  fragmentPath: string;
}

export interface Pm2App {
  name: string;
  execPath: string;
}

export interface PathInfo {
  type: "file" | "directory" | "symlink" | "other";
  dev: string;
  ino: string;
  uid: number;
  gid: number;
  mode: string;
}

export type LstatResult = PathInfo | "missing" | "denied";

/** What a deployment-target probe is asked about (IDE-82). `commit` only for deploy.run. */
export interface DeploymentQuery {
  op: string;
  target: string;
  commit?: string;
}

/**
 * The executor's answer. `facts` describe the target's definition and live state; they are
 * shown in the approval plan, bound into its digest and re-checked before execution.
 */
export type DeploymentProbe =
  | { ok: true; facts: Record<string, string> }
  | { ok: false; code: "unsupported_target" | "uncertain"; reason: string };

export interface HostProbe {
  unit(name: string): Promise<UnitInfo | null>;
  pm2Apps(): Promise<Pm2App[] | null>;
  userId(name: string): Promise<number | null>;
  groupId(name: string): Promise<number | null>;
  lstat(p: string): Promise<LstatResult>;
  /** Null means the target could not be inspected (deny). */
  deployment(q: DeploymentQuery): Promise<DeploymentProbe | null>;
}

const PROBE_TIMEOUT_MS = 10_000;

async function probe(cmd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, maxOutputChars = 20_000) {
  const res = await runCommand(cmd, args, {
    cwd: "/",
    env: minimalEnv(extraEnv),
    timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputChars,
  });
  return res.exitCode === 0 && !res.timedOut && !res.spawnError ? res.stdout : null;
}

function getentId(stdout: string | null, name: string): number | null {
  const fields = stdout?.trim().split(":");
  if (!fields || fields[0] !== name || fields.length < 3) return null;
  const id = Number(fields[2]);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

export async function lstatPath(p: string): Promise<LstatResult> {
  try {
    const st = await fs.lstat(p, { bigint: true });
    return {
      type: st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : st.isFile() ? "file" : "other",
      dev: st.dev.toString(),
      ino: st.ino.toString(),
      uid: Number(st.uid),
      gid: Number(st.gid),
      mode: (Number(st.mode) & 0o7777).toString(8).padStart(4, "0"),
    };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "denied";
  }
}

export class SystemHostProbe implements HostProbe {
  async unit(name: string): Promise<UnitInfo | null> {
    const out = await probe("systemctl", ["show", "--property=LoadState", "--property=FragmentPath", "--", name]);
    if (out === null) return null;
    const props = Object.fromEntries(
      out
        .split("\n")
        .map((l) => l.split("="))
        .filter((kv) => kv.length >= 2)
        .map(([k, ...v]) => [k, v.join("=")]),
    );
    return typeof props.LoadState === "string" ? { loadState: props.LoadState, fragmentPath: props.FragmentPath ?? "" } : null;
  }

  async pm2Apps(): Promise<Pm2App[] | null> {
    // `pm2 jlist` includes each app's environment. Only the name and script path are kept;
    // the raw output is never logged or stored.
    const out = await probe("pm2", ["jlist"], { HOME: process.env.HOME }, 5_000_000);
    if (out === null) return null;
    try {
      const list = JSON.parse(out) as { name?: unknown; pm2_env?: { pm_exec_path?: unknown } }[];
      if (!Array.isArray(list)) return null;
      return list
        .filter((p) => typeof p.name === "string")
        .map((p) => ({ name: p.name as string, execPath: typeof p.pm2_env?.pm_exec_path === "string" ? p.pm2_env.pm_exec_path : "" }));
    } catch {
      return null;
    }
  }

  async userId(name: string): Promise<number | null> {
    return getentId(await probe("getent", ["passwd", "--", name]), name);
  }

  async groupId(name: string): Promise<number | null> {
    return getentId(await probe("getent", ["group", "--", name]), name);
  }

  lstat(p: string): Promise<LstatResult> {
    return lstatPath(p);
  }

  async deployment(): Promise<DeploymentProbe> {
    // Deployment definitions and checkouts are only visible to the privileged executor.
    return { ok: false, code: "uncertain", reason: "deployment targets can only be inspected through beast-executor" };
  }
}

/**
 * Probe through the root broker. Used when Beast API runs as its own unprivileged user,
 * which can see neither the PM2 daemon nor most paths on the host. The broker answers
 * only these fixed read-only lookups.
 */
export class BrokerHostProbe implements HostProbe {
  constructor(private readonly broker: { request<T = unknown>(msg: import("./protocol.js").ProbeRequest): Promise<T> }) {}

  private async ask<T>(msg: import("./protocol.js").ProbeRequest, fallback: T): Promise<T> {
    try {
      const reply = await this.broker.request<{ type: string; value: T }>(msg);
      return reply.type === "probe" ? reply.value : fallback;
    } catch {
      return fallback;
    }
  }

  unit(name: string): Promise<UnitInfo | null> {
    return this.ask({ v: 1, type: "probe", what: "unit", name }, null);
  }
  pm2Apps(): Promise<Pm2App[] | null> {
    return this.ask({ v: 1, type: "probe", what: "pm2Apps" }, null);
  }
  userId(name: string): Promise<number | null> {
    return this.ask({ v: 1, type: "probe", what: "userId", name }, null);
  }
  groupId(name: string): Promise<number | null> {
    return this.ask({ v: 1, type: "probe", what: "groupId", name }, null);
  }
  lstat(p: string): Promise<LstatResult> {
    // "denied" makes the validator report the path as unverifiable (fail closed).
    return this.ask<LstatResult>({ v: 1, type: "probe", what: "lstat", path: p }, "denied");
  }
  deployment(q: DeploymentQuery): Promise<DeploymentProbe | null> {
    return this.ask<DeploymentProbe | null>({ v: 1, type: "probe", what: "deployment", ...q }, null);
  }
}
