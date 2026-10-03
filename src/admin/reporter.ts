import type { LinearClient } from "../linear/client.js";
import type { Logger } from "../logger.js";
import { redactSecrets } from "../util/redact.js";
import type { AdminJob, OperationResult } from "./types.js";
import type { ValidatedOperation } from "./validate.js";

/**
 * Linear comments for admin jobs. Every body is redacted as a whole; reporting failures
 * are logged and never change an admin decision.
 */
export class AdminReporter {
  constructor(
    private readonly linear: LinearClient,
    private readonly logger: Logger,
  ) {}

  private async post(issueId: string, stage: string, lines: string[], jobId?: string): Promise<void> {
    const body = redactSecrets([`**Beast Admin: ${stage}**`, "", ...lines, ...(jobId ? ["", `_Admin job ${jobId}_`] : [])].join("\n"));
    try {
      await this.linear.addComment(issueId, body);
    } catch (err) {
      this.logger.warn("failed to post Linear admin comment", { issueId, stage, error: err instanceof Error ? err.message : String(err) });
    }
  }

  denied(job: AdminJob): Promise<void> {
    return this.post(job.issueId, "Denied", [`Reason: ${job.reason ?? "denied"}`, "", "Nothing was executed."], job.id);
  }

  queued(job: AdminJob, op: ValidatedOperation): Promise<void> {
    return this.post(job.issueId, `Queued (class ${op.riskClass})`, [`Operation: \`${op.op}\` — ${op.summary}`], job.id);
  }

  approvalRequired(job: AdminJob, op: ValidatedOperation): Promise<void> {
    const facts = Object.entries(op.facts).map(([k, v]) => `- ${k}: \`${v}\``);
    return this.post(
      job.issueId,
      "Approval required (class C)",
      [
        ...(op.protected ? ["⚠️ **PROTECTED TARGET.** Approving allows a change to a protected system location or service.", ""] : []),
        `Operation: \`${op.op}\` v${op.opVersion}`,
        `Action: ${op.summary}`,
        "Parameters:",
        "```json",
        JSON.stringify(op.params, null, 2),
        "```",
        ...(facts.length ? ["Current target state:", ...facts] : []),
        `Requested by Linear user \`${job.requesterId}\`. Expires ${job.expiresAt} (15 minutes).`,
        "",
        "To approve exactly this operation, reply with a new comment containing only:",
        "",
        `\`/beast approve ${job.digest}\``,
        "",
        `To cancel: \`/beast deny ${job.digest}\``,
        "",
        "Any change to the issue description, the parameters or the target state voids this approval.",
      ],
      job.id,
    );
  }

  approvalRejected(issueId: string, reason: string, jobId?: string): Promise<void> {
    return this.post(issueId, "Approval not accepted", [`Reason: ${reason}`, "", "Nothing was executed."], jobId);
  }

  approved(job: AdminJob): Promise<void> {
    return this.post(job.issueId, "Approved", [`Approved by Linear user \`${job.approval?.approverId}\`. Queued for execution.`], job.id);
  }

  closed(job: AdminJob, stage: "Expired" | "Cancelled"): Promise<void> {
    return this.post(job.issueId, stage, [`Reason: ${job.reason ?? stage.toLowerCase()}`, "", "Nothing was executed."], job.id);
  }

  finished(job: AdminJob, result: OperationResult): Promise<void> {
    const stage = { succeeded: "Succeeded", failed: "Failed", denied: "Denied", dry_run: "Dry run" }[result.status];
    const fields = Object.entries(result.fields).map(([k, v]) => `- ${k}: \`${String(v)}\``);
    return this.post(
      job.issueId,
      stage,
      [
        `Operation: \`${result.op}\` (class ${result.riskClass})`,
        ...(result.reason ? [`Reason: ${result.reason}`] : []),
        ...fields,
        ...(result.output ? ["Output (redacted):", "```", result.output.replaceAll("```", "'''"), "```"] : []),
      ],
      job.id,
    );
  }
}
