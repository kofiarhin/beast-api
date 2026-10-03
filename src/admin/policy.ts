import fs from "node:fs";
import { checkPathSyntax } from "./paths.js";
import { getOperation } from "./registry.js";

/**
 * Admin policy: which registered operations are enabled (opt-in, empty by default) and
 * any protected targets added on top of the built-in approved lists. The built-in lists
 * cannot be shrunk here. An unreadable or invalid policy denies every admin request.
 */
export interface AdminPolicy {
  readonly enabledOperations: readonly string[];
  readonly additionalProtectedServices: readonly string[];
  readonly additionalProtectedPaths: readonly string[];
}

export type PolicyLoad = { ok: true; policy: AdminPolicy } | { ok: false; error: string };

const KEYS = ["version", "enabledOperations", "additionalProtectedServices", "additionalProtectedPaths"];
const SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,127}\*?$/;

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new Error(`${name} must be an array of strings`);
  if (new Set(value).size !== value.length) throw new Error(`${name} contains duplicates`);
  return value as string[];
}

export function parsePolicy(raw: unknown): AdminPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("policy must be a JSON object");
  const obj = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(obj).filter((k) => !KEYS.includes(k));
  if (unknownKeys.length) throw new Error(`unknown policy keys: ${unknownKeys.join(", ")}`);
  if (obj.version !== 1) throw new Error("policy version must be 1");

  const enabledOperations = stringArray(obj.enabledOperations, "enabledOperations");
  for (const op of enabledOperations) if (!getOperation(op)) throw new Error(`enabledOperations lists unknown operation ${op}`);
  const additionalProtectedServices = stringArray(obj.additionalProtectedServices ?? [], "additionalProtectedServices");
  for (const s of additionalProtectedServices) if (!SERVICE_PATTERN.test(s)) throw new Error(`invalid protected service ${s}`);
  const additionalProtectedPaths = stringArray(obj.additionalProtectedPaths ?? [], "additionalProtectedPaths");
  for (const p of additionalProtectedPaths) {
    const err = checkPathSyntax(p);
    if (err) throw new Error(`invalid protected path ${p}: ${err}`);
  }
  return Object.freeze({
    enabledOperations: Object.freeze([...enabledOperations]),
    additionalProtectedServices: Object.freeze([...additionalProtectedServices]),
    additionalProtectedPaths: Object.freeze([...additionalProtectedPaths]),
  });
}

export function loadPolicy(file: string): PolicyLoad {
  try {
    return { ok: true, policy: parsePolicy(JSON.parse(fs.readFileSync(file, "utf8"))) };
  } catch (err) {
    return { ok: false, error: `admin policy ${file} is invalid: ${err instanceof Error ? err.message : String(err)}` };
  }
}
