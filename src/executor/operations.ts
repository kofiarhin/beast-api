import fs from "node:fs";
import path from "node:path";
import { lstatPath } from "../admin/probe.js";
import type { ValidatedOperation } from "../admin/validate.js";
import { deploymentStatus, rollbackDeployment, runDeployment } from "./deploy.js";
import type { BrokerHost } from "./host.js";

/**
 * Root implementations of the typed admin operations. Each one maps validated params to a
 * fixed program and argument vector (or a direct syscall); none of them builds a command
 * string. Results are raw here and sanitized (redacted, bounded) by the broker.
 */
export interface RawResult {
  status: "succeeded" | "failed" | "denied";
  fields?: Record<string, string | number | boolean>;
  output?: string;
  reason?: string;
}

const OP_TIMEOUT_MS = 60_000;
const RESTART_TIMEOUT_MS = 120_000;
/** Recursive chown refuses trees larger than this rather than running unbounded. */
export const MAX_CHOWN_ENTRIES = 200_000;

const outcome = (ok: boolean, extra: Omit<RawResult, "status"> = {}): RawResult => ({ status: ok ? "succeeded" : "failed", ...extra });
const procText = (r: { stdout: string; stderr: string }) => (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim();

function pm2Name(app: string): string | undefined {
  // PM2 reads all-digit names as process ids and "all" as every app; neither is allowed.
  return /^\d+$/.test(app) || app === "all" ? undefined : app;
}

async function chown(op: ValidatedOperation, host: BrokerHost): Promise<RawResult> {
  const target = String(op.params.path);
  const recursive = op.params.recursive === true;
  const uid = await host.userId(String(op.params.owner));
  const gid = await host.groupId(String(op.params.group));
  if (uid === null || gid === null) return { status: "denied", reason: "owner or group no longer exists" };
  if (String(uid) !== op.facts["owner.uid"] || String(gid) !== op.facts["group.gid"]) {
    return { status: "denied", reason: "owner or group id changed since validation" };
  }

  // Re-check the exact approved object immediately before changing it.
  const st = await lstatPath(target);
  if (typeof st === "string" || st.type === "symlink" || st.dev !== op.facts["path.dev"] || st.ino !== op.facts["path.ino"]) {
    return { status: "denied", reason: "target changed since validation (missing, symlink, or different inode)" };
  }

  if (!recursive) {
    fs.lchownSync(target, uid, gid);
    return outcome(true, { fields: { changed: 1, recursive: false, uid, gid } });
  }

  // Depth-first walk. Symlinks are never followed or changed, and the walk never leaves
  // the target's filesystem.
  const rootDev = BigInt(st.dev);
  let changed = 0;
  let symlinksSkipped = 0;
  let otherFsSkipped = 0;
  const stack = [target];
  while (stack.length) {
    const p = stack.pop()!;
    const s = fs.lstatSync(p, { bigint: true });
    if (s.isSymbolicLink()) {
      symlinksSkipped++;
      continue;
    }
    if (s.dev !== rootDev) {
      otherFsSkipped++;
      continue;
    }
    if (++changed > MAX_CHOWN_ENTRIES) {
      return { status: "failed", reason: `tree has more than ${MAX_CHOWN_ENTRIES} entries; stopped partway`, fields: { changed: changed - 1 } };
    }
    fs.lchownSync(p, uid, gid);
    if (s.isDirectory()) {
      const before = s.ino;
      const names = fs.readdirSync(p);
      // A directory swapped for a symlink between lstat and readdir is not descended into.
      const again = fs.lstatSync(p, { bigint: true });
      if (again.isSymbolicLink() || again.ino !== before) {
        return { status: "failed", reason: `${p} changed during the walk; stopped`, fields: { changed } };
      }
      for (const name of names) stack.push(path.join(p, name));
    }
  }
  return outcome(true, { fields: { changed, symlinksSkipped, otherFilesystemsSkipped: otherFsSkipped, recursive: true, uid, gid } });
}

async function logs(op: ValidatedOperation, host: BrokerHost): Promise<RawResult> {
  const lines = String(op.params.lines);
  const cfg = host.cfg;
  if (op.params.unit !== undefined) {
    const r = await host.run(cfg.bins.journalctl, [`--unit=${op.params.unit}`, `--lines=${lines}`, "--no-pager", "--output=short-iso"], OP_TIMEOUT_MS, 256_000);
    return outcome(r.exitCode === 0, { output: r.stdout, reason: r.exitCode === 0 ? undefined : r.stderr.trim() });
  }
  if (op.params.nginx !== undefined) {
    const file = op.params.nginx === "access" ? cfg.nginxLogs.access : cfg.nginxLogs.error;
    const r = await host.run(cfg.bins.tail, ["-n", lines, "--", file], OP_TIMEOUT_MS, 256_000);
    return outcome(r.exitCode === 0, { output: r.stdout, reason: r.exitCode === 0 ? undefined : r.stderr.trim() });
  }
  // PM2 app logs are read as the PM2 owner, so a log path in PM2's config can never make
  // root read an arbitrary file.
  const app = (await host.pm2List())?.find((p) => p.name === op.params.app);
  if (!app) return { status: "failed", reason: "PM2 app not found" };
  const owner = await host.account(cfg.pm2User);
  if (!owner) return { status: "failed", reason: "PM2 owner account not found" };
  const parts: string[] = [];
  for (const [label, file] of [["out", app.outLog], ["err", app.errLog]] as const) {
    if (!file.startsWith("/")) continue;
    const [bin, argv] = host.dropTo(owner, cfg.bins.tail, ["-n", lines, "--", file]);
    const r = await host.run(bin, argv, OP_TIMEOUT_MS, 256_000);
    parts.push(`==> ${label} <==\n${r.exitCode === 0 ? r.stdout : `(unreadable: exit ${r.exitCode})`}`);
  }
  return outcome(true, { output: parts.join("\n") });
}

async function pm2Status(op: ValidatedOperation, host: BrokerHost): Promise<RawResult> {
  const list = await host.pm2List();
  if (!list) return { status: "failed", reason: "could not query PM2" };
  const rows = list.filter((p) => op.params.app === undefined || p.name === op.params.app);
  const output = rows
    .map((p) => `${p.name}\tstatus=${p.status}\tpid=${p.pid}\trestarts=${p.restarts}\tsince=${p.uptimeSince ? new Date(p.uptimeSince).toISOString() : "-"}`)
    .join("\n");
  const fields: Record<string, string | number> = { apps: rows.length };
  if (rows.length === 1) Object.assign(fields, { status: rows[0]!.status, pid: rows[0]!.pid, restarts: rows[0]!.restarts });
  return outcome(true, { fields, output });
}

export async function performOperation(op: ValidatedOperation, host: BrokerHost): Promise<RawResult> {
  const b = host.cfg.bins;
  switch (op.op) {
    case "service.status": {
      const u = await host.unit(String(op.params.unit));
      if (!u) return { status: "failed", reason: "could not query systemd" };
      return outcome(true, {
        fields: { loadState: u.loadState, activeState: u.ActiveState ?? "", subState: u.SubState ?? "", mainPid: Number(u.MainPID ?? 0), since: u.ActiveEnterTimestamp ?? "" },
      });
    }
    case "service.restart": {
      const unit = String(op.params.unit);
      const r = await host.run(b.systemctl, ["restart", "--", unit], RESTART_TIMEOUT_MS);
      const u = await host.unit(unit);
      return outcome(r.exitCode === 0, {
        fields: { activeState: u?.ActiveState ?? "unknown", subState: u?.SubState ?? "unknown" },
        reason: r.exitCode === 0 ? undefined : r.stderr.trim() || `systemctl exited ${r.exitCode}`,
      });
    }
    case "pm2.status":
      return pm2Status(op, host);
    case "pm2.restart": {
      const app = pm2Name(String(op.params.app));
      if (!app) return { status: "denied", reason: "PM2 app names that are numeric or 'all' are not accepted" };
      const r = await host.pm2(["restart", app], RESTART_TIMEOUT_MS, 64_000);
      if (!r) return { status: "failed", reason: "PM2 owner account not found" };
      const after = (await host.pm2List())?.find((p) => p.name === app);
      return outcome(r.exitCode === 0, {
        fields: { status: after?.status ?? "unknown", restarts: after?.restarts ?? -1 },
        reason: r.exitCode === 0 ? undefined : `pm2 exited ${r.exitCode}`,
      });
    }
    case "nginx.test": {
      const r = await host.run(b.nginx, ["-t"], OP_TIMEOUT_MS);
      return outcome(r.exitCode === 0, { output: procText(r), fields: { configValid: r.exitCode === 0 } });
    }
    case "nginx.reload": {
      const t = await host.run(b.nginx, ["-t"], OP_TIMEOUT_MS);
      if (t.exitCode !== 0) return { status: "failed", reason: "nginx configuration test failed; not reloaded", output: procText(t), fields: { configValid: false, reloaded: false } };
      const r = await host.run(b.systemctl, ["reload", "--", "nginx.service"], RESTART_TIMEOUT_MS);
      return outcome(r.exitCode === 0, { fields: { configValid: true, reloaded: r.exitCode === 0 }, reason: r.exitCode === 0 ? undefined : r.stderr.trim() });
    }
    case "system.logs":
      return logs(op, host);
    case "package.inspect": {
      const r = await host.run(b.dpkgQuery, ["-W", "-f=${db:Status-Abbrev}|${Version}", "--", String(op.params.name)]);
      if (r.exitCode !== 0) return outcome(true, { fields: { installed: false } });
      const [status = "", version = ""] = r.stdout.split("|");
      return outcome(true, { fields: { installed: status.startsWith("ii"), status: status.trim(), version: version.trim() } });
    }
    case "filesystem.inspect": {
      const st = await lstatPath(String(op.params.path));
      if (typeof st === "string") return { status: "failed", reason: `path is ${st}` };
      return outcome(true, { fields: { type: st.type, uid: st.uid, gid: st.gid, mode: st.mode, dev: st.dev, ino: st.ino } });
    }
    case "filesystem.chown":
      return chown(op, host);
    case "deploy.status":
      return deploymentStatus(op, host);
    case "deploy.run":
      return runDeployment(op, host);
    case "deploy.rollback":
      return rollbackDeployment(op, host);
    default:
      return { status: "denied", reason: `operation ${op.op} has no executor implementation` };
  }
}
