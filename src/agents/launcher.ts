import type { ProjectRegistry } from "../registry/registry.js";
import { isValidatedWorkspace, type ValidatedWorkspace } from "../workspace/validate.js";
import { buildAgentPrompt } from "./prompt.js";
import type { AgentAdapter, AgentResult, AgentTask } from "./types.js";

export class UnsafeWorkspaceError extends Error {}

/**
 * The only path through which an agent is launched. Refuses anything that is
 * not a workspace produced by `validateWorkspace` for a ticket target.
 */
export async function launchAgent(
  adapter: AgentAdapter,
  registry: ProjectRegistry,
  workspace: ValidatedWorkspace,
  task: AgentTask,
  opts: { timeoutMs: number; logFile: string; signal?: AbortSignal },
): Promise<AgentResult> {
  if (!isValidatedWorkspace(workspace, registry)) {
    throw new UnsafeWorkspaceError("Refusing to launch agent: workspace was not validated against this registry");
  }
  if (task.workspacePath !== workspace.path) {
    throw new UnsafeWorkspaceError("Refusing to launch agent: task workspace does not match validated workspace");
  }
  return adapter.run({
    task,
    workspace,
    prompt: buildAgentPrompt(task),
    timeoutMs: opts.timeoutMs,
    logFile: opts.logFile,
    signal: opts.signal,
  });
}
