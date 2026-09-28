import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, redact } from "../src/logger.js";
import { JobStore } from "../src/queue/store.js";
import { makeHarness, makeIssue, makeTmpDir, removeTmpDir, sign, webhookBody } from "./helpers.js";

let root: string;
afterEach(() => removeTmpDir(root));

const newJob = (issueId = "issue-1", state: "queued" | "blocked" = "queued") => ({
  deliveryId: "d1",
  issue: makeIssue({ id: issueId }),
  project: "TestProject",
  workspace: "/x",
  agent: "codex",
  state,
});

describe("job store persistence", () => {
  it("persists jobs and deliveries across restarts", () => {
    root = makeTmpDir();
    const dir = path.join(root, "data");
    const a = new JobStore(dir);
    const job = a.createJob(newJob());
    a.recordDelivery("delivery-1", { receivedAt: new Date().toISOString(), outcome: "queued", jobId: job.id });

    const b = new JobStore(dir);
    expect(b.getJob(job.id)?.state).toBe("queued");
    expect(b.hasDelivery("delivery-1")).toBe(true);
    expect(b.nextQueued()?.id).toBe(job.id);
  });

  it("refuses a second active job for the same issue", () => {
    root = makeTmpDir();
    const s = new JobStore(path.join(root, "data"));
    s.createJob(newJob());
    expect(() => s.createJob(newJob())).toThrow(/active job/);
    // Other issues and non-active records are fine.
    s.createJob(newJob("issue-2"));
    s.createJob(newJob("issue-1", "blocked"));
  });

  it("marks interrupted working jobs failed on restart instead of re-running them", () => {
    root = makeTmpDir();
    const dir = path.join(root, "data");
    const a = new JobStore(dir);
    const job = a.createJob(newJob());
    a.updateJob(job.id, { state: "working" });

    const b = new JobStore(dir);
    const recovered = b.recoverInterrupted();
    expect(recovered.map((j) => j.id)).toEqual([job.id]);
    expect(b.getJob(job.id)?.state).toBe("failed");
    expect(b.nextQueued()).toBeUndefined();
    expect(b.findActiveByIssue("issue-1")).toBeUndefined();
  });

  it("remembers webhook deliveries after a restart (no duplicate execution)", async () => {
    const h1 = makeHarness({ issues: { "issue-1": makeIssue() }, autoKick: false });
    root = h1.root;
    const body = webhookBody(makeIssue());
    const headers = { "Content-Type": "application/json", "Linear-Signature": sign(body), "Linear-Delivery": "dup" };
    const first = await request(h1.app).post("/webhooks/linear").set(headers).send(body);
    expect(first.status).toBe(202);

    // Simulate restart: new store instance on the same data dir, then a second app.
    const reloaded = new JobStore(h1.dataDir);
    expect(reloaded.hasDelivery("dup")).toBe(true);
    const h2 = makeHarness({ issues: { "issue-1": makeIssue() }, autoKick: false });
    const { createApp } = await import("../src/app.js");
    const { LinearReporter } = await import("../src/linear/reporter.js");
    const { silentLogger } = await import("../src/logger.js");
    const app2 = createApp({
      store: reloaded,
      registry: h1.registry,
      linear: h2.linear,
      reporter: new LinearReporter(h2.linear, silentLogger),
      logger: silentLogger,
      webhookSecret: "test-webhook-secret",
      webhookToleranceMs: 60_000,
      readyLabel: "Beast Ready",
      agent: "fake",
      onQueued: () => {},
    });
    const second = await request(app2).post("/webhooks/linear").set(headers).send(body);
    expect(second.body.status).toBe("duplicate");
    expect(reloaded.listJobs()).toHaveLength(1);
    removeTmpDir(h2.root);
  });
});

describe("logger", () => {
  it("redacts sensitive fields", () => {
    const lines: string[] = [];
    const log = createLogger({}, (l) => lines.push(l));
    log.info("x", { apiKey: "k", authorization: "Bearer t", webhookSecret: "s", issueId: "BEA-1", nested: { token: "t" } });
    const out = JSON.parse(lines[0]!);
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.authorization).toBe("[REDACTED]");
    expect(out.webhookSecret).toBe("[REDACTED]");
    expect(out.nested.token).toBe("[REDACTED]");
    expect(out.issueId).toBe("BEA-1");
    expect(redact({ LINEAR_API_KEY: "x" }).LINEAR_API_KEY).toBe("[REDACTED]");
  });
});
