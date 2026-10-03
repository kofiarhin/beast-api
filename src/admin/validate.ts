import { ACCOUNT_NAME, COMMIT_SHA, DEPLOY_TARGET_NAME, PACKAGE_NAME, PM2_APP_NAME, UNIT_NAME } from "./names.js";
import { checkPathSyntax } from "./paths.js";
import type { PolicyLoad } from "./policy.js";
import type { HostProbe } from "./probe.js";
import { getOperation, type ParamSpec } from "./registry.js";
import type { OperationParams, ParamValue, RawOperationRequest, RiskClass } from "./types.js";

/**
 * An admin operation that passed every check. Instances can only be created by
 * `validateOperation` and are tracked in a private WeakMap, so executors can verify at
 * runtime that they were handed a genuinely validated operation, not a look-alike object.
 */
export interface ValidatedOperation {
  readonly requestId: string;
  readonly op: string;
  readonly opVersion: number;
  readonly params: OperationParams;
  readonly riskClass: RiskClass;
  readonly protected: boolean;
  /** Target facts observed during validation. Bound into class C approvals and re-checked before execution. */
  readonly facts: Readonly<Record<string, string>>;
  readonly summary: string;
}

export type ValidationCode =
  | "policy_invalid"
  | "malformed"
  | "unknown_operation"
  | "operation_disabled"
  | "invalid_params"
  | "shell_syntax"
  | "refused"
  | "unsupported_target"
  | "unsafe_path"
  | "uncertain";

export type ValidationResult =
  | { ok: true; operation: ValidatedOperation }
  | { ok: false; code: ValidationCode; reason: string };

export interface ValidationContext {
  requestId: string;
  policy: PolicyLoad;
  probe: HostProbe;
  /** Beast's own code, data, policy and audit locations (always protected). */
  beastPaths: readonly string[];
}

const validated = new WeakSet<ValidatedOperation>();

export function isValidatedOperation(value: unknown): value is ValidatedOperation {
  return typeof value === "object" && value !== null && validated.has(value as ValidatedOperation);
}

/** Shell metacharacters, whitespace, quotes and control characters: never valid in any parameter. */
const SHELL_SYNTAX = /[\s;&|`$<>(){}[\]*?!~'"\\#%^\x00-\x1f\x7f]/;
const MAX_PARAMS = 10;

const deny = (code: ValidationCode, reason: string): ValidationResult => ({ ok: false, code, reason });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkSyntax(name: string, spec: ParamSpec, value: unknown): string | undefined {
  const formatted = (pattern: RegExp, what: string) =>
    typeof value === "string" && pattern.test(value) ? undefined : `${name} must be a valid ${what}`;
  switch (spec.type) {
    case "unit":
      return formatted(UNIT_NAME, "systemd unit name ending in .service, .socket, .timer or .target");
    case "pm2App":
      return formatted(PM2_APP_NAME, "PM2 app name");
    case "user":
      return formatted(ACCOUNT_NAME, "user name");
    case "group":
      return formatted(ACCOUNT_NAME, "group name");
    case "package":
      return formatted(PACKAGE_NAME, "package name");
    case "deployTarget":
      return formatted(DEPLOY_TARGET_NAME, "deployment target id");
    case "commit":
      return formatted(COMMIT_SHA, "full 40-character lowercase Git commit id");
    case "path": {
      const err = checkPathSyntax(value);
      return err && `${name}: ${err}`;
    }
    case "int":
      return Number.isSafeInteger(value) && (value as number) >= spec.min && (value as number) <= spec.max
        ? undefined
        : `${name} must be an integer from ${spec.min} to ${spec.max}`;
    case "bool":
      return typeof value === "boolean" ? undefined : `${name} must be true or false`;
    case "enum":
      return typeof value === "string" && spec.values.includes(value) ? undefined : `${name} must be one of ${spec.values.join(", ")}`;
  }
}

type Resolution = { facts: Record<string, string> } | { code: ValidationCode; reason: string };

async function resolvePath(name: string, p: string, probe: HostProbe, leafTypes?: readonly string[]): Promise<Resolution> {
  // Walk every component: a symlink anywhere (parent or leaf, dangling or not) is refused.
  const parts = p === "/" ? [] : p.slice(1).split("/");
  let current = "";
  const chain = ["/", ...parts.map((part) => (current += "/" + part))];
  let leaf;
  for (const component of chain) {
    const info = await probe.lstat(component);
    if (info === "missing") return { code: "unsupported_target", reason: `${name}: ${component} does not exist` };
    if (info === "denied") return { code: "uncertain", reason: `${name}: ${component} cannot be verified without privileges` };
    if (info.type === "symlink") return { code: "unsafe_path", reason: `${name}: ${component} is a symlink` };
    leaf = info;
  }
  if (!leaf) return { code: "uncertain", reason: `${name}: could not inspect path` };
  if (leafTypes && !leafTypes.includes(leaf.type)) {
    return { code: "unsupported_target", reason: `${name}: ${p} is a ${leaf.type}, not a regular file or directory` };
  }
  return {
    facts: {
      [`${name}.type`]: leaf.type,
      [`${name}.dev`]: leaf.dev,
      [`${name}.ino`]: leaf.ino,
      [`${name}.uid`]: String(leaf.uid),
      [`${name}.gid`]: String(leaf.gid),
      [`${name}.mode`]: leaf.mode,
    },
  };
}

async function resolveLive(op: string, name: string, spec: ParamSpec, value: ParamValue, params: OperationParams, probe: HostProbe): Promise<Resolution> {
  switch (spec.type) {
    case "deployTarget": {
      // The executor resolves the target against its own root-owned definitions and checks
      // the live checkout, PM2 app and (for deploy.run) the requested commit.
      const res = await probe.deployment({ op, target: String(value), ...(params.commit !== undefined ? { commit: String(params.commit) } : {}) });
      if (!res) return { code: "uncertain", reason: `${name}: could not inspect deployment target ${value}` };
      return res.ok ? { facts: res.facts } : { code: res.code, reason: `${name}: ${res.reason}` };
    }
    case "unit": {
      const info = await probe.unit(String(value));
      if (!info) return { code: "uncertain", reason: `${name}: could not query systemd for ${value}` };
      if (info.loadState !== "loaded") return { code: "unsupported_target", reason: `${name}: systemd unit ${value} is not loaded (${info.loadState})` };
      return { facts: { [`${name}.fragmentPath`]: info.fragmentPath } };
    }
    case "pm2App": {
      const apps = await probe.pm2Apps();
      if (!apps) return { code: "uncertain", reason: `${name}: could not query PM2` };
      const matches = apps.filter((a) => a.name === value);
      if (matches.length === 0) return { code: "unsupported_target", reason: `${name}: PM2 app ${value} does not exist` };
      if (matches.length > 1) return { code: "uncertain", reason: `${name}: PM2 app name ${value} is ambiguous` };
      return { facts: { [`${name}.execPath`]: matches[0]!.execPath } };
    }
    case "user": {
      const uid = await probe.userId(String(value));
      return uid === null ? { code: "unsupported_target", reason: `${name}: unknown user ${value}` } : { facts: { [`${name}.uid`]: String(uid) } };
    }
    case "group": {
      const gid = await probe.groupId(String(value));
      return gid === null ? { code: "unsupported_target", reason: `${name}: unknown group ${value}` } : { facts: { [`${name}.gid`]: String(gid) } };
    }
    case "path":
      return resolvePath(name, String(value), probe, op === "filesystem.chown" ? ["file", "directory"] : undefined);
    default:
      return { facts: {} };
  }
}

/**
 * Validate a raw request completely, before any privilege escalation. Order matters:
 * policy, operation, enablement, structure, syntax, hard denies, then live target checks.
 * Anything unexpected is denied.
 */
export async function validateOperation(raw: RawOperationRequest, ctx: ValidationContext): Promise<ValidationResult> {
  try {
    if (!ctx.policy.ok) return deny("policy_invalid", ctx.policy.error);
    if (typeof raw.op !== "string" || raw.op.length > 64) return deny("malformed", "operation must be a short string");
    const def = getOperation(raw.op);
    if (!def) return deny("unknown_operation", `unknown operation ${raw.op}`);
    if (!ctx.policy.policy.enabledOperations.includes(def.id)) {
      return deny("operation_disabled", `operation ${def.id} is not enabled in the admin policy`);
    }

    const rawParams = raw.params ?? {};
    if (!isPlainObject(rawParams)) return deny("malformed", "params must be a JSON object");
    const keys = Object.keys(rawParams);
    if (keys.length > MAX_PARAMS) return deny("malformed", "too many params");
    const unknownKeys = keys.filter((k) => !Object.hasOwn(def.params, k));
    if (unknownKeys.length) return deny("invalid_params", `unsupported params: ${unknownKeys.join(", ")}`);

    const params: Record<string, ParamValue> = {};
    for (const [name, spec] of Object.entries(def.params)) {
      const value = rawParams[name];
      if (value === undefined) {
        if (spec.optional) continue;
        return deny("invalid_params", `missing required param ${name}`);
      }
      if (typeof value === "string" && SHELL_SYNTAX.test(value)) {
        return deny("shell_syntax", `${name} contains whitespace, quotes, control characters or shell syntax`);
      }
      const err = checkSyntax(name, spec, value);
      if (err) return deny("invalid_params", err);
      params[name] = value as ParamValue;
    }

    const refused = def.check?.(params);
    if (refused) return deny(refused.includes("refused") ? "refused" : "invalid_params", refused);

    const facts: Record<string, string> = {};
    for (const [name, spec] of Object.entries(def.params)) {
      if (params[name] === undefined) continue;
      const res = await resolveLive(def.id, name, spec, params[name]!, params, ctx.probe);
      if ("code" in res) return deny(res.code, res.reason);
      Object.assign(facts, res.facts);
    }

    const cls = def.classify(params, {
      beastPaths: ctx.beastPaths,
      extraProtectedPaths: ctx.policy.policy.additionalProtectedPaths,
      extraProtectedServices: ctx.policy.policy.additionalProtectedServices,
    });
    const operation: ValidatedOperation = Object.freeze({
      requestId: ctx.requestId,
      op: def.id,
      opVersion: def.version,
      params: Object.freeze(params),
      riskClass: cls.riskClass,
      protected: cls.protected,
      facts: Object.freeze(facts),
      summary: def.summarize(params),
    });
    validated.add(operation);
    return { ok: true, operation };
  } catch (err) {
    return deny("uncertain", `validation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

