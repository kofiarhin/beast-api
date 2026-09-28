import type { ValidatedWorkspace } from "../workspace/validate.js";

/** Everything the agent needs to know about the ticket. */
export interface AgentTask {
  jobId: string;
  issueId: string;
  identifier: string;
  title: string;
  description: string;
  url: string | null;
  project: string;
  workspacePath: string;
}

export interface AgentRunRequest {
  task: AgentTask;
  workspace: ValidatedWorkspace;
  prompt: string;
  timeoutMs: number;
  /** File the adapter should write the full agent transcript to. */
  logFile: string;
  /** Aborted when the job is cancelled or Beast shuts down; the agent must be stopped. */
  signal?: AbortSignal;
}

export interface AgentResult {
  exitCode: number | null;
  timedOut: boolean;
  /** True when the agent was stopped because `signal` was aborted. */
  cancelled?: boolean;
  durationMs: number;
  /** Agent's final message, if the agent provides one. */
  summary?: string;
  /** Set when the agent process could not be started at all. */
  error?: string;
}

/**
 * A coding agent (Codex, Claude Code, ...). Adapters only know how to launch
 * one fresh agent process for one task in one already-validated workspace.
 * Queueing, safety checks, verification and reporting live outside adapters.
 */
export interface AgentAdapter {
  readonly name: string;
  run(request: AgentRunRequest): Promise<AgentResult>;
}
