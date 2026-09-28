import type { LinearClient } from "../linear/client.js";
import type { LinearReporter } from "../linear/reporter.js";
import type { LinearIssue, LinearLabel } from "../linear/types.js";
import type { Logger } from "../logger.js";
import type { JobStore } from "../queue/store.js";
import type { ProjectRegistry } from "../registry/registry.js";

/** Subset of the Linear webhook payload that Beast relies on. */
export interface LinearWebhookPayload {
  action?: string;
  type?: string;
  webhookTimestamp?: number;
  url?: string;
  data?: {
    id?: string;
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
}

export type IntakeResult =
  | { outcome: "ignored"; reason: string }
  | { outcome: "queued"; jobId: string }
  | { outcome: "blocked"; jobId: string; reason: string };

export interface IntakeDeps {
  store: JobStore;
  registry: ProjectRegistry;
  linear: LinearClient;
  reporter: LinearReporter;
  logger: Logger;
  readyLabel: string;
  agent: string;
  onQueued: () => void;
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

  // Authorization: the ready label must be present.
  const readyLabel = issue.labels.find((l) => sameLabel(l.name, deps.readyLabel));
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

  const entry = deps.registry.resolve(issue.project);
  if (!entry) {
    const reason = `Linear project "${issue.project?.name ?? issue.project?.id ?? "none"}" is not registered with Beast`;
    const job = deps.store.createJob({
      deliveryId,
      issue,
      project: issue.project?.name ?? null,
      workspace: null,
      agent: deps.agent,
      state: "blocked",
      reason,
      nextAction: "Register the project in config/projects.json (or fix the ticket's project), then re-add the ready label.",
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
