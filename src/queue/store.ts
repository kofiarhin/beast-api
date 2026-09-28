import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ACTIVE_STATES, type DeliveryRecord, type Job, type JobState } from "./types.js";

interface StoreData {
  version: 1;
  jobs: Record<string, Job>;
  deliveries: Record<string, DeliveryRecord>;
}

export type NewJob = Omit<Job, "id" | "createdAt" | "updatedAt">;

/**
 * Small JSON-file store. All reads are served from memory and every mutation
 * is written synchronously and atomically (temp file + rename), so state
 * survives restarts and crashes without extra infrastructure. Single-process only.
 */
export class JobStore {
  private data: StoreData;
  private readonly file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(dataDir, "state.json");
    this.data = this.read();
  }

  private read(): StoreData {
    if (!fs.existsSync(this.file)) return { version: 1, jobs: {}, deliveries: {} };
    const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoreData;
    return { version: 1, jobs: parsed.jobs ?? {}, deliveries: parsed.deliveries ?? {} };
  }

  private persist(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // ---- deliveries (webhook idempotency) ----

  hasDelivery(deliveryId: string): boolean {
    return deliveryId in this.data.deliveries;
  }

  recordDelivery(deliveryId: string, record: DeliveryRecord): void {
    this.data.deliveries[deliveryId] = record;
    this.persist();
  }

  // ---- jobs ----

  createJob(input: NewJob): Job {
    if (ACTIVE_STATES.includes(input.state) && this.findActiveByIssue(input.issue.id)) {
      throw new Error(`Issue ${input.issue.identifier} already has an active job`);
    }
    const now = new Date().toISOString();
    const job: Job = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    this.data.jobs[job.id] = job;
    this.persist();
    return structuredClone(job);
  }

  updateJob(id: string, patch: Partial<Omit<Job, "id" | "createdAt">>): Job {
    const existing = this.data.jobs[id];
    if (!existing) throw new Error(`Unknown job ${id}`);
    const updated: Job = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.data.jobs[id] = updated;
    this.persist();
    return structuredClone(updated);
  }

  getJob(id: string): Job | undefined {
    const job = this.data.jobs[id];
    return job ? structuredClone(job) : undefined;
  }

  listJobs(): Job[] {
    return Object.values(this.data.jobs)
      .map((j) => structuredClone(j))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  findActiveByIssue(issueId: string): Job | undefined {
    return this.listJobs().find((j) => j.issue.id === issueId && ACTIVE_STATES.includes(j.state));
  }

  /** Oldest queued job (FIFO). */
  nextQueued(): Job | undefined {
    return this.listJobs().find((j) => j.state === "queued");
  }

  countByState(): Record<JobState, number> {
    const counts: Record<JobState, number> = { queued: 0, working: 0, blocked: 0, failed: 0, completed: 0 };
    for (const j of Object.values(this.data.jobs)) counts[j.state]++;
    return counts;
  }

  /**
   * Jobs left "working" by a previous process were interrupted mid-run. They are
   * marked failed (never silently re-run), because the workspace may be partially modified.
   */
  recoverInterrupted(): Job[] {
    const interrupted = Object.values(this.data.jobs).filter((j) => j.state === "working");
    return interrupted.map((j) =>
      this.updateJob(j.id, {
        state: "failed",
        reason: "Beast API restarted while the agent was running",
        nextAction: "Inspect the workspace for partial changes, clean it up, then re-add the ready label to retry.",
        finishedAt: new Date().toISOString(),
      }),
    );
  }
}
