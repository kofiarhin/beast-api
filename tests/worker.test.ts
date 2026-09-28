import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent, makeHarness, makeIssue, makeRepo, removeTmpDir, type Harness } from "./helpers.js";

let h: Harness;
afterEach(async () => {
  await h?.worker.idle();
  removeTmpDir(h.root);
});

function enqueue(h: Harness, issueId = "issue-1", project = "TestProject", workspace?: string) {
  return h.store.createJob({
    deliveryId: `d-${issueId}`,
    issue: makeIssue({ id: issueId, identifier: issueId.toUpperCase() }),
    project,
    workspace: workspace ?? path.join(h.workspaceRoot, "test-project"),
    agent: "fake",
    state: "queued",
  });
}

describe("worker", () => {
  it("blocks when the workspace directory is missing", async () => {
    h = makeHarness();
    const job = enqueue(h);
    h.worker.kick();
    await h.worker.idle();
    const done = h.store.getJob(job.id)!;
    expect(done.state).toBe("blocked");
    expect(done.reason).toMatch(/does not exist/);
    expect(h.agent.calls).toHaveLength(0);
    expect(h.linear.comments.at(-1)?.body).toMatch(/Beast: Blocked/);
  });

  it("blocks when the workspace is not a git repository", async () => {
    h = makeHarness();
    fs.mkdirSync(path.join(h.workspaceRoot, "test-project"));
    const job = enqueue(h);
    h.worker.kick();
    await h.worker.idle();
    expect(h.store.getJob(job.id)?.state).toBe("blocked");
    expect(h.agent.calls).toHaveLength(0);
  });

  it("blocks a dirty repository and never touches the changes", async () => {
    h = makeHarness();
    const repo = makeRepo(h.workspaceRoot, "test-project", { dirty: true });
    const job = enqueue(h);
    h.worker.kick();
    await h.worker.idle();
    const done = h.store.getJob(job.id)!;
    expect(done.state).toBe("blocked");
    expect(done.reason).toMatch(/uncommitted/);
    expect(h.agent.calls).toHaveLength(0);
    // Uncommitted work is left exactly as it was.
    expect(fs.readFileSync(path.join(repo, "uncommitted.txt"), "utf8")).toBe("work in progress\n");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toContain("uncommitted.txt");
    expect(execFileSync("git", ["stash", "list"], { cwd: repo, encoding: "utf8" })).toBe("");
  });

  it("blocks when the project is no longer registered", async () => {
    h = makeHarness();
    const job = enqueue(h, "issue-1", "Ghost");
    h.worker.kick();
    await h.worker.idle();
    expect(h.store.getJob(job.id)?.state).toBe("blocked");
    expect(h.agent.calls).toHaveLength(0);
  });

  it("runs the agent in the registered workspace and records verification", async () => {
    const agent = new FakeAgent((req) => {
      fs.writeFileSync(path.join(req.workspace.path, "feature.txt"), "done\n");
      return { summary: "Added feature.txt" };
    });
    h = makeHarness({ agent });
    const repo = makeRepo(h.workspaceRoot, "test-project");
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"", lint: "node -e \"process.exit(1)\"" } }),
    );
    fs.mkdirSync(path.join(repo, "node_modules"));
    execFileSync("git", ["add", "package.json"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "pkg"], { cwd: repo });

    const job = enqueue(h);
    h.worker.kick();
    await h.worker.idle();

    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]!.workspace.path).toBe(repo);
    expect(agent.calls[0]!.prompt).toContain("ISSUE-1");
    expect(agent.calls[0]!.prompt).toContain("MUST NOT");

    const done = h.store.getJob(job.id)!;
    expect(done.state).toBe("completed");
    const v = done.result!.verification!;
    expect(v.changedFiles).toEqual(["feature.txt"]);
    expect(v.checks.find((c) => c.name === "test")?.status).toBe("passed");
    expect(v.checks.find((c) => c.name === "lint")?.status).toBe("failed");
    expect(v.checks.find((c) => c.name === "build")?.status).toBe("skipped");
    expect(v.passed).toBe(false);
    expect(v.newCommits).toBe(false);
    const last = h.linear.comments.at(-1)!.body;
    expect(last).toMatch(/Completed locally/);
    expect(last).toMatch(/Next Action/);
    // Beast never commits: the change stays uncommitted.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toContain("feature.txt");
  });

  it("marks the job failed when the agent exits non-zero", async () => {
    h = makeHarness({ agent: new FakeAgent(() => ({ exitCode: 2 })) });
    makeRepo(h.workspaceRoot, "test-project");
    const job = enqueue(h);
    h.worker.kick();
    await h.worker.idle();
    expect(h.store.getJob(job.id)?.state).toBe("failed");
    expect(h.linear.comments.at(-1)?.body).toMatch(/Beast: Failed/);
  });

  it("executes only one job at a time and processes all of them in order", async () => {
    const agent = new FakeAgent(() => new Promise((r) => setTimeout(() => r({}), 30)));
    h = makeHarness({
      agent,
      projects: (root) => [
        { name: "A", workspace: path.join(root, "a") },
        { name: "B", workspace: path.join(root, "b") },
        { name: "C", workspace: path.join(root, "c") },
      ],
    });
    for (const n of ["a", "b", "c"]) makeRepo(h.workspaceRoot, n);
    const jobs = ["a", "b", "c"].map((n) => enqueue(h, `issue-${n}`, n.toUpperCase(), path.join(h.workspaceRoot, n)));

    h.worker.kick();
    h.worker.kick();
    h.worker.kick();
    await h.worker.idle();

    expect(agent.maxActive).toBe(1);
    expect(agent.calls.map((c) => c.task.project)).toEqual(["A", "B", "C"]);
    for (const j of jobs) expect(h.store.getJob(j.id)?.state).toBe("completed");
  });
});
