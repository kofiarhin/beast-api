import type { LinearIssue } from "../linear/types.js";
import type { VerificationResult } from "../verify/verify.js";

export type JobState = "queued" | "working" | "blocked" | "failed" | "completed";

/** States that hold the per-issue lock: an issue with such a job cannot be enqueued again. */
export const ACTIVE_STATES: readonly JobState[] = ["queued", "working"];

export interface JobResult {
  agentExitCode: number | null;
  agentTimedOut: boolean;
  agentDurationMs: number;
  agentSummary?: string;
  logFile?: string;
  verification?: VerificationResult;
}

export interface Job {
  id: string;
  deliveryId: string;
  issue: LinearIssue;
  project: string | null;
  workspace: string | null;
  agent: string;
  state: JobState;
  reason?: string;
  nextAction?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: JobResult;
}

export interface DeliveryRecord {
  receivedAt: string;
  outcome: string;
  jobId?: string;
}
