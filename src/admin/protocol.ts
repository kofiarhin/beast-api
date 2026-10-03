import type { AuthorizationGrant } from "./authorize.js";
import type { ValidatedOperation } from "./validate.js";

/**
 * Wire contract for the future privileged broker (`beast-executor`). Defined now so the
 * application layer and the broker share one typed shape; nothing serves or sends it yet.
 * The broker must re-validate every request against its own root-owned registry/policy.
 */
export interface ExecutorWireRequest {
  v: 1;
  requestId: string;
  op: string;
  opVersion: number;
  params: Readonly<Record<string, string | number | boolean>>;
  /** Facts the operation was validated against; the broker re-checks them before acting. */
  facts: Readonly<Record<string, string>>;
  grant: {
    class: "A" | "B" | "C";
    issueId: string;
    requester: string;
    digest: string | null;
    approver: string | null;
  };
}

export function toWireRequest(op: ValidatedOperation, grant: AuthorizationGrant): ExecutorWireRequest {
  return {
    v: 1,
    requestId: op.requestId,
    op: op.op,
    opVersion: op.opVersion,
    params: op.params,
    facts: op.facts,
    grant: {
      class: grant.riskClass,
      issueId: grant.issueId,
      requester: grant.requesterId,
      digest: grant.digest,
      approver: grant.approverId,
    },
  };
}

/**
 * `agent.spawn` (decision Q6): at activation the broker starts the configured agent or a
 * verification script as the unprivileged `beast-agent` user, under no-new-privs, in a
 * workspace Beast already validated. It is internal to Beast, only the Beast service user
 * may call it, and it is never an admin operation a ticket can request.
 */
export interface AgentSpawnRequest {
  v: 1;
  jobId: string;
  kind: "agent" | "verify";
  adapter: "codex" | "claude";
  workspace: string;
  /** Verification script name; only for kind "verify". */
  script?: "test" | "lint" | "typecheck" | "build";
}

const JOB_ID = /^[0-9a-f-]{36}$/;
const SCRIPTS = ["test", "lint", "typecheck", "build"];

/** Structural check the broker (and tests) apply to an agent.spawn request. */
export function agentSpawnProblem(req: unknown, workspaceRoot: string): string | undefined {
  if (typeof req !== "object" || req === null || Array.isArray(req)) return "request must be an object";
  const r = req as Record<string, unknown>;
  const allowed = ["v", "jobId", "kind", "adapter", "workspace", "script"];
  if (Object.keys(r).some((k) => !allowed.includes(k))) return "unknown fields";
  if (r.v !== 1) return "unsupported version";
  if (typeof r.jobId !== "string" || !JOB_ID.test(r.jobId)) return "invalid jobId";
  if (r.kind !== "agent" && r.kind !== "verify") return "invalid kind";
  if (r.adapter !== "codex" && r.adapter !== "claude") return "invalid adapter";
  if (typeof r.workspace !== "string" || !r.workspace.startsWith(workspaceRoot + "/") || r.workspace.includes("/..") || r.workspace.includes("//")) {
    return "workspace must be inside the workspace root";
  }
  if (r.kind === "verify" ? !SCRIPTS.includes(String(r.script)) : r.script !== undefined) return "invalid script";
  return undefined;
}
