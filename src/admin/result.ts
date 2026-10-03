import { redactSecrets } from "../util/redact.js";
import type { OperationResult, OperationStatus, ParamValue } from "./types.js";
import type { ValidatedOperation } from "./validate.js";

/** Limits applied after redaction, so a result can never flood logs, audit or Linear. */
export const MAX_OUTPUT_BYTES = 8 * 1024;
const MAX_OUTPUT_LINES = 500;
const MAX_FIELDS = 50;
const MAX_FIELD_CHARS = 1024;
const MAX_REASON_CHARS = 1000;
const FIELD_KEY = /^[A-Za-z0-9_.]{1,64}$/;
const STATUSES: readonly OperationStatus[] = ["succeeded", "failed", "denied", "dry_run"];

type Redactor = (text: string) => string;

function bound(text: string): string {
  let out = text.split("\n").slice(-MAX_OUTPUT_LINES).join("\n");
  while (Buffer.byteLength(out) > MAX_OUTPUT_BYTES) out = out.slice(Math.ceil(out.length / 8));
  return out;
}

/**
 * Turn whatever an executor returned into a safe result: known status only, bounded
 * redacted output, scalar fields only. Redaction failure fails closed: no output and
 * no string fields are returned at all.
 */
export function sanitizeResult(raw: unknown, op: ValidatedOperation, startedAt: number, redact: Redactor = redactSecrets): OperationResult {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const status: OperationStatus = STATUSES.includes(r.status as OperationStatus) ? (r.status as OperationStatus) : "failed";
  const base: OperationResult = {
    status,
    op: op.op,
    requestId: op.requestId,
    riskClass: op.riskClass,
    fields: {},
    durationMs: Date.now() - startedAt,
  };
  try {
    const fields: Record<string, ParamValue> = {};
    const rawFields = typeof r.fields === "object" && r.fields !== null ? (r.fields as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(rawFields).slice(0, MAX_FIELDS)) {
      if (!FIELD_KEY.test(k)) continue;
      if (typeof v === "string") fields[k] = redact(v).slice(0, MAX_FIELD_CHARS);
      else if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) fields[k] = v;
    }
    base.fields = fields;
    if (typeof r.output === "string" && r.output) base.output = bound(redact(r.output));
    if (typeof r.reason === "string" && r.reason) base.reason = redact(r.reason).slice(0, MAX_REASON_CHARS);
    if (STATUSES.includes(r.status as OperationStatus) === false) base.reason = base.reason ?? "executor returned an invalid result";
    return base;
  } catch {
    return { ...base, fields: {}, output: undefined, reason: "output withheld: secret redaction failed" };
  }
}

export function statusResult(op: ValidatedOperation, status: OperationStatus, reason: string, startedAt = Date.now()): OperationResult {
  return sanitizeResult({ status, reason }, op, startedAt);
}
