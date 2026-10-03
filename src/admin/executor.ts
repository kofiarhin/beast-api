import { isAuthorizationGrant, type AuthorizationGrant } from "./authorize.js";
import { sanitizeResult, statusResult } from "./result.js";
import type { OperationResult } from "./types.js";
import { isValidatedOperation, type ValidatedOperation } from "./validate.js";

/**
 * The privileged executor interface. It accepts only a validated operation plus the grant
 * Beast issued for it: there is no way to pass a command, a shell string or an argument
 * list. In this phase only executors that cannot escalate exist (disabled, dry-run, and a
 * fake in tests). The future broker client implements the same interface.
 */
export type ExecutorKind = "disabled" | "dry-run" | "fake" | "broker";

export interface PrivilegedExecutor {
  readonly kind: ExecutorKind;
  execute(op: ValidatedOperation, grant: AuthorizationGrant, signal?: AbortSignal): Promise<OperationResult>;
}

/** Why `op` and `grant` must not be executed, or undefined when they belong together. */
export function executionProblem(op: unknown, grant: unknown): string | undefined {
  if (!isValidatedOperation(op)) return "operation was not produced by the validator";
  if (!isAuthorizationGrant(grant)) return "grant was not issued by Beast";
  if (grant.requestId !== op.requestId || grant.op !== op.op) return "grant belongs to a different operation";
  if (grant.riskClass !== op.riskClass) return "grant risk class does not match the operation";
  if (op.riskClass === "C" && (!grant.digest || !grant.approverId)) return "class C operation has no exact approval";
  return undefined;
}

/**
 * Every executor goes through this guard: it re-checks the operation/grant pairing,
 * converts any thrown error into a failed result (never a retry, never a fallback to
 * another executor) and sanitizes whatever comes back.
 */
export abstract class GuardedExecutor implements PrivilegedExecutor {
  abstract readonly kind: ExecutorKind;
  protected abstract perform(op: ValidatedOperation, grant: AuthorizationGrant, signal?: AbortSignal): Promise<unknown>;

  async execute(op: ValidatedOperation, grant: AuthorizationGrant, signal?: AbortSignal): Promise<OperationResult> {
    const started = Date.now();
    const problem = executionProblem(op, grant);
    if (problem) {
      return isValidatedOperation(op)
        ? statusResult(op, "denied", problem, started)
        : { status: "denied", op: "unknown", requestId: "unknown", riskClass: "C", fields: {}, durationMs: 0, reason: problem };
    }
    try {
      return sanitizeResult(await this.perform(op, grant, signal), op, started);
    } catch (err) {
      return statusResult(op, "failed", `executor error: ${err instanceof Error ? err.message : String(err)}`, started);
    }
  }
}

/** Default executor: refuses everything. */
export class DisabledExecutor extends GuardedExecutor {
  readonly kind = "disabled";
  protected async perform(): Promise<unknown> {
    return { status: "denied", reason: "privileged execution is not activated on this host" };
  }
}

/** Describes what would happen and touches nothing. */
export class DryRunExecutor extends GuardedExecutor {
  readonly kind = "dry-run";
  protected async perform(op: ValidatedOperation): Promise<unknown> {
    return {
      status: "dry_run",
      fields: { mode: "dry-run", plannedAction: op.summary, riskClass: op.riskClass, protected: op.protected },
      reason: "dry run: no privileged action was taken",
    };
  }
}
