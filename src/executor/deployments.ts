import fs from "node:fs";
import { canonicalJSON, sha256 } from "../admin/digest.js";
import { DEPLOY_TARGET_NAME, PM2_APP_NAME, REFUSED_RESTART_PM2_APPS } from "../admin/names.js";
import { checkPathSyntax, isProtectedPath, isUnder } from "../admin/paths.js";

/**
 * Production deployment definitions (IDE-82). They live only in a root-owned file read by
 * the executor; a ticket can name a target id and an exact commit, nothing else. Every
 * field is a fixed enum, a strictly formatted name or a canonical path, so a definition
 * can never carry a command string. npm script names are run as `npm run <name>`.
 */
export type DeployMechanism = "pm2-git";

export interface DeploymentDefinition {
  id: string;
  /** Human project name, shown in plans. */
  project: string;
  /** True for a real production application; false for an isolated test target. */
  production: boolean;
  /** `pm2-git`: a Git checkout run by a PM2 app owned by the PM2 user. */
  mechanism: DeployMechanism;
  /** Where approved commits come from: a Git workspace under the workspace root, and the branch they must be on. */
  source: { workspace: string; branch: string };
  /** The production checkout and the PM2 app that runs it. */
  target: { checkout: string; pm2App: string };
  /** `npm-ci` installs dependencies (verification clone and target) with `npm ci`. */
  install: "npm-ci" | "none";
  /** npm scripts run in an isolated clone of the exact commit, as the agent user, before production is touched. */
  preDeploy: string[];
  /** npm scripts run in the production checkout after the commit is checked out, before the restart. */
  build: string[];
  /** Loopback HTTP health check after the restart. */
  health: { url: string; expectStatus: number; attempts: number; intervalMs: number };
  /** `previous-commit`: on failure (or by explicit approved rollback) return to the commit deployed before. */
  rollback: "previous-commit" | "none";
}

export interface DeploymentFile {
  version: 1;
  deployments: DeploymentDefinition[];
}

export interface DeploymentLimits {
  workspaceRoot: string;
  deployRoots: readonly string[];
  beastPaths: readonly string[];
}

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const SCRIPT = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
/** Health checks only ever go to the loopback interface. */
const HEALTH_URL = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})(\/[A-Za-z0-9._~/-]*)?$/;
const MAX_SCRIPTS = 5;

function obj(value: unknown, where: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  const o = value as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !keys.includes(k));
  if (unknown.length) throw new Error(`${where} has unknown keys: ${unknown.join(", ")}`);
  for (const k of keys) if (!(k in o)) throw new Error(`${where} is missing ${k}`);
  return o;
}

function str(value: unknown, where: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${where} is invalid`);
  return value;
}

function oneOf<T extends string>(value: unknown, where: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${where} must be one of ${values.join(", ")}`);
  return value as T;
}

function int(value: unknown, where: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${where} must be an integer from ${min} to ${max}`);
  return value as number;
}

function canonicalPath(value: unknown, where: string): string {
  const err = checkPathSyntax(value);
  if (err) throw new Error(`${where}: ${err}`);
  return value as string;
}

function scripts(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_SCRIPTS) throw new Error(`${where} must be an array of at most ${MAX_SCRIPTS} npm script names`);
  return value.map((s, i) => str(s, `${where}[${i}]`, SCRIPT));
}

function parseDefinition(raw: unknown, i: number, limits: DeploymentLimits): DeploymentDefinition {
  const where = `deployments[${i}]`;
  const o = obj(raw, where, ["id", "project", "production", "mechanism", "source", "target", "install", "preDeploy", "build", "health", "rollback"]);
  const id = str(o.id, `${where}.id`, DEPLOY_TARGET_NAME);
  if (typeof o.production !== "boolean") throw new Error(`${where}.production must be true or false`);

  const src = obj(o.source, `${where}.source`, ["workspace", "branch"]);
  const workspace = canonicalPath(src.workspace, `${where}.source.workspace`);
  if (workspace === limits.workspaceRoot || !isUnder(limits.workspaceRoot, workspace)) {
    throw new Error(`${where}.source.workspace must be inside ${limits.workspaceRoot}`);
  }
  const branch = str(src.branch, `${where}.source.branch`, BRANCH);
  if (branch.includes("..") || branch.includes("//") || branch.endsWith("/") || branch.endsWith(".lock")) throw new Error(`${where}.source.branch is invalid`);

  const tgt = obj(o.target, `${where}.target`, ["checkout", "pm2App"]);
  const checkout = canonicalPath(tgt.checkout, `${where}.target.checkout`);
  if (!limits.deployRoots.some((r) => checkout !== r && isUnder(r, checkout))) {
    throw new Error(`${where}.target.checkout must be inside ${limits.deployRoots.join(" or ")}`);
  }
  if (isProtectedPath(checkout, { beastPaths: limits.beastPaths }, true)) throw new Error(`${where}.target.checkout is a protected location`);
  const pm2App = str(tgt.pm2App, `${where}.target.pm2App`, PM2_APP_NAME);
  if (REFUSED_RESTART_PM2_APPS.includes(pm2App) || /^\d+$/.test(pm2App) || pm2App === "all") throw new Error(`${where}.target.pm2App is not allowed`);

  const h = obj(o.health, `${where}.health`, ["url", "expectStatus", "attempts", "intervalMs"]);
  const url = str(h.url, `${where}.health.url`, HEALTH_URL);
  const port = Number(HEALTH_URL.exec(url)![1]);
  if (port > 65535) throw new Error(`${where}.health.url port is out of range`);

  return {
    id,
    project: str(o.project, `${where}.project`, PROJECT_NAME),
    production: o.production,
    mechanism: oneOf(o.mechanism, `${where}.mechanism`, ["pm2-git"] as const),
    source: { workspace, branch },
    target: { checkout, pm2App },
    install: oneOf(o.install, `${where}.install`, ["npm-ci", "none"] as const),
    preDeploy: scripts(o.preDeploy, `${where}.preDeploy`),
    build: scripts(o.build, `${where}.build`),
    health: {
      url,
      expectStatus: int(h.expectStatus, `${where}.health.expectStatus`, 100, 599),
      attempts: int(h.attempts, `${where}.health.attempts`, 1, 30),
      intervalMs: int(h.intervalMs, `${where}.health.intervalMs`, 250, 30_000),
    },
    rollback: oneOf(o.rollback, `${where}.rollback`, ["previous-commit", "none"] as const),
  };
}

export function parseDeployments(raw: unknown, limits: DeploymentLimits): DeploymentFile {
  const o = obj(raw, "deployments file", ["version", "deployments"]);
  if (o.version !== 1) throw new Error("deployments file version must be 1");
  if (!Array.isArray(o.deployments)) throw new Error("deployments must be an array");
  const defs = o.deployments.map((d, i) => parseDefinition(d, i, limits));
  for (const key of ["id", "checkout", "pm2App"] as const) {
    const values = defs.map((d) => (key === "id" ? d.id : d.target[key]));
    if (new Set(values).size !== values.length) throw new Error(`deployments contain a duplicate ${key}`);
  }
  return { version: 1, deployments: defs };
}

export type DeploymentsLoad = { ok: true; file: DeploymentFile } | { ok: false; error: string };

/** A missing file means no deployment targets; an invalid one denies every deployment. */
export function loadDeployments(file: string, limits: DeploymentLimits): DeploymentsLoad {
  try {
    if (!fs.existsSync(file)) return { ok: true, file: { version: 1, deployments: [] } };
    return { ok: true, file: parseDeployments(JSON.parse(fs.readFileSync(file, "utf8")), limits) };
  } catch (err) {
    return { ok: false, error: `deployments file ${file} is invalid: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function definitionHash(def: DeploymentDefinition): string {
  return sha256(canonicalJSON(def));
}

/** The definition as plan facts: everything an approver needs to see, and all of it bound into the digest. */
export function definitionFacts(def: DeploymentDefinition): Record<string, string> {
  return {
    "deployment.definitionHash": definitionHash(def),
    "deployment.project": def.project,
    "deployment.production": String(def.production),
    "deployment.mechanism": def.mechanism,
    "deployment.source": `${def.source.workspace} (branch ${def.source.branch})`,
    "deployment.checkout": def.target.checkout,
    "deployment.pm2App": def.target.pm2App,
    "deployment.install": def.install,
    "deployment.preDeploy": def.preDeploy.join(",") || "(none)",
    "deployment.build": def.build.join(",") || "(none)",
    "deployment.health": `GET ${def.health.url} expect ${def.health.expectStatus}`,
    "deployment.rollback": def.rollback,
  };
}
