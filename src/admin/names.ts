/**
 * Strict name formats for admin targets. Every pattern is anchored, length-capped and
 * excludes whitespace, quotes and shell metacharacters, so a value that passes can never
 * be read as shell syntax or as an extra command-line option (no leading "-").
 */
export const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,127}\.(?:service|socket|timer|target)$/;
export const PM2_APP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
export const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{0,63}$/;
/** Deployment target ids, as registered in the executor's root-owned deployment definitions (IDE-82). */
export const DEPLOY_TARGET_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A full Git commit id. Deployments always name the exact commit; branch names and short ids are refused. */
export const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Restarting these from within Beast is refused outright; no approval can override it. */
export const REFUSED_RESTART_UNITS: readonly string[] = [
  "beast-api.service",
  "beast-executor.service",
  "beast-executor.socket",
];
export const REFUSED_RESTART_PM2_APPS: readonly string[] = ["beast-api", "beast-executor"];

/** Approved protected services: restarting them is class C. Matched on the unit's base name. */
export const PROTECTED_SERVICES: readonly string[] = [
  "ssh",
  "sshd",
  "systemd-*",
  "dbus",
  "ufw",
  "cron",
  "polkit",
  "networking",
  "systemd-networkd",
  "systemd-resolved",
  // Restart only; `nginx.reload` stays class B.
  "nginx",
];

function unitBase(unit: string): string {
  return unit.replace(/\.(?:service|socket|timer|target)$/, "").replace(/@.*$/, "");
}

function matchesName(name: string, pattern: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

export function isProtectedService(unit: string, extra: readonly string[] = []): boolean {
  const base = unitBase(unit);
  return [...PROTECTED_SERVICES, ...extra].some((p) => matchesName(base, p));
}

export function isRefusedRestartUnit(unit: string): boolean {
  return REFUSED_RESTART_UNITS.includes(unit) || ["beast-api", "beast-executor"].includes(unitBase(unit));
}
