import { isProtectedPath, type ProtectionContext } from "./paths.js";
import { isProtectedService, isRefusedRestartUnit, REFUSED_RESTART_PM2_APPS } from "./names.js";
import type { OperationParams, RiskClass } from "./types.js";

/**
 * Parameter types. There is deliberately no free-form string or argument-list type:
 * every value is a strictly formatted name, a canonical path, a bounded integer, a
 * boolean or a member of a fixed enum.
 */
export type ParamSpec = { optional?: boolean } & (
  | { type: "unit" }
  | { type: "pm2App" }
  | { type: "path" }
  | { type: "user" }
  | { type: "group" }
  | { type: "package" }
  | { type: "deployTarget" }
  | { type: "commit" }
  | { type: "int"; min: number; max: number }
  | { type: "bool" }
  | { type: "enum"; values: readonly string[] }
);

export interface Classification {
  riskClass: RiskClass;
  protected: boolean;
}

export interface OperationDefinition {
  readonly id: string;
  readonly version: number;
  readonly description: string;
  readonly params: Readonly<Record<string, ParamSpec>>;
  /** Cross-field rules and hard denies. Returns a denial reason. */
  check?(params: OperationParams): string | undefined;
  classify(params: OperationParams, ctx: ProtectionContext): Classification;
  /** One-line human description used in plans, audit and Linear comments. */
  summarize(params: OperationParams): string;
}

const fixed = (riskClass: RiskClass) => () => ({ riskClass, protected: false });

const DEFINITIONS: OperationDefinition[] = [
  {
    id: "service.status",
    version: 1,
    description: "Show the state of a systemd unit",
    params: { unit: { type: "unit" } },
    classify: fixed("A"),
    summarize: (p) => `show status of systemd unit ${p.unit}`,
  },
  {
    id: "service.restart",
    version: 1,
    description: "Restart a systemd unit (protected services need exact approval)",
    params: { unit: { type: "unit" } },
    check: (p) => (isRefusedRestartUnit(String(p.unit)) ? `restarting ${p.unit} from within Beast is refused` : undefined),
    classify: (p, ctx) => {
      const prot = isProtectedService(String(p.unit), ctx.extraProtectedServices);
      return { riskClass: prot ? "C" : "B", protected: prot };
    },
    summarize: (p) => `restart systemd unit ${p.unit}`,
  },
  {
    id: "pm2.status",
    version: 1,
    description: "Show PM2 process status (one app or all)",
    params: { app: { type: "pm2App", optional: true } },
    classify: fixed("A"),
    summarize: (p) => (p.app ? `show PM2 status of ${p.app}` : "show PM2 status of all apps"),
  },
  {
    id: "pm2.restart",
    version: 1,
    description: "Restart a PM2 app",
    params: { app: { type: "pm2App" } },
    check: (p) => (REFUSED_RESTART_PM2_APPS.includes(String(p.app)) ? `restarting ${p.app} from within Beast is refused` : undefined),
    classify: fixed("B"),
    summarize: (p) => `restart PM2 app ${p.app}`,
  },
  {
    id: "nginx.test",
    version: 1,
    description: "Test the Nginx configuration (nginx -t)",
    params: {},
    classify: fixed("A"),
    summarize: () => "test the Nginx configuration",
  },
  {
    id: "nginx.reload",
    version: 1,
    description: "Reload Nginx, only after its configuration test passes",
    params: {},
    classify: fixed("B"),
    summarize: () => "test the Nginx configuration, then reload Nginx if the test passes",
  },
  {
    id: "system.logs",
    version: 1,
    description: "Read recent log lines from a systemd unit, PM2 app or Nginx (always redacted)",
    params: {
      unit: { type: "unit", optional: true },
      app: { type: "pm2App", optional: true },
      nginx: { type: "enum", values: ["access", "error"], optional: true },
      lines: { type: "int", min: 1, max: 500 },
    },
    check: (p) =>
      ["unit", "app", "nginx"].filter((k) => p[k] !== undefined).length === 1
        ? undefined
        : "system.logs needs exactly one of unit, app or nginx",
    classify: fixed("A"),
    summarize: (p) =>
      `read the last ${p.lines} log lines of ${p.unit ? `systemd unit ${p.unit}` : p.app ? `PM2 app ${p.app}` : `Nginx ${p.nginx} log`}`,
  },
  {
    id: "package.inspect",
    version: 1,
    description: "Show the installed state and version of a Debian package",
    params: { name: { type: "package" } },
    classify: fixed("A"),
    summarize: (p) => `inspect package ${p.name}`,
  },
  {
    id: "filesystem.inspect",
    version: 1,
    description: "Show metadata of a path (type, owner, group, mode, size); never file contents",
    params: { path: { type: "path" } },
    classify: fixed("A"),
    summarize: (p) => `inspect metadata of ${p.path}`,
  },
  {
    id: "filesystem.chown",
    version: 1,
    description: "Change the owner and group of a path, optionally recursively (never follows symlinks)",
    params: {
      path: { type: "path" },
      owner: { type: "user" },
      group: { type: "group" },
      recursive: { type: "bool" },
    },
    classify: (p, ctx) => ({ riskClass: "C", protected: isProtectedPath(String(p.path), ctx, p.recursive === true) }),
    summarize: (p) => `${p.recursive ? "recursively " : ""}change owner of ${p.path} to ${p.owner}:${p.group}`,
  },
  // ---- Production deployment (IDE-82) ----
  // Targets and their procedures are defined only in the executor's root-owned deployment
  // file; a ticket can name a target and an exact commit, nothing else. Every deployment
  // and rollback is class C, so each one needs its own exact approval.
  {
    id: "deploy.status",
    version: 1,
    description: "Show a deployment target's definition, deployed commit, PM2 state and health",
    params: { target: { type: "deployTarget" } },
    classify: fixed("A"),
    summarize: (p) => `show deployment status of ${p.target}`,
  },
  {
    id: "deploy.run",
    version: 1,
    description: "Deploy an exact commit to a registered deployment target (verify, deploy, health check, automatic rollback)",
    params: { target: { type: "deployTarget" }, commit: { type: "commit" } },
    classify: fixed("C"),
    summarize: (p) => `deploy commit ${p.commit} to ${p.target}`,
  },
  {
    id: "deploy.rollback",
    version: 1,
    description: "Roll a deployment target back to the commit that preceded Beast's last deployment of it",
    params: { target: { type: "deployTarget" } },
    classify: fixed("C"),
    summarize: (p) => `roll back ${p.target} to the commit before its last Beast deployment`,
  },
];

const REGISTRY: ReadonlyMap<string, OperationDefinition> = new Map(
  DEFINITIONS.map((d) => [d.id, Object.freeze({ ...d, params: Object.freeze({ ...d.params }) })]),
);

export function getOperation(id: string): OperationDefinition | undefined {
  return REGISTRY.get(id);
}

export function operationIds(): string[] {
  return [...REGISTRY.keys()];
}

