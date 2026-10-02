import type { Logger } from "../logger.js";
import type { Job } from "../queue/types.js";
import type { VerificationResult } from "../verify/verify.js";
import { redactSecrets } from "../util/redact.js";
import type { LinearClient } from "./client.js";

/**
 * Formats Beast status comments and posts them to Linear.
 * Reporting failures are logged and never break job processing.
 */
export class LinearReporter {
  constructor(
    private readonly linear: LinearClient,
    private readonly logger: Logger,
  ) {}

  private async post(job: Job, stage: string, lines: string[], nextAction: string): Promise<void> {
    // Every comment is redacted as a whole: agent summaries, reasons and check output can all echo secrets.
    const body = redactSecrets(
      [`**Beast: ${stage}**`, "", ...lines, "", `**Next Action:** ${nextAction}`, "", `_Job ${job.id}_`].join("\n"),
    );
    try {
      await this.linear.addComment(job.issue.id, body);
    } catch (err) {
      this.logger.warn("failed to post Linear comment", {
        jobId: job.id,
        issueId: job.issue.identifier,
        stage,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  queued(job: Job): Promise<void> {
    return this.post(
      job,
      "Queued",
      [`Project: ${job.project ?? "unknown"}`, `Workspace: \`${job.workspace}\``, `Agent: ${job.agent}`],
      "Wait for Beast to start the coding agent.",
    );
  }

  working(job: Job): Promise<void> {
    return this.post(
      job,
      "Working",
      [`Agent \`${job.agent}\` started in \`${job.workspace}\`.`],
      "Wait for the agent to finish; Beast will report the result here.",
    );
  }

  blocked(job: Job, reason: string, details: string[] = []): Promise<void> {
    return this.post(
      job,
      "Blocked",
      [`Reason: ${reason}`, ...details.map((d) => `- \`${d}\``)],
      job.nextAction ?? "Resolve the blocking problem, then remove and re-add the ready label to retry.",
    );
  }

  failed(job: Job, reason: string, verification?: VerificationResult): Promise<void> {
    return this.post(
      job,
      "Failed",
      [`Reason: ${reason}`, ...(verification ? formatVerification(verification) : [])],
      job.nextAction ?? "Inspect the job log on the VPS, fix the cause, then re-add the ready label to retry.",
    );
  }

  completed(job: Job, verification: VerificationResult, agentSummary: string | undefined): Promise<void> {
    const stage = verification.passed ? "Completed locally" : "Completed locally — verification failed";
    return this.post(
      job,
      stage,
      [
        ...(agentSummary ? ["Agent summary:", "", quote(agentSummary), ""] : []),
        ...formatVerification(verification),
        "",
        "Nothing was committed, pushed or deployed by Beast.",
      ],
      job.nextAction ?? "Review the local changes.",
    );
  }
}

function quote(text: string): string {
  const trimmed = text.length > 3000 ? text.slice(0, 3000) + "\n…(truncated)" : text;
  return trimmed
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

export function formatVerification(v: VerificationResult): string[] {
  const lines = ["**Verification**"];
  lines.push(`- Agent exit status: ${v.agentExitCode ?? "none"}${v.agentTimedOut ? " (timed out)" : ""}`);
  lines.push(`- Changed files (${v.changedFiles.length}):`);
  for (const f of v.changedFiles.slice(0, 30)) lines.push(`  - \`${f}\``);
  if (v.changedFiles.length > 30) lines.push(`  - …and ${v.changedFiles.length - 30} more`);
  if (v.approvalViolations?.length) {
    lines.push("- ⛔ Approval-gated Git actions performed without approval:");
    for (const a of v.approvalViolations) lines.push(`  - ${a}`);
  } else if (v.newCommits) {
    lines.push("- ⚠️ HEAD moved: the agent created commit(s). Review before pushing.");
  }
  for (const c of v.checks) {
    lines.push(`- ${c.name}: ${c.status}${c.detail ? ` (${c.detail})` : ""}`);
  }
  lines.push(`- Overall: ${v.passed ? "passed" : "FAILED"}`);
  return lines;
}
