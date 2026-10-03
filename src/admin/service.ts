import { randomUUID } from "node:crypto";
import type { LinearClient } from "../linear/client.js";
import type { LinearIssue, LinearLabel } from "../linear/types.js";
import type { Logger } from "../logger.js";
import type { JobStore } from "../queue/store.js";
import type { AuditLog } from "./audit.js";
import { issueGrant, isApprover, isRequester, type AdminAuthConfig } from "./authorize.js";
import { planDigest, sha256 } from "./digest.js";
import { parseAdminDirective } from "./directive.js";
import type { PrivilegedExecutor } from "./executor.js";
import type { PolicyLoad } from "./policy.js";
import type { HostProbe } from "./probe.js";
import { AdminReporter } from "./reporter.js";
import type { AdminJob, AdminJobState, OperationResult } from "./types.js";
import { validateOperation, type ValidatedOperation } from "./validate.js";

/** Class C approvals expire 15 minutes after the plan is posted (approved decision). */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

/** The only accepted approval syntax: the whole comment is exactly one command line. */
const APPROVAL_COMMAND = /^\/beast (approve|deny) ([0-9a-f]{64})$/;

export function parseApprovalCommand(body: string): { action: "approve" | "deny"; digest: string } | null {
  const m = APPROVAL_COMMAND.exec(body.trim());
  return m ? { action: m[1] as "approve" | "deny", digest: m[2]! } : null;
}

export interface AdminServiceDeps {
  label: string;
  readyLabel: string;
  auth: AdminAuthConfig;
  policy: PolicyLoad;
  probe: HostProbe;
  executor: PrivilegedExecutor;
  audit: AuditLog;
  store: JobStore;
  linear: LinearClient;
  logger: Logger;
  /** Beast's own code, data, policy and audit locations (always protected). */
  beastPaths: readonly string[];
  now?: () => number;
}

export type AdminOutcome = { outcome: "ignored"; reason: string } | { outcome: "admin"; jobId: string; state: AdminJobState };

const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Controlled admin flow: request intake, class C approvals and a separate single-lane
 * worker. Every decision is audited before it takes effect; any error denies.
 */
export class AdminService {
  private readonly reporter: AdminReporter;
  private loop: Promise<void> | null = null;
  private stopped = false;
  /** Issues whose admin request is being processed right now (per-issue lock during intake). */
  private readonly intake = new Set<string>();

  constructor(private readonly deps: AdminServiceDeps) {
    this.reporter = new AdminReporter(deps.linear, deps.logger);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private audit(event: string, job: AdminJob | null, data: Record<string, unknown> = {}): void {
    this.deps.audit.append(event, {
      ...(job ? { jobId: job.id, requestId: job.requestId, issue: job.issueIdentifier, state: job.state } : {}),
      ...data,
    });
  }

  /** Audit without letting an audit failure throw past a decision that already denies. */
  private auditQuietly(event: string, job: AdminJob | null, data: Record<string, unknown> = {}): void {
    try {
      this.audit(event, job, data);
    } catch (err) {
      this.deps.logger.error("admin audit write failed", { event, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private validationContext(requestId: string) {
    return { requestId, policy: this.deps.policy, probe: this.deps.probe, beastPaths: this.deps.beastPaths };
  }

  private async close(job: AdminJob, state: "denied" | "expired" | "cancelled", reason: string): Promise<AdminOutcome> {
    const closed = this.deps.store.updateAdminJob(job.id, { state, reason });
    this.auditQuietly(`job.${state}`, closed, { reason });
    this.deps.logger.warn(`admin job ${state}`, { adminJobId: job.id, issueId: job.issueIdentifier, reason });
    if (state === "denied") await this.reporter.denied(closed);
    else await this.reporter.closed(closed, state === "expired" ? "Expired" : "Cancelled");
    return { outcome: "admin", jobId: job.id, state };
  }

  /** Expire class C plans whose approval window has passed, releasing the per-issue lock. */
  async sweepExpired(): Promise<void> {
    for (const job of this.deps.store.listAdminJobs()) {
      if (job.state === "awaiting_approval" && job.expiresAt && Date.parse(job.expiresAt) <= this.now()) {
        await this.close(job, "expired", "No valid approval arrived within 15 minutes");
      }
    }
  }

  /** The admin label was newly added to an issue. */
  async handleIssueTrigger(deliveryId: string, issue: LinearIssue, adminLabel: LinearLabel): Promise<AdminOutcome> {
    if (this.intake.has(issue.id)) return { outcome: "ignored", reason: "an admin request for this issue is already being processed" };
    this.intake.add(issue.id);
    try {
      return await this.intakeRequest(deliveryId, issue, adminLabel);
    } finally {
      this.intake.delete(issue.id);
    }
  }

  private async intakeRequest(deliveryId: string, issue: LinearIssue, adminLabel: LinearLabel): Promise<AdminOutcome> {
    await this.sweepExpired();
    const active = this.deps.store.findActiveAdminByIssue(issue.id);
    if (active) return { outcome: "ignored", reason: `issue already has active admin job ${active.id}` };

    let job = this.deps.store.createAdminJob({
      requestId: randomUUID(),
      deliveryId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      requesterId: null,
      request: null,
      descriptionHash: sha256(issue.description),
      // Created closed; it becomes active only once every check below has passed.
      state: "denied",
      reason: "pending validation",
    });

    try {
      this.audit("request.received", job, { deliveryId });

      if (issue.labels.some((l) => sameLabel(l.name, this.deps.readyLabel))) {
        return this.close(job, "denied", `An issue cannot carry both "${this.deps.label}" and "${this.deps.readyLabel}"`);
      }
      if (!this.deps.linear.configured) return this.close(job, "denied", "Linear API is not configured, so the requester cannot be verified");

      const requesterId = await this.deps.linear.fetchLabelAdder(issue.id, adminLabel.id).catch(() => null);
      job = this.deps.store.updateAdminJob(job.id, { requesterId });
      if (!requesterId) return this.close(job, "denied", "Could not determine unambiguously who added the admin label");
      if (!isRequester(this.deps.auth, requesterId)) return this.close(job, "denied", "The user who added the admin label is not an authorized requester");

      const directive = parseAdminDirective(issue.description);
      if (!directive.ok) return this.close(job, "denied", directive.reason);
      job = this.deps.store.updateAdminJob(job.id, { request: directive.request });

      const v = await validateOperation(directive.request, this.validationContext(job.requestId));
      if (!v.ok) return this.close(job, "denied", `${v.code}: ${v.reason}`);
      const op = v.operation;

      if (op.riskClass !== "C") {
        job = this.deps.store.updateAdminJob(job.id, { state: "queued", reason: undefined, riskClass: op.riskClass, protected: op.protected, summary: op.summary });
        this.audit("request.authorized", job, { op: op.op, params: op.params, riskClass: op.riskClass });
        await this.reporter.queued(job, op);
        this.kick();
        return { outcome: "admin", jobId: job.id, state: "queued" };
      }

      const nonce = randomUUID();
      const expiresAt = new Date(this.now() + APPROVAL_TTL_MS).toISOString();
      const digest = this.digestFor(job, op, requesterId, nonce, expiresAt);
      job = this.deps.store.updateAdminJob(job.id, {
        state: "awaiting_approval",
        reason: undefined,
        riskClass: "C",
        protected: op.protected,
        summary: op.summary,
        digest,
        nonce,
        expiresAt,
      });
      this.audit("plan.created", job, { op: op.op, params: op.params, facts: op.facts, protected: op.protected, digest, expiresAt });
      await this.reporter.approvalRequired(job, op);
      return { outcome: "admin", jobId: job.id, state: "awaiting_approval" };
    } catch (err) {
      return this.close(job, "denied", `Internal error; denied: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private digestFor(job: AdminJob, op: ValidatedOperation, requesterId: string, nonce: string, expiresAt: string): string {
    return planDigest({
      op: op.op,
      opVersion: op.opVersion,
      params: op.params,
      facts: op.facts,
      riskClass: op.riskClass,
      protected: op.protected,
      issueId: job.issueId,
      descriptionHash: job.descriptionHash,
      requesterId,
      nonce,
      expiresAt,
    });
  }

  /** A comment was created. Only an exact `/beast approve|deny <digest>` comment matters. */
  async handleComment(deliveryId: string, commentId: string, payloadBody: string | undefined): Promise<AdminOutcome> {
    // Cheap pre-filter on the signed payload; the authoritative body is fetched below.
    if (payloadBody !== undefined && !/^\s*\/beast\s/.test(payloadBody)) return { outcome: "ignored", reason: "not a Beast command" };
    await this.sweepExpired();

    const comment = await this.deps.linear.fetchComment(commentId).catch(() => null);
    if (!comment) return { outcome: "ignored", reason: "comment could not be fetched from Linear" };
    const cmd = parseApprovalCommand(comment.body);
    if (!cmd) return { outcome: "ignored", reason: "not an exact Beast approval command" };

    const reject = async (reason: string, job?: AdminJob): Promise<AdminOutcome> => {
      this.auditQuietly("approval.rejected", job ?? null, { commentId, deliveryId, reason, issueId: comment.issueId });
      if (comment.issueId) await this.reporter.approvalRejected(comment.issueId, reason, job?.id);
      return { outcome: "ignored", reason };
    };

    const matches = this.deps.store.listAdminJobs().filter((j) => j.state === "awaiting_approval" && j.digest === cmd.digest);
    if (matches.length !== 1) return reject(matches.length ? "The digest matches more than one pending plan" : "No pending plan matches this digest");
    const job = matches[0]!;

    if (comment.issueId !== job.issueId) return reject("The approval must be posted on the same issue as the plan", job);
    if (comment.edited) return reject("Edited comments are not accepted; post a new comment", job);
    const beastUserId = await this.deps.linear.fetchViewerId().catch(() => null);
    if (!beastUserId) return reject("Beast could not determine its own Linear user, so the approver cannot be verified", job);
    if (!isApprover(this.deps.auth, comment.userId, beastUserId)) return reject("The comment author is not an authorized approver", job);
    if (!job.expiresAt || Date.parse(job.expiresAt) <= this.now()) {
      return this.close(job, "expired", "The approval arrived after the 15-minute window");
    }

    if (cmd.action === "deny") return this.close(job, "cancelled", `Denied by Linear user ${comment.userId}`);

    const approved = this.deps.store.updateAdminJob(job.id, {
      state: "queued",
      approval: { commentId: comment.id, approverId: comment.userId!, approvedAt: new Date(this.now()).toISOString() },
    });
    this.audit("approval.accepted", approved, { commentId: comment.id, approverId: comment.userId, digest: cmd.digest });
    await this.reporter.approved(approved);
    this.kick();
    return { outcome: "admin", jobId: job.id, state: "queued" };
  }

  // ---- worker lane (separate from coding jobs, one operation at a time) ----

  kick(): void {
    if (this.loop || this.stopped) return;
    this.loop = this.drain().finally(() => {
      this.loop = null;
    });
  }

  async idle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await this.idle();
  }

  private async drain(): Promise<void> {
    for (let job = this.deps.store.nextQueuedAdmin(); job && !this.stopped; job = this.deps.store.nextQueuedAdmin()) {
      try {
        await this.process(job);
      } catch (err) {
        const reason = `Internal error; not retried: ${err instanceof Error ? err.message : String(err)}`;
        const current = this.deps.store.getAdminJob(job.id);
        if (current && (current.state === "queued" || current.state === "running")) {
          await this.close({ ...current }, "denied", reason).catch(() => undefined);
        }
      }
    }
  }

  /** Re-check everything at execution time; any drift since the request denies. */
  private async process(job: AdminJob): Promise<void> {
    const deny = (reason: string) => this.close(job, "denied", reason).then(() => undefined);

    const issue = await this.deps.linear.fetchIssue(job.issueId).catch(() => null);
    if (!issue) return deny("The issue could not be re-read from Linear");
    if (!issue.labels.some((l) => sameLabel(l.name, this.deps.label))) {
      await this.close(job, "cancelled", "The admin label was removed");
      return;
    }
    if (issue.labels.some((l) => sameLabel(l.name, this.deps.readyLabel))) return deny(`The issue now also carries "${this.deps.readyLabel}"`);
    if (sha256(issue.description) !== job.descriptionHash) return deny("The issue description changed after the request");
    if (!job.request || !isRequester(this.deps.auth, job.requesterId)) return deny("The requester is no longer authorized");

    const v = await validateOperation(job.request, this.validationContext(job.requestId));
    if (!v.ok) return deny(`Re-validation failed: ${v.code}: ${v.reason}`);
    const op = v.operation;
    if (op.riskClass !== job.riskClass || op.protected !== job.protected) return deny("The operation's risk classification changed since the request");

    let grant;
    if (op.riskClass === "C") {
      if (!job.digest || !job.nonce || !job.expiresAt || !job.approval) return deny("Class C operation has no exact approval");
      if (Date.parse(job.expiresAt) <= this.now()) {
        await this.close(job, "expired", "The approval expired before execution started");
        return;
      }
      if (this.digestFor(job, op, job.requesterId!, job.nonce, job.expiresAt) !== job.digest) {
        return deny("The target or parameters changed since approval; the approval is void");
      }
      const beastUserId = await this.deps.linear.fetchViewerId().catch(() => null);
      const res = issueGrant(this.deps.auth, op, {
        issueId: job.issueId,
        requesterId: job.requesterId,
        approval: { digest: job.digest, approverId: job.approval.approverId },
        beastUserId,
      });
      if (!res.ok) return deny(res.reason);
      // Single use: the approval is consumed before execution starts, so it can never run twice.
      if (!this.deps.store.consumeApproval(job.nonce, job.id)) return deny("This approval has already been used");
      grant = res.grant;
    } else {
      const res = issueGrant(this.deps.auth, op, { issueId: job.issueId, requesterId: job.requesterId, beastUserId: null });
      if (!res.ok) return deny(res.reason);
      grant = res.grant;
    }

    try {
      this.audit("execution.started", job, { op: op.op, params: op.params, facts: op.facts, executor: this.deps.executor.kind });
    } catch (err) {
      return deny(`Audit log unavailable; not executed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const running = this.deps.store.updateAdminJob(job.id, { state: "running" });

    const result: OperationResult = await this.deps.executor.execute(op, grant);
    const state: AdminJobState = result.status;
    const finished = this.deps.store.updateAdminJob(running.id, { state, result, reason: result.reason });
    this.auditQuietly("execution.finished", finished, { result });
    this.deps.logger.info("admin operation finished", { adminJobId: job.id, op: op.op, status: result.status });
    await this.reporter.finished(finished, result);
  }
}
