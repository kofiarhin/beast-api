import { lstatPath, type HostProbe, type LstatResult, type Pm2App, type UnitInfo } from "../admin/probe.js";
import { probeDeployment } from "./deploy.js";
import { SAFE_PATH, type BrokerConfig } from "./config.js";
import { runProc } from "./proc.js";

/**
 * Root-side host access for the broker: read-only lookups, plus the fixed way to run a
 * program as another (unprivileged) account. Every program path is absolute and fixed.
 */
const PROBE_TIMEOUT_MS = 15_000;

export interface Account {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

export interface Pm2Process {
  name: string;
  execPath: string;
  cwd: string;
  status: string;
  pid: number;
  restarts: number;
  uptimeSince: number | null;
  outLog: string;
  errLog: string;
}

const baseEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: SAFE_PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...extra });

export class BrokerHost {
  constructor(readonly cfg: BrokerConfig) {}

  /** Run a fixed program as root. */
  async run(file: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS, maxOutputChars = 64_000) {
    return runProc(file, args, { env: baseEnv(), timeoutMs, maxOutputChars });
  }

  /** setpriv argv that drops to `account` with no capabilities and no-new-privs before exec. */
  dropTo(account: Account, file: string, args: readonly string[]): [string, string[]] {
    return [
      this.cfg.bins.setpriv,
      [
        `--reuid=${account.uid}`,
        `--regid=${account.gid}`,
        "--init-groups",
        "--no-new-privs",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--",
        file,
        ...args,
      ],
    ];
  }

  async account(name: string): Promise<Account | null> {
    const res = await this.run(this.cfg.bins.getent, ["passwd", "--", name]);
    const f = res.exitCode === 0 ? res.stdout.trim().split(":") : [];
    if (f.length < 7 || f[0] !== name) return null;
    const uid = Number(f[2]);
    const gid = Number(f[3]);
    if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0) return null;
    return { name, uid, gid, home: f[5]! };
  }

  async groupId(name: string): Promise<number | null> {
    const res = await this.run(this.cfg.bins.getent, ["group", "--", name]);
    const f = res.exitCode === 0 ? res.stdout.trim().split(":") : [];
    const id = Number(f[2]);
    return f[0] === name && Number.isInteger(id) && id >= 0 ? id : null;
  }

  async userId(name: string): Promise<number | null> {
    const res = await this.run(this.cfg.bins.getent, ["passwd", "--", name]);
    const f = res.exitCode === 0 ? res.stdout.trim().split(":") : [];
    const id = Number(f[2]);
    return f[0] === name && Number.isInteger(id) && id >= 0 ? id : null;
  }

  async unit(name: string): Promise<(UnitInfo & Record<string, string>) | null> {
    const res = await this.run(this.cfg.bins.systemctl, [
      "show",
      "--property=LoadState",
      "--property=FragmentPath",
      "--property=ActiveState",
      "--property=SubState",
      "--property=MainPID",
      "--property=ActiveEnterTimestamp",
      "--",
      name,
    ]);
    if (res.exitCode !== 0) return null;
    const props: Record<string, string> = {};
    for (const line of res.stdout.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return typeof props.LoadState === "string" ? { ...props, loadState: props.LoadState, fragmentPath: props.FragmentPath ?? "" } : null;
  }

  /** Run a PM2 CLI command as the PM2 owner (never as root, so root never starts a second PM2 daemon). */
  async pm2(args: string[], timeoutMs = PROBE_TIMEOUT_MS, maxOutputChars = 5_000_000) {
    const owner = await this.account(this.cfg.pm2User);
    if (!owner) return null;
    const [file, argv] = this.dropTo(owner, this.cfg.bins.pm2, args);
    return runProc(file, argv, {
      env: baseEnv({ HOME: owner.home, PM2_HOME: `${owner.home}/.pm2` }),
      timeoutMs,
      maxOutputChars,
    });
  }

  /** `pm2 jlist`, reduced to non-secret fields. The raw output (with app environments) is never kept. */
  async pm2List(): Promise<Pm2Process[] | null> {
    const res = await this.pm2(["jlist"]);
    if (!res || res.exitCode !== 0 || res.timedOut) return null;
    try {
      const list = JSON.parse(res.stdout) as Array<{ name?: unknown; pid?: unknown; pm2_env?: Record<string, unknown> }>;
      if (!Array.isArray(list)) return null;
      return list
        .filter((p) => typeof p.name === "string")
        .map((p) => {
          const e = p.pm2_env ?? {};
          const str = (v: unknown) => (typeof v === "string" ? v : "");
          return {
            name: p.name as string,
            execPath: str(e.pm_exec_path),
            cwd: str(e.pm_cwd),
            status: str(e.status),
            pid: typeof p.pid === "number" ? p.pid : 0,
            restarts: typeof e.restart_time === "number" ? e.restart_time : 0,
            uptimeSince: typeof e.pm_uptime === "number" ? e.pm_uptime : null,
            outLog: str(e.pm_out_log_path),
            errLog: str(e.pm_err_log_path),
          };
        });
    } catch {
      return null;
    }
  }

  /** HostProbe view used by the shared validator, both broker-side and (via probe requests) in Beast API. */
  probe(): HostProbe {
    return {
      unit: (name) => this.unit(name).then((u) => (u ? { loadState: u.loadState, fragmentPath: u.fragmentPath } : null)),
      pm2Apps: async (): Promise<Pm2App[] | null> => (await this.pm2List())?.map((p) => ({ name: p.name, execPath: p.execPath })) ?? null,
      userId: (name) => this.userId(name),
      groupId: (name) => this.groupId(name),
      lstat: (p): Promise<LstatResult> => lstatPath(p),
      deployment: (q) => probeDeployment(this, q),
    };
  }
}
