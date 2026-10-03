import { isValidatedOperation, type ValidatedOperation } from "./validate.js";
import type { RiskClass } from "./types.js";

/**
 * Proof that Beast authorized one specific validated operation. Grants are created only
 * here and tracked in a private WeakSet; executors refuse anything else.
 */
export interface AuthorizationGrant {
  readonly requestId: string;
  readonly op: string;
  readonly riskClass: RiskClass;
  readonly issueId: string;
  readonly requesterId: string;
  /** Class C only. */
  readonly digest: string | null;
  readonly approverId: string | null;
  readonly issuedAt: string;
}

const grants = new WeakSet<AuthorizationGrant>();

export function isAuthorizationGrant(value: unknown): value is AuthorizationGrant {
  return typeof value === "object" && value !== null && grants.has(value as AuthorizationGrant);
}

export interface AdminAuthConfig {
  /** Linear user IDs allowed to request admin operations (by adding the admin label). */
  requesters: readonly string[];
  /** Linear user IDs allowed to approve class C operations. */
  approvers: readonly string[];
}

export function isRequester(auth: AdminAuthConfig, userId: string | null | undefined): userId is string {
  return !!userId && auth.requesters.includes(userId);
}

export function isApprover(auth: AdminAuthConfig, userId: string | null | undefined, beastUserId: string | null): userId is string {
  return !!userId && userId !== beastUserId && auth.approvers.includes(userId);
}

export type GrantResult = { ok: true; grant: AuthorizationGrant } | { ok: false; reason: string };

/**
 * Issue a grant for a validated operation. Class A and B need an allowlisted requester
 * (Beast authorization). Class C additionally needs an approval bound to its exact digest.
 */
export function issueGrant(
  auth: AdminAuthConfig,
  op: ValidatedOperation,
  input: { issueId: string; requesterId: string | null; approval?: { digest: string; approverId: string }; beastUserId: string | null },
): GrantResult {
  if (!isValidatedOperation(op)) return { ok: false, reason: "operation was not validated" };
  if (!isRequester(auth, input.requesterId)) return { ok: false, reason: "requester is not authorized for admin operations" };
  if (op.riskClass === "C") {
    if (!input.approval) return { ok: false, reason: "class C operations require an exact approval" };
    if (!/^[0-9a-f]{64}$/.test(input.approval.digest)) return { ok: false, reason: "approval digest is malformed" };
    if (!isApprover(auth, input.approval.approverId, input.beastUserId)) return { ok: false, reason: "approver is not authorized" };
  } else if (input.approval) {
    return { ok: false, reason: `class ${op.riskClass} operations do not take an approval` };
  }
  const grant: AuthorizationGrant = Object.freeze({
    requestId: op.requestId,
    op: op.op,
    riskClass: op.riskClass,
    issueId: input.issueId,
    requesterId: input.requesterId,
    digest: input.approval?.digest ?? null,
    approverId: input.approval?.approverId ?? null,
    issuedAt: new Date().toISOString(),
  });
  grants.add(grant);
  return { ok: true, grant };
}
