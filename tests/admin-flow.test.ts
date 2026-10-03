import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog, verifyAuditChain } from "../src/admin/audit.js";
import { APPROVAL_TTL_MS, parseApprovalCommand } from "../src/admin/service.js";
import type { LinearIssue } from "../src/linear/types.js";
import { ADMIN, APPROVER, BEAST_USER, REQUESTER, adminIssue, commentBody, makeAdminHarness, policyWith, type AdminHarness } from "./admin-helpers.js";
import { READY, makeHarness, removeTmpDir, sign, webhookBody } from "./helpers.js";

let h: AdminHarness;
afterEach(async () => {
  await h?.admin.idle();
  removeTmpDir(h.root);
});

function post(body: string) {
  return request(h.app)
    .post("/webhooks/linear")
    .set("Content-Type", "application/json")
    .set({ "Linear-Signature": sign(body), "Linear-Delivery": randomUUID() })
    .send(body);
}

/** Register the issue with fake Linear and add the admin label as `adder`. */
async function requestAdmin(issue: LinearIssue, adder: string | null = REQUESTER) {
  h.linear.issues[issue.id] = issue;
  h.linear.labelAdders[`${issue.id}:label-admin`] = adder;
  const res = await post(webhookBody(issue));
  await h.admin.idle();
  return res;
}

let commentSeq = 0;
async function comment(issueId: string, body: string, opts: { userId?: string | null; edited?: boolean; onIssue?: string } = {}) {
  const id = `comment-${++commentSeq}`;
  h.linear.apiComments[id] = {
    id,
    body,
    issueId: opts.onIssue ?? issueId,
    userId: opts.userId === undefined ? APPROVER : opts.userId,
    edited: opts.edited ?? false,
  };
  const res = await post(commentBody({ id, body, issueId: opts.onIssue ?? issueId }));
  await h.admin.idle();
  return res;
}

const lastJob = () => h.store.listAdminJobs().at(-1)!;
const commentsFor = (issueId: string) => h.linear.comments.filter((c) => c.issueId === issueId).map((c) => c.body);

function chownIssue(dir: string, extra: Partial<LinearIssue> = {}) {
  return adminIssue("filesystem.chown", { path: dir, owner: "www-data", group: "www-data", recursive: true }, extra);
}

function makeDir(name = "uploads"): string {
  const dir = path.join(h.root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("class A and B: Beast authorization, no separate approval", () => {
  it("runs a class A inspection for an authorized requester", async () => {
    h = makeAdminHarness();
    const issue = adminIssue("service.status", { unit: "nginx.service" });
    const res = await requestAdmin(issue);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "admin", state: "queued" });
    expect(h.executor.executed).toHaveLength(1);
    expect(h.executor.executed[0]!.grant).toMatchObject({ riskClass: "A", requesterId: REQUESTER, digest: null });
    expect(lastJob().state).toBe("succeeded");
    expect(commentsFor(issue.id).some((c) => c.includes("Beast Admin: Succeeded"))).toBe(true);
  });

  it("runs a class B restart without an approval comment", async () => {
    h = makeAdminHarness();
    await requestAdmin(adminIssue("pm2.restart", { app: "ideahub-api" }));
    expect(h.executor.executed.map((e) => e.op.op)).toEqual(["pm2.restart"]);
    expect(lastJob()).toMatchObject({ state: "succeeded", riskClass: "B" });
  });

  it("denies a requester who is not on the allowlist", async () => {
    h = makeAdminHarness();
    await requestAdmin(adminIssue("service.status", { unit: "nginx.service" }), "user-stranger");
    expect(h.executor.executed).toHaveLength(0);
    expect(lastJob()).toMatchObject({ state: "denied" });
    expect(lastJob().reason).toMatch(/not an authorized requester/);
  });

  it("denies when the label adder cannot be determined (ambiguous authorization)", async () => {
    h = makeAdminHarness();
    await requestAdmin(adminIssue("service.status", { unit: "nginx.service" }), null);
    expect(h.executor.executed).toHaveLength(0);
    expect(lastJob().reason).toMatch(/Could not determine/);
  });

  it("denies invalid requests before anything executes and says why", async () => {
    h = makeAdminHarness();
    const issue = adminIssue("service.restart", { unit: "nginx.service; rm -rf /" });
    await requestAdmin(issue);
    expect(h.executor.executed).toHaveLength(0);
    expect(lastJob()).toMatchObject({ state: "denied" });
    expect(commentsFor(issue.id).join("\n")).toMatch(/Beast Admin: Denied[\s\S]*shell_syntax/);
  });

  it("re-validates at execution time and denies when the target disappeared", async () => {
    h = makeAdminHarness();
    const issue = adminIssue("pm2.restart", { app: "ideahub-api" });
    h.linear.issues[issue.id] = issue;
    h.linear.labelAdders[`${issue.id}:label-admin`] = REQUESTER;
    // Hold the worker until the app vanishes.
    const original = h.admin.kick.bind(h.admin);
    h.admin.kick = () => undefined;
    await post(webhookBody(issue));
    h.probe.apps = [];
    h.admin.kick = original;
    h.admin.kick();
    await h.admin.idle();
    expect(h.executor.executed).toHaveLength(0);
    expect(lastJob().reason).toMatch(/Re-validation failed/);
  });
});

describe("class C: exact, scope-bound approval", () => {
  async function plan(dir = makeDir(), issue = chownIssue(dir)) {
    await requestAdmin(issue);
    const job = lastJob();
    expect(job.state).toBe("awaiting_approval");
    return { job, issue, dir };
  }

  it("posts a plan with the exact digest and executes nothing until approved", async () => {
    h = makeAdminHarness();
    const { job, issue } = await plan();
    expect(job.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(h.executor.executed).toHaveLength(0);
    const planComment = commentsFor(issue.id).find((c) => c.includes("Approval required"))!;
    expect(planComment).toContain(`/beast approve ${job.digest}`);
    expect(planComment).toContain('"recursive": true');
    expect(Date.parse(job.expiresAt!) - h.clock.now).toBe(APPROVAL_TTL_MS);
  });

  it("executes once after an exact approval from an authorized approver", async () => {
    h = makeAdminHarness();
    const { job, issue } = await plan();
    await comment(issue.id, `/beast approve ${job.digest}`);
    expect(h.executor.executed).toHaveLength(1);
    expect(h.executor.executed[0]!.grant).toMatchObject({ riskClass: "C", digest: job.digest, approverId: APPROVER });
    expect(lastJob().state).toBe("succeeded");
  });

  it("fails without an approval and expires after 15 minutes", async () => {
    h = makeAdminHarness();
    const { job } = await plan();
    h.clock.now += APPROVAL_TTL_MS + 1;
    await h.admin.sweepExpired();
    expect(h.store.getAdminJob(job.id)!.state).toBe("expired");
    expect(h.executor.executed).toHaveLength(0);
  });

  it("rejects an approval that arrives after expiry", async () => {
    h = makeAdminHarness();
    const { job, issue } = await plan();
    h.clock.now += APPROVAL_TTL_MS + 1;
    await comment(issue.id, `/beast approve ${job.digest}`);
    expect(h.executor.executed).toHaveLength(0);
    expect(h.store.getAdminJob(job.id)!.state).toBe("expired");
  });

  it("rejects a wrong digest, a non-approver, Beast's own comment, another issue and an edited comment", async () => {
    h = makeAdminHarness({ approvers: [APPROVER, BEAST_USER] });
    const { job, issue } = await plan();
    const exact = `/beast approve ${job.digest}`;
    await comment(issue.id, `/beast approve ${"0".repeat(64)}`);
    await comment(issue.id, exact, { userId: "user-stranger" });
    await comment(issue.id, exact, { userId: BEAST_USER });
    await comment(issue.id, exact, { userId: null });
    await comment(issue.id, exact, { onIssue: "some-other-issue" });
    await comment(issue.id, exact, { edited: true });
    expect(h.executor.executed).toHaveLength(0);
    expect(h.store.getAdminJob(job.id)!.state).toBe("awaiting_approval");
  });

  it("ignores comments that are not exactly the approval command", async () => {
    h = makeAdminHarness();
    const { job, issue } = await plan();
    for (const body of [`Looks good! /beast approve ${job.digest}`, `/beast approve ${job.digest} please`, `/beast approve ${job.digest!.slice(0, 16)}`, `/beast approve ${job.digest}\nand also restart ssh`]) {
      await comment(issue.id, body);
    }
    expect(h.executor.executed).toHaveLength(0);
    expect(parseApprovalCommand(`  /beast approve ${job.digest}\n`)).toEqual({ action: "approve", digest: job.digest });
  });

  it("cancels on /beast deny", async () => {
    h = makeAdminHarness();
    const { job, issue } = await plan();
    await comment(issue.id, `/beast deny ${job.digest}`);
    expect(h.store.getAdminJob(job.id)!.state).toBe("cancelled");
    expect(h.executor.executed).toHaveLength(0);
  });

  it("an approval cannot authorize a different operation or scope", async () => {
    h = makeAdminHarness();
    const first = await plan(makeDir("a"));
    // A second plan on another issue for a different scope has a different digest.
    const otherDir = makeDir("b");
    const other = chownIssue(otherDir, { id: "admin-issue-2", identifier: "IDE-901" });
    await requestAdmin(other);
    const second = lastJob();
    expect(second.digest).not.toBe(first.job.digest);
    // Approving the first digest on the second issue does nothing.
    await comment(other.id, `/beast approve ${first.job.digest}`);
    expect(h.executor.executed).toHaveLength(0);
    expect(h.store.getAdminJob(second.id)!.state).toBe("awaiting_approval");
  });

  it("voids the approval when the parameters change after approval", async () => {
    h = makeAdminHarness();
    const { job, issue, dir } = await plan();
    const original = h.admin.kick.bind(h.admin);
    h.admin.kick = () => undefined;
    await comment(issue.id, `/beast approve ${job.digest}`);
    // Someone edits the ticket to a different owner after approving.
    h.linear.issues[issue.id] = adminIssue("filesystem.chown", { path: dir, owner: "root", group: "root", recursive: true });
    h.admin.kick = original;
    h.admin.kick();
    await h.admin.idle();
    expect(h.executor.executed).toHaveLength(0);
    expect(lastJob().reason).toMatch(/description changed/);
  });

  it("voids the approval when the target changes after approval (different inode)", async () => {
    h = makeAdminHarness();
    const { job, issue, dir } = await plan();
    const original = h.admin.kick.bind(h.admin);
    h.admin.kick = () => undefined;
    await comment(issue.id, `/beast approve ${job.digest}`);
    // Swap in a different directory at the same path (created first, so its inode differs).
    const replacement = makeDir("replacement");
    fs.rmSync(dir, { recursive: true });
    fs.renameSync(replacement, dir);
    h.admin.kick = original;
    h.admin.kick();
    await h.admin.idle();
    expect(h.executor.executed).toHaveLength(0);
    expect(lastJob().reason).toMatch(/changed since approval/);
  });

  it("an approval can be used only once", async () => {
    h = makeAdminHarness();
    const { job, issue } = await plan();
    const original = h.admin.kick.bind(h.admin);
    h.admin.kick = () => undefined;
    await comment(issue.id, `/beast approve ${job.digest}`);
    expect(h.store.consumeApproval(job.nonce!, "someone-else")).toBe(true);
    h.admin.kick = original;
    h.admin.kick();
    await h.admin.idle();
    expect(h.executor.executed).toHaveLength(0);
    expect(lastJob().reason).toMatch(/already been used/);
    // And a repeated approval comment finds no pending plan.
    await comment(issue.id, `/beast approve ${job.digest}`);
    expect(h.executor.executed).toHaveLength(0);
  });

  it("cancels when the admin label is removed before execution", async () => {
    h = makeAdminHarness();
    const { job, issue } = await plan();
    const original = h.admin.kick.bind(h.admin);
    h.admin.kick = () => undefined;
    await comment(issue.id, `/beast approve ${job.digest}`);
    h.linear.issues[issue.id] = { ...issue, labels: [] };
    h.admin.kick = original;
    h.admin.kick();
    await h.admin.idle();
    expect(h.executor.executed).toHaveLength(0);
    expect(lastJob().state).toBe("cancelled");
  });

  it("flags protected targets in the plan and still requires the exact approval", async () => {
    h = makeAdminHarness();
    const issue = adminIssue("service.restart", { unit: "ssh.service" });
    await requestAdmin(issue);
    const job = lastJob();
    expect(job).toMatchObject({ state: "awaiting_approval", riskClass: "C", protected: true });
    expect(commentsFor(issue.id).join("\n")).toContain("PROTECTED TARGET");
    await comment(issue.id, `/beast approve ${job.digest}`);
    expect(h.executor.executed.map((e) => e.op.protected)).toEqual([true]);
  });

  it("allows one person to request and approve (decision Q7)", async () => {
    h = makeAdminHarness({ requesters: ["solo"], approvers: ["solo"] });
    const dir = makeDir();
    const issue = chownIssue(dir);
    await requestAdmin(issue, "solo");
    await comment(issue.id, `/beast approve ${lastJob().digest}`, { userId: "solo" });
    expect(h.executor.executed).toHaveLength(1);
  });

  it("rejects Beast's own Linear user as approver unless the identity is explicitly shared", async () => {
    h = makeAdminHarness({ requesters: [BEAST_USER], approvers: [BEAST_USER] });
    const dir = makeDir();
    const issue = chownIssue(dir);
    await requestAdmin(issue, BEAST_USER);
    await comment(issue.id, `/beast approve ${lastJob().digest}`, { userId: BEAST_USER });
    expect(h.executor.executed).toHaveLength(0);
    expect(lastJob().state).toBe("awaiting_approval");
  });

  it("with a shared identity, accepts the human's approval but never a comment Beast posted", async () => {
    h = makeAdminHarness({ requesters: [BEAST_USER], approvers: [BEAST_USER], sharedIdentity: true });
    const dir = makeDir();
    const issue = chownIssue(dir);
    await requestAdmin(issue, BEAST_USER);
    // A comment Beast itself posted, even with the exact approval text, is rejected.
    h.linear.ownCommentIds.add(`comment-${commentSeq + 1}`);
    await comment(issue.id, `/beast approve ${lastJob().digest}`, { userId: BEAST_USER });
    expect(h.executor.executed).toHaveLength(0);
    // The same user's own new comment is accepted.
    await comment(issue.id, `/beast approve ${lastJob().digest}`, { userId: BEAST_USER });
    expect(h.executor.executed).toHaveLength(1);
  });
});

describe("separation from coding jobs", () => {
  it("blocks a coding job on an issue that also carries the admin label", async () => {
    h = makeAdminHarness();
    const issue = adminIssue("nginx.test", undefined, {
      labels: [
        { id: "label-admin", name: ADMIN },
        { id: "label-ready", name: READY },
      ],
    });
    h.linear.issues[issue.id] = issue;
    h.linear.labelAdders[`${issue.id}:label-admin`] = REQUESTER;
    const res = await post(webhookBody(issue));
    await h.admin.idle();
    expect(res.body.outcome).toBe("blocked");
    expect(h.store.listJobs()[0]).toMatchObject({ state: "blocked" });
    expect(h.store.listAdminJobs()[0]).toMatchObject({ state: "denied" });
    expect(h.executor.executed).toHaveLength(0);
    expect(h.agent.calls).toHaveLength(0);
  });

  it("ignores admin labels and approval comments when admin mode is off", async () => {
    const plain = makeHarness();
    h = { ...plain } as AdminHarness;
    h.admin = { idle: async () => undefined } as AdminHarness["admin"];
    const issue = adminIssue("nginx.test");
    plain.linear.issues[issue.id] = issue;
    const res = await post(webhookBody(issue));
    expect(res.body).toMatchObject({ outcome: "ignored", reason: "admin operations are disabled" });
    const c = await post(commentBody({ id: "c1", body: `/beast approve ${"a".repeat(64)}`, issueId: issue.id }));
    expect(c.body).toMatchObject({ outcome: "ignored" });
    expect(plain.store.listJobs()).toHaveLength(0);
  });
});

describe("executor failures and results", () => {
  it("records an executor error as failed, without retrying", async () => {
    h = makeAdminHarness();
    h.executor.behaviour = () => {
      throw new Error("broker exploded");
    };
    await requestAdmin(adminIssue("pm2.restart", { app: "ideahub-api" }));
    expect(h.executor.executed).toHaveLength(1);
    expect(lastJob()).toMatchObject({ state: "failed" });
    expect(lastJob().reason).toMatch(/executor error: broker exploded/);
  });

  it("keeps secrets out of results, Linear comments and the audit log", async () => {
    const secret = "sk-ant-api03-" + "S".repeat(40);
    h = makeAdminHarness();
    h.executor.behaviour = () => ({ status: "succeeded", fields: { note: `token ${secret}` }, output: `line 1\nAPI_KEY=${secret}\nline 3` });
    const issue = adminIssue("system.logs", { app: "ideahub-api", lines: 20 });
    await requestAdmin(issue);
    expect(lastJob().state).toBe("succeeded");
    expect(JSON.stringify(lastJob())).not.toContain(secret);
    expect(commentsFor(issue.id).join("\n")).not.toContain(secret);
    expect(fs.readFileSync(h.audit.file, "utf8")).not.toContain(secret);
  });
});

describe("audit log", () => {
  it("records every decision in a verifiable hash chain and detects tampering", async () => {
    h = makeAdminHarness();
    await requestAdmin(adminIssue("nginx.test"));
    const check = verifyAuditChain(h.audit.file);
    expect(check).toMatchObject({ ok: true });
    const events = fs.readFileSync(h.audit.file, "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
    expect(events).toEqual(["request.received", "request.authorized", "execution.started", "execution.finished"]);

    const lines = fs.readFileSync(h.audit.file, "utf8").split("\n");
    lines[1] = lines[1]!.replace("nginx.test", "nginx.reload");
    fs.writeFileSync(h.audit.file, lines.join("\n"));
    expect(verifyAuditChain(h.audit.file)).toMatchObject({ ok: false, line: 2 });
    expect(() => new AuditLog(h.audit.file).append("x", {})).toThrow(/failed verification/);
  });

  it("does not execute when the audit log is unavailable", async () => {
    h = makeAdminHarness();
    const issue = adminIssue("nginx.test");
    h.linear.issues[issue.id] = issue;
    h.linear.labelAdders[`${issue.id}:label-admin`] = REQUESTER;
    const original = h.admin.kick.bind(h.admin);
    h.admin.kick = () => undefined;
    await post(webhookBody(issue));
    const append = h.audit.append.bind(h.audit);
    h.audit.append = (event, data) => {
      if (event === "execution.started") throw new Error("disk full");
      return append(event, data);
    };
    h.admin.kick = original;
    h.admin.kick();
    await h.admin.idle();
    expect(h.executor.executed).toHaveLength(0);
    expect(lastJob().reason).toMatch(/Audit log unavailable/);
  });
});

describe("policy gate", () => {
  it("denies operations that are not enabled", async () => {
    h = makeAdminHarness({ policy: policyWith(["nginx.test"]) });
    await requestAdmin(adminIssue("pm2.restart", { app: "ideahub-api" }));
    expect(h.executor.executed).toHaveLength(0);
    expect(lastJob().reason).toMatch(/operation_disabled/);
  });
});
