import type { AdminService } from "../admin/service.js";
import type { LinearClient } from "../linear/client.js";
import type { LinearReporter } from "../linear/reporter.js";
import type { LinearIssue, LinearLabel } from "../linear/types.js";
import type { Logger } from "../logger.js";
import type { JobStore } from "../queue/store.js";
import type { ProjectRegistry } from "../registry/registry.js";
import { resolveWorkspaceTarget, type WorkspaceTarget } from "../workspace/target.js";

/** Subset of the Linear webhook payload that Beast relies on. */
export interface LinearWebhookPayload {
  action?: string;
  type?: string;
  webhookTimestamp?: number;
  url?: string;
  data?: {
    id?: string;
    /** Comment events only. */
    body?: string;
    issueId?: string;
    identifier?: string;
    title?: string;
    description?: string | null;
    url?: string;
    projectId?: string | null;
    project?: { id?: string; name?: string } | null;
    labels?: LinearLabel[];
    labelIds?: string[];
  };
  updatedFrom?: { labelIds?: string[] } & Record<string, unknown>;
  /** Who caused this event. Part of the signed payload. */
  actor?: { id?: unknown; type?: unknown } | null;
}

/** The Linear user behind a signed event, or null for integrations, apps and unknown actors. */
export function eventUserId(payload: LinearWebhookPayload): string | null {
  const a = payload.actor;
  return a && a.type === "user" && typeof a.id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(a.id) ? a.id : null;
}

export type IntakeResult =
  | { outcome: "ignored"; reason: string }
  | { outcome: "queued"; jobId: string }
  | { outcome: "blocked"; jobId: string; reason: string }
  | { outcome: "admin"; jobId: string; state: string };

export interface IntakeDeps {
  store: JobStore;
  registry: ProjectRegistry;
  linear: LinearClient;
  reporter: LinearReporter;
  logger: Logger;
  readyLabel: string;
  agent: string;
  onQueued: () => void;
  /** Label that marks an admin request. Checked even when admin mode is off (labels are mutually exclusive). */
  adminLabel: string;
  /** Present only when admin mode is enabled. */
  admin?: AdminService;
}

const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function issueFromPayload(payload: LinearWebhookPayload): LinearIssue | null {
  const d = payload.data;
  if (!d?.id) return null;
  return {
    id: d.id,
    identifier: d.identifier ?? d.id,
    title: d.title ?? "",
    description: d.description ?? "",
    url: d.url ?? payload.url ?? null,
    project: d.project
      ? { id: d.project.id ?? d.projectId ?? null, name: d.project.name ?? null }
      : d.projectId
        ? { id: d.projectId, name: null }
        : null,
    labels: Array.isArray(d.labels) ? d.labels.map((l) => ({ id: l.id, name: l.name })) : [],
  };
}

/**
 * Decide whether this event should start work. A ticket runs when it is created
 * with the ready label, or when the ready label is newly added in an update.
 * Other edits to an already-labelled ticket do not re-trigger execution.
 */
function isTrigger(payload: LinearWebhookPayload, readyLabel: LinearLabel): boolean {
  if (payload.action === "create") return true;
  const previous = payload.updatedFrom?.labelIds;
  return Array.isArray(previous) && !previous.includes(readyLabel.id);
}

export async function handleLinearEvent(deps: IntakeDeps, deliveryId: string, payload: LinearWebhookPayload): Promise<IntakeResult> {
  if (payload.type === "Comment") {
    if (!deps.admin) return { outcome: "ignored", reason: "admin operations are disabled" };
    if (payload.action !== "create") return { outcome: "ignored", reason: "only new comments can approve admin operations" };
    if (!payload.data?.id) return { outcome: "ignored", reason: "payload has no comment id" };
    return deps.admin.handleComment(deliveryId, payload.data.id, payload.data.body);
  }
  if (payload.type !== "Issue") return { outcome: "ignored", reason: `unsupported event type ${payload.type ?? "unknown"}` };
  if (payload.action !== "create" && payload.action !== "update") {
    return { outcome: "ignored", reason: `unsupported action ${payload.action ?? "unknown"}` };
  }

  const fromPayload = issueFromPayload(payload);
  if (!fromPayload) return { outcome: "ignored", reason: "payload has no issue id" };

  // Prefer authoritative issue details from the Linear API when configured.
  const issue = deps.linear.configured ? await deps.linear.fetchIssue(fromPayload.id) : fromPayload;
  if (!issue) return { outcome: "ignored", reason: "issue not found in Linear" };

  const log = deps.logger.child({ issueId: issue.identifier, deliveryId });

  const readyLabel = issue.labels.find((l) => sameLabel(l.name, deps.readyLabel));
  const adminLabel = issue.labels.find((l) => sameLabel(l.name, deps.adminLabel));

  // Admin requests never reach the coding path, and coding jobs never run on admin issues.
  if (adminLabel) {
    const adminResult =
      deps.admin && isTrigger(payload, adminLabel) ? await deps.admin.handleIssueTrigger(deliveryId, issue, adminLabel, eventUserId(payload)) : undefined;
    if (readyLabel && isTrigger(payload, readyLabel)) {
      const reason = `Issue carries both "${deps.readyLabel}" and "${deps.adminLabel}"; coding and admin requests must be separate issues`;
      const job = deps.store.createJob({
        deliveryId,
        issue,
        project: issue.project?.name ?? null,
        workspace: null,
        agent: deps.agent,
        state: "blocked",
        reason,
        nextAction: `Remove one of the two labels, then re-add "${deps.readyLabel}" if this is a coding task.`,
        finishedAt: new Date().toISOString(),
      });
      log.warn("job blocked: admin and ready labels together", { jobId: job.id, jobState: "blocked" });
      void deps.reporter.blocked(job, reason);
      return { outcome: "blocked", jobId: job.id, reason };
    }
    return adminResult ?? { outcome: "ignored", reason: deps.admin ? "admin label was not newly added" : "admin operations are disabled" };
  }

  // Authorization: the ready label must be present.
  if (!readyLabel) {
    log.info("issue not authorized; ignored");
    return { outcome: "ignored", reason: `issue does not have the "${deps.readyLabel}" label` };
  }
  if (!isTrigger(payload, readyLabel)) {
    return { outcome: "ignored", reason: "ready label was not newly added in this event" };
  }

  // Per-issue lock: never run the same issue concurrently.
  const active = deps.store.findActiveByIssue(issue.id);
  if (active) {
    log.info("issue already has an active job; ignored", { jobId: active.id, jobState: active.state });
    return { outcome: "ignored", reason: `issue already has active job ${active.id}` };
  }

  let entry: WorkspaceTarget | undefined;
  let targetError: string | undefined;
  try {
    entry = resolveWorkspaceTarget(deps.registry, issue);
  } catch (err) {
    targetError = err instanceof Error ? err.message : String(err);
  }
  if (!entry) {
    const reason = targetError ?? `Linear project "${issue.project?.name ?? issue.project?.id ?? "none"}" is not registered with Beast`;
    const job = deps.store.createJob({
      deliveryId,
      issue,
      project: issue.project?.name ?? null,
      workspace: null,
      agent: deps.agent,
      state: "blocked",
      reason,
      nextAction: "Provide a valid Beast workspace directive or register the ticket's project, then re-add the ready label.",
      finishedAt: new Date().toISOString(),
    });
    log.warn("job blocked: unknown project", { jobId: job.id, jobState: "blocked", project: job.project });
    void deps.reporter.blocked(job, reason);
    return { outcome: "blocked", jobId: job.id, reason };
  }

  const job = deps.store.createJob({
    deliveryId,
    issue,
    project: entry.name,
    workspace: entry.workspace,
    agent: deps.agent,
    state: "queued",
  });
  log.info("job queued", { jobId: job.id, project: entry.name, workspace: entry.workspace, jobState: "queued", agent: deps.agent });
  void deps.reporter.queued(job);
  deps.onQueued();
  return { outcome: "queued", jobId: job.id };
}
