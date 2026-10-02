import fs from "node:fs";
import path from "node:path";
import { launchAgent } from "../agents/launcher.js";
import type { AgentAdapter, AgentResult } from "../agents/types.js";
import type { LinearReporter } from "../linear/reporter.js";
import type { Logger } from "../logger.js";
import type { ProjectRegistry } from "../registry/registry.js";
import { verifyWorkspace } from "../verify/verify.js";
import { resolveWorkspaceTarget, type WorkspaceTarget } from "../workspace/target.js";
import { validateWorkspace } from "../workspace/validate.js";
import type { JobStore } from "./store.js";
import type { Job } from "./types.js";

export interface WorkerDeps {
  store: JobStore;
  registry: ProjectRegistry;
  adapter: AgentAdapter;
  reporter: LinearReporter;
  logger: Logger;
  logDir: string;
  agentTimeoutMs: number;
  verifyTimeoutMs: number;
  verifyScripts: string[];
}

/**
 * Processes queued jobs strictly one at a time. `kick()` is safe to call as
 * often as you like; if a loop is already running it simply picks new jobs up.
 */
export class Worker {
  private loop: Promise<void> | null = null;
  private active: { jobId: string; controller: AbortController } | null = null;
  private stopped = false;

  constructor(private readonly deps: WorkerDeps) {
    fs.mkdirSync(deps.logDir, { recursive: true, mode: 0o700 });
  }

  get busy(): boolean {
    return this.loop !== null;
  }

  kick(): void {
    if (this.loop || this.stopped) return;
    this.loop = this.drain().finally(() => {
      this.loop = null;
    });
  }

  /**
   * Stop the agent of the given job if it is the one currently running.
   * Its process group is terminated and the job is marked failed.
   */
  cancel(jobId: string, reason = "Job cancelled"): boolean {
    if (this.active?.jobId !== jobId) return false;
    this.active.controller.abort(reason);
    return true;
  }

  /** Stop the running agent (if any), start no further jobs, and wait until the worker is idle. */
  async shutdown(reason = "Beast API shutting down"): Promise<void> {
    this.stopped = true;
    this.active?.controller.abort(reason);
    await this.idle();
  }

  /** Resolves when the queue has been drained (used by tests and shutdown). */
  async idle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  private async drain(): Promise<void> {
    for (let job = this.deps.store.nextQueued(); job && !this.stopped; job = this.deps.store.nextQueued()) {
      try {
        await this.process(job);
      } catch (err) {
        const reason = `Internal Beast error: ${err instanceof Error ? err.message : String(err)}`;
        this.deps.logger.error("job crashed", { jobId: job.id, issueId: job.issue.identifier, error: reason });
        const failed = this.deps.store.updateJob(job.id, {
          state: "failed",
          reason,
          finishedAt: new Date().toISOString(),
        });
        await this.deps.reporter.failed(failed, reason);
      }
    }
  }

  private block(job: Job, reason: string, nextAction: string, details: string[] = []): Promise<void> {
    const blocked = this.deps.store.updateJob(job.id, {
      state: "blocked",
      reason,
      nextAction,
      finishedAt: new Date().toISOString(),
    });
    this.deps.logger.warn("job blocked", {
      jobId: job.id,
      issueId: job.issue.identifier,
      project: job.project,
      workspace: job.workspace,
      jobState: "blocked",
      reason,
    });
    return this.deps.reporter.blocked(blocked, reason, details);
  }

  private async process(queued: Job): Promise<void> {
    const { store, registry, adapter, reporter } = this.deps;
    const log = this.deps.logger.child({ jobId: queued.id, issueId: queued.issue.identifier, agent: adapter.name });

    let job = store.updateJob(queued.id, { state: "working", startedAt: new Date().toISOString() });

    // Re-resolve the authorized ticket snapshot; never trust the stored workspace path.
    let entry: WorkspaceTarget | undefined;
    try {
      entry = resolveWorkspaceTarget(registry, {
        description: job.issue.description,
        project: { name: job.project, id: job.issue.project?.id },
      });
    } catch (err) {
      return this.block(job, err instanceof Error ? err.message : String(err), "Fix the Beast workspace directive, then re-add the ready label.");
    }
    if (!entry) {
      return this.block(
        job,
        `Linear project "${job.project ?? "none"}" is not registered with Beast`,
        "Register the project in config/projects.json (or fix the ticket's project), then re-add the ready label.",
      );
    }

    const check = await validateWorkspace(registry, entry);
    if (!check.ok) {
      const nextAction =
        check.code === "dirty"
          ? `Commit, stash or discard the existing changes in ${entry.workspace} yourself, then re-add the ready label.`
          : check.code === "exists"
            ? `${entry.workspace} already exists. Use "Beast workspace mode: existing" or choose a new path, then re-add the ready label.`
            : `Fix the workspace at ${entry.workspace} (${check.code}), then re-add the ready label.`;
      return this.block(job, check.reason, nextAction, check.dirtyFiles);
    }
    const workspace = check.workspace;

    job = store.updateJob(job.id, { workspace: workspace.path, project: entry.name });
    log.info("agent starting", { project: entry.name, workspace: workspace.path, jobState: "working" });
    await reporter.working(job);

    const logFile = path.join(this.deps.logDir, `${job.id}.log`);
    const controller = new AbortController();
    this.active = { jobId: job.id, controller };
    let agentResult: AgentResult;
    try {
      agentResult = await launchAgent(
        adapter,
        registry,
        workspace,
        {
          jobId: job.id,
          issueId: job.issue.id,
          identifier: job.issue.identifier,
          title: job.issue.title,
          description: job.issue.description,
          url: job.issue.url,
          project: entry.name,
          workspacePath: workspace.path,
        },
        { timeoutMs: this.deps.agentTimeoutMs, logFile, signal: controller.signal },
      );
    } catch (err) {
      agentResult = {
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.active = null;
    }
    const cancelled = controller.signal.aborted;

    const verification = await verifyWorkspace({
      workspacePath: workspace.path,
      headBefore: workspace.headBefore,
      agentExitCode: agentResult.exitCode,
      agentTimedOut: agentResult.timedOut,
      // A stopped job only records Git state; project scripts are not started.
      scripts: cancelled ? [] : this.deps.verifyScripts,
      timeoutMs: this.deps.verifyTimeoutMs,
    });

    const result = {
      agentExitCode: agentResult.exitCode,
      agentTimedOut: agentResult.timedOut,
      agentDurationMs: agentResult.durationMs,
      agentSummary: agentResult.summary,
      logFile,
      verification,
    };
    const agentOk = agentResult.exitCode === 0 && !agentResult.timedOut && !agentResult.error && !cancelled;
    const finishedAt = new Date().toISOString();

    if (!agentOk) {
      const reason = cancelled
        ? `Agent was stopped: ${String(controller.signal.reason)}`
        : agentResult.error
        ? `Agent could not run: ${agentResult.error}`
        : agentResult.timedOut
          ? `Agent timed out after ${this.deps.agentTimeoutMs} ms`
          : `Agent exited with status ${agentResult.exitCode}`;
      job = store.updateJob(job.id, {
        state: "failed",
        reason,
        result,
        finishedAt,
        nextAction: `Inspect ${logFile} and the workspace (${verification.changedFiles.length} changed file(s)); clean up, then re-add the ready label to retry.`,
      });
      log.warn("job failed", { jobState: "failed", reason, verification: verification.passed });
      await reporter.failed(job, reason, verification);
      return;
    }

    let nextAction: string;
    if (verification.changedFiles.length === 0 && !verification.newCommits) {
      nextAction = "The agent made no changes. Review the agent summary and clarify the ticket if needed.";
    } else if (verification.passed) {
      nextAction = `Review the local diff in ${workspace.path}, then commit and push manually if it looks right.`;
    } else {
      nextAction = `Review the failing checks and the local diff in ${workspace.path} before committing anything.`;
    }
    job = store.updateJob(job.id, { state: "completed", result, finishedAt, nextAction });
    log.info("job completed locally", {
      jobState: "completed",
      verification: verification.passed ? "passed" : "failed",
      changedFiles: verification.changedFiles.length,
    });
    await reporter.completed(job, verification, agentResult.summary);
  }
}
