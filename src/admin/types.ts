/**
 * Controlled VPS administration (IDE-69).
 *
 * Admin work is expressed only as typed operations with structured parameters. Beast API
 * validates and authorizes every request before anything privileged could happen, and a
 * separate privileged executor (not activated in this phase) performs the operation.
 * There is no command-string type anywhere in this module.
 */

/** A = read-only inspection, B = narrow reversible change, C = dangerous change (exact approval). */
export type RiskClass = "A" | "B" | "C";

/** `off` ignores admin requests; `dry-run` runs the full flow without touching the host; `enforce` executes through the privileged broker. */
export type AdminMode = "off" | "dry-run" | "enforce";

/** Unvalidated request as written in a ticket directive. */
export interface RawOperationRequest {
  op: unknown;
  params: unknown;
}

export type ParamValue = string | number | boolean;
export type OperationParams = Readonly<Record<string, ParamValue>>;

export type OperationStatus = "succeeded" | "failed" | "denied" | "dry_run";

/** What an executor returns. Always bounded and redacted before it is stored or reported. */
export interface OperationResult {
  status: OperationStatus;
  op: string;
  requestId: string;
  riskClass: RiskClass;
  fields: Record<string, ParamValue>;
  output?: string;
  durationMs: number;
  reason?: string;
}

export type AdminJobState =
  | "denied"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "dry_run"
  | "expired"
  | "cancelled";

/** States that hold the per-issue admin lock. */
export const ACTIVE_ADMIN_STATES: readonly AdminJobState[] = ["awaiting_approval", "queued", "running"];

export interface AdminApproval {
  commentId: string;
  approverId: string;
  approvedAt: string;
}

export interface AdminJob {
  id: string;
  /** Identifier bound into validation, grants and the executor request. */
  requestId: string;
  deliveryId: string;
  issueId: string;
  issueIdentifier: string;
  requesterId: string | null;
  /** Raw directive as requested (already size-bounded); re-validated before execution. */
  request: { op: string; params: Record<string, unknown> } | null;
  descriptionHash: string;
  state: AdminJobState;
  riskClass?: RiskClass;
  protected?: boolean;
  summary?: string;
  /** Class C only: the plan digest an approval must quote exactly. */
  digest?: string;
  nonce?: string;
  expiresAt?: string;
  approval?: AdminApproval;
  reason?: string;
  result?: OperationResult;
  createdAt: string;
  updatedAt: string;
}
