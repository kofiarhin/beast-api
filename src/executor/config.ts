import { WORKSPACE_ROOT } from "../config.js";
import type { SpawnProgram } from "../admin/protocol.js";

/**
 * Broker configuration. Everything security-relevant is fixed here or comes from the
 * root-owned systemd unit; nothing is taken from a client request.
 */
export interface BrokerConfig {
  policyFile: string;
  stateDir: string;
  workspaceRoot: string;
  /** Unprivileged user that agents, verification scripts and Git run as. */
  agentUser: string;
  /** Owner of the PM2 daemon whose apps the pm2.* operations manage. */
  pm2User: string;
  programs: Readonly<Record<SpawnProgram, string>>;
  bins: Readonly<{
    setpriv: string;
    systemctl: string;
    journalctl: string;
    nginx: string;
    dpkgQuery: string;
    getent: string;
    pm2: string;
    tail: string;
  }>;
  nginxLogs: Readonly<{ access: string; error: string }>;
  /** Beast's own code, data, policy and executor locations: always protected. */
  beastPaths: readonly string[];
}

export const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin";

export function loadBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const get = (name: string, fallback: string) => env[name]?.trim() || fallback;
  return Object.freeze({
    policyFile: get("BEAST_EXECUTOR_POLICY", "/etc/beast-executor/policy.json"),
    stateDir: get("BEAST_EXECUTOR_STATE_DIR", "/var/lib/beast-executor"),
    workspaceRoot: WORKSPACE_ROOT,
    agentUser: get("BEAST_EXECUTOR_AGENT_USER", "beast-agent"),
    pm2User: get("BEAST_EXECUTOR_PM2_USER", "ubuntu"),
    programs: Object.freeze({
      claude: get("BEAST_EXECUTOR_CLAUDE_BIN", "/usr/bin/claude"),
      codex: get("BEAST_EXECUTOR_CODEX_BIN", "/usr/bin/codex"),
      npm: "/usr/bin/npm",
      git: "/usr/bin/git",
    }),
    bins: Object.freeze({
      setpriv: "/usr/bin/setpriv",
      systemctl: "/usr/bin/systemctl",
      journalctl: "/usr/bin/journalctl",
      nginx: "/usr/sbin/nginx",
      dpkgQuery: "/usr/bin/dpkg-query",
      getent: "/usr/bin/getent",
      pm2: "/usr/bin/pm2",
      tail: "/usr/bin/tail",
    }),
    nginxLogs: Object.freeze({ access: "/var/log/nginx/access.log", error: "/var/log/nginx/error.log" }),
    beastPaths: Object.freeze([
      "/home/ubuntu/apps/beast-api",
      "/var/lib/beast-api",
      "/etc/beast-api",
      "/etc/beast-executor",
      "/opt/beast-executor",
      "/var/lib/beast-executor",
    ]),
  });
}
