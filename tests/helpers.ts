import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentResult, AgentRunRequest } from "../src/agents/types.js";
import { createApp } from "../src/app.js";
import type { LinearClient } from "../src/linear/client.js";
import { LinearReporter } from "../src/linear/reporter.js";
import type { LinearIssue } from "../src/linear/types.js";
import { silentLogger } from "../src/logger.js";
import { JobStore } from "../src/queue/store.js";
import { Worker } from "../src/queue/worker.js";
import { ProjectRegistry, type ProjectEntry } from "../src/registry/registry.js";
import { computeSignature } from "../src/webhook/signature.js";

/** All test files live under ./.test-tmp inside beast-api; real project repos are never touched. */
const TMP_BASE = path.resolve(import.meta.dirname, "..", ".test-tmp");

export function makeTmpDir(): string {
  const dir = path.join(TMP_BASE, randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeTmpDir(dir: string): void {
  if (dir.startsWith(TMP_BASE + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
}

const GIT_ID = ["-c", "user.name=Beast Test", "-c", "user.email=beast-test@example.invalid", "-c", "commit.gpgsign=false"];

export function makeRepo(root: string, name: string, opts: { dirty?: boolean } = {}): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", [...GIT_ID, "commit", "-q", "-m", "init"], { cwd: dir });
  if (opts.dirty) fs.writeFileSync(path.join(dir, "uncommitted.txt"), "work in progress\n");
  return dir;
}

export const SECRET = "test-webhook-secret";
export const READY = "Beast Ready";

export function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "issue-1",
    identifier: "BEA-1",
    title: "Add a feature",
    description: "Do the thing.\n\n## Acceptance criteria\n- thing done",
    url: "https://linear.app/x/issue/BEA-1",
    project: { id: "proj-1", name: "TestProject" },
    labels: [{ id: "label-ready", name: READY }],
    ...overrides,
  };
}

export class FakeLinear implements LinearClient {
  readonly configured = true;
  comments: { issueId: string; body: string }[] = [];
  fetchCalls = 0;
  constructor(public issues: Record<string, LinearIssue> = {}) {}
  async fetchIssue(id: string) {
    this.fetchCalls++;
    return this.issues[id] ?? null;
  }
  async addComment(issueId: string, body: string) {
    this.comments.push({ issueId, body });
  }
}

export class FakeAgent implements AgentAdapter {
  readonly name = "fake";
  calls: AgentRunRequest[] = [];
  active = 0;
  maxActive = 0;
  constructor(
    private readonly behaviour: (req: AgentRunRequest) => Promise<Partial<AgentResult>> | Partial<AgentResult> = () => ({}),
  ) {}
  async run(req: AgentRunRequest): Promise<AgentResult> {
    this.calls.push(req);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const r = await this.behaviour(req);
      return { exitCode: 0, timedOut: false, durationMs: 1, ...r };
    } finally {
      this.active--;
    }
  }
}

export function webhookBody(issue: LinearIssue, opts: { action?: string; previousLabelIds?: string[]; timestamp?: number } = {}) {
  return JSON.stringify({
    action: opts.action ?? "create",
    type: "Issue",
    webhookTimestamp: opts.timestamp ?? Date.now(),
    data: { ...issue, labelIds: issue.labels.map((l) => l.id) },
    ...(opts.previousLabelIds ? { updatedFrom: { labelIds: opts.previousLabelIds } } : {}),
  });
}

export function sign(body: string, secret = SECRET): string {
  return computeSignature(body, secret);
}

export interface Harness {
  root: string;
  workspaceRoot: string;
  store: JobStore;
  registry: ProjectRegistry;
  linear: FakeLinear;
  agent: FakeAgent;
  worker: Worker;
  app: ReturnType<typeof createApp>;
  dataDir: string;
}

export function makeHarness(opts: {
  projects?: (workspaceRoot: string) => ProjectEntry[];
  agent?: FakeAgent;
  issues?: Record<string, LinearIssue>;
  autoKick?: boolean;
} = {}): Harness {
  const root = makeTmpDir();
  const workspaceRoot = path.join(root, "projects");
  fs.mkdirSync(workspaceRoot);
  const dataDir = path.join(root, "data");
  const store = new JobStore(dataDir);
  const registry = new ProjectRegistry(
    opts.projects?.(workspaceRoot) ?? [{ name: "TestProject", workspace: path.join(workspaceRoot, "test-project") }],
    workspaceRoot,
  );
  const linear = new FakeLinear(opts.issues);
  const agent = opts.agent ?? new FakeAgent();
  const reporter = new LinearReporter(linear, silentLogger);
  const worker = new Worker({
    store,
    registry,
    adapter: agent,
    reporter,
    logger: silentLogger,
    logDir: path.join(dataDir, "logs"),
    agentTimeoutMs: 10_000,
    verifyTimeoutMs: 10_000,
    verifyScripts: ["test", "lint", "typecheck", "build"],
  });
  const app = createApp({
    store,
    registry,
    linear,
    reporter,
    logger: silentLogger,
    webhookSecret: SECRET,
    webhookToleranceMs: 60_000,
    readyLabel: READY,
    agent: agent.name,
    onQueued: () => (opts.autoKick === false ? undefined : worker.kick()),
  });
  return { root, workspaceRoot, store, registry, linear, agent, worker, app, dataDir };
}
