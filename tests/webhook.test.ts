import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, makeIssue, makeRepo, READY, removeTmpDir, sign, webhookBody, type Harness } from "./helpers.js";

let h: Harness;
afterEach(async () => {
  await h?.worker.idle();
  removeTmpDir(h.root);
});

function post(body: string, headers: Record<string, string> = {}) {
  return request(h.app)
    .post("/webhooks/linear")
    .set("Content-Type", "application/json")
    .set(headers)
    .send(body);
}

describe("GET /health", () => {
  it("returns ok with job counts", async () => {
    h = makeHarness();
    const res = await request(h.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.jobs.queued).toBe(0);
  });
});

describe("POST /webhooks/linear", () => {
  it("rejects an invalid signature", async () => {
    h = makeHarness({ issues: { "issue-1": makeIssue() } });
    const body = webhookBody(makeIssue());
    const res = await post(body, { "Linear-Signature": sign(body, "wrong-secret"), "Linear-Delivery": "d1" });
    expect(res.status).toBe(401);
    expect(h.store.listJobs()).toHaveLength(0);
    expect(h.agent.calls).toHaveLength(0);
  });

  it("rejects a missing signature", async () => {
    h = makeHarness();
    const res = await post(webhookBody(makeIssue()), { "Linear-Delivery": "d1" });
    expect(res.status).toBe(401);
  });

  it("rejects a tampered body", async () => {
    h = makeHarness();
    const body = webhookBody(makeIssue());
    const res = await post(body.replace("Add a feature", "Something else"), { "Linear-Signature": sign(body) });
    expect(res.status).toBe(401);
  });

  it("rejects a stale timestamp (replay)", async () => {
    h = makeHarness({ issues: { "issue-1": makeIssue() } });
    const body = webhookBody(makeIssue(), { timestamp: Date.now() - 10 * 60_000 });
    const res = await post(body, { "Linear-Signature": sign(body), "Linear-Delivery": "d1" });
    expect(res.status).toBe(401);
    expect(h.store.listJobs()).toHaveLength(0);
  });

  it("accepts a valid webhook, queues a job and returns without waiting for the agent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { FakeAgent } = await import("./helpers.js");
    h = makeHarness({ issues: { "issue-1": makeIssue() }, agent: new FakeAgent(() => gate.then(() => ({}))) });
    makeRepo(h.workspaceRoot, "test-project");

    const body = webhookBody(makeIssue());
    const res = await post(body, { "Linear-Signature": sign(body), "Linear-Delivery": "d1" });
    expect(res.status).toBe(202);
    expect(res.body.outcome).toBe("queued");

    const job = await request(h.app).get(`/jobs/${res.body.jobId}`);
    expect(job.status).toBe(200);
    expect(["queued", "working"]).toContain(job.body.state);
    expect(h.linear.comments.some((c) => c.body.includes("Beast: Queued"))).toBe(true);

    release();
    await h.worker.idle();
    expect(h.store.getJob(res.body.jobId)?.state).toBe("completed");
  });

  it("ignores issues without the Beast Ready label", async () => {
    const issue = makeIssue({ labels: [{ id: "l-bug", name: "Bug" }] });
    h = makeHarness({ issues: { "issue-1": issue } });
    makeRepo(h.workspaceRoot, "test-project");
    const body = webhookBody(issue);
    const res = await post(body, { "Linear-Signature": sign(body), "Linear-Delivery": "d1" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("ignored");
    expect(h.store.listJobs()).toHaveLength(0);
    expect(h.agent.calls).toHaveLength(0);
  });

  it("uses the Linear API labels, not the payload, for authorization", async () => {
    // Payload claims the label, but Linear says it is gone.
    h = makeHarness({ issues: { "issue-1": makeIssue({ labels: [] }) } });
    const body = webhookBody(makeIssue());
    const res = await post(body, { "Linear-Signature": sign(body), "Linear-Delivery": "d1" });
    expect(res.body.outcome).toBe("ignored");
    expect(h.linear.fetchCalls).toBe(1);
  });

  it("does not re-trigger on updates when the label was already present", async () => {
    h = makeHarness({ issues: { "issue-1": makeIssue() } });
    const body = webhookBody(makeIssue(), { action: "update", previousLabelIds: ["label-ready"] });
    const res = await post(body, { "Linear-Signature": sign(body), "Linear-Delivery": "d1" });
    expect(res.body.outcome).toBe("ignored");
    expect(h.store.listJobs()).toHaveLength(0);
  });

  it("triggers on an update that newly adds the ready label", async () => {
    h = makeHarness({ issues: { "issue-1": makeIssue() }, autoKick: false });
    const body = webhookBody(makeIssue(), { action: "update", previousLabelIds: [] });
    const res = await post(body, { "Linear-Signature": sign(body), "Linear-Delivery": "d1" });
    expect(res.body.outcome).toBe("queued");
  });

  it("does not create duplicate executions for duplicate deliveries", async () => {
    h = makeHarness({ issues: { "issue-1": makeIssue() } });
    makeRepo(h.workspaceRoot, "test-project");
    const body = webhookBody(makeIssue());
    const headers = { "Linear-Signature": sign(body), "Linear-Delivery": "same-delivery" };
    const first = await post(body, headers);
    const second = await post(body, headers);
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("duplicate");
    await h.worker.idle();
    expect(h.store.listJobs()).toHaveLength(1);
    expect(h.agent.calls).toHaveLength(1);
  });

  it("does not enqueue the same issue twice while a job is active", async () => {
    h = makeHarness({ issues: { "issue-1": makeIssue() }, autoKick: false });
    const b1 = webhookBody(makeIssue());
    const b2 = webhookBody(makeIssue(), { action: "update", previousLabelIds: [] });
    await post(b1, { "Linear-Signature": sign(b1), "Linear-Delivery": "d1" });
    const res = await post(b2, { "Linear-Signature": sign(b2), "Linear-Delivery": "d2" });
    expect(res.body.outcome).toBe("ignored");
    expect(res.body.reason).toMatch(/active job/);
    expect(h.store.listJobs()).toHaveLength(1);
  });

  it("blocks unknown projects without launching an agent and reports to Linear", async () => {
    const issue = makeIssue({ project: { id: "p-x", name: "Unregistered Thing" } });
    h = makeHarness({ issues: { "issue-1": issue } });
    const body = webhookBody(issue);
    const res = await post(body, { "Linear-Signature": sign(body), "Linear-Delivery": "d1" });
    expect(res.body.outcome).toBe("blocked");
    await h.worker.idle();
    expect(h.store.getJob(res.body.jobId)?.state).toBe("blocked");
    expect(h.agent.calls).toHaveLength(0);
    expect(h.linear.comments.some((c) => c.body.includes("Beast: Blocked") && c.body.includes("Next Action"))).toBe(true);
  });

  it("ignores non-issue events", async () => {
    h = makeHarness();
    const body = JSON.stringify({ type: "Comment", action: "create", webhookTimestamp: Date.now(), data: { id: "c1" } });
    const res = await post(body, { "Linear-Signature": sign(body), "Linear-Delivery": "d1" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("ignored");
  });

  it("returns 404 for unknown jobs", async () => {
    h = makeHarness();
    expect((await request(h.app).get("/jobs/nope")).status).toBe(404);
  });

  it("matches the ready label from configuration", async () => {
    h = makeHarness({ issues: { "issue-1": makeIssue({ labels: [{ id: "x", name: READY.toLowerCase() }] }) }, autoKick: false });
    const body = webhookBody(makeIssue());
    const res = await post(body, { "Linear-Signature": sign(body), "Linear-Delivery": "d1" });
    expect(res.body.outcome).toBe("queued");
  });
});
