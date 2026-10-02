import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { captureGitSnapshot, detectApprovalViolations } from "../src/workspace/approval.js";
import { FakeAgent, makeHarness, makeIssue, makeRepo, makeTmpDir, removeTmpDir, type Harness } from "./helpers.js";

const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false"];
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

describe("approval snapshot", () => {
  let root: string;
  afterEach(() => removeTmpDir(root));

  async function violationsAfter(change: (repo: string) => void): Promise<string[]> {
    root = makeTmpDir();
    const repo = makeRepo(root, "repo");
    const before = await captureGitSnapshot(repo);
    change(repo);
    return detectApprovalViolations(before, await captureGitSnapshot(repo));
  }

  it("reports nothing for uncommitted file edits", async () => {
    expect(await violationsAfter((repo) => fs.writeFileSync(path.join(repo, "a.txt"), "x\n"))).toEqual([]);
  });

  it("detects a commit once, as a HEAD move", async () => {
    const v = await violationsAfter((repo) => {
      fs.writeFileSync(path.join(repo, "a.txt"), "x\n");
      run(repo, "add", "a.txt");
      run(repo, ...GIT_ID, "commit", "-q", "-m", "sneaky");
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/moved HEAD/);
  });

  it("detects a stash", async () => {
    const v = await violationsAfter((repo) => {
      fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
      run(repo, ...GIT_ID, "stash", "-q");
    });
    expect(v).toContain("changed the stash");
  });

  it("detects branch creation and switching", async () => {
    const v = await violationsAfter((repo) => run(repo, "switch", "-q", "-c", "other"));
    expect(v).toContain("switched branch from refs/heads/main to refs/heads/other");
    expect(v).toContain("created refs/heads/other");
  });

  it("detects tags and remote changes", async () => {
    const v = await violationsAfter((repo) => {
      run(repo, "tag", "v1");
      run(repo, "remote", "add", "origin", "https://example.invalid/repo.git");
    });
    expect(v).toContain("created refs/tags/v1");
    expect(v).toContain("changed Git remotes");
  });

  it("detects remote-tracking ref updates (push)", async () => {
    root = makeTmpDir();
    const repo = makeRepo(root, "repo");
    const bare = path.join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    run(repo, "remote", "add", "origin", bare);
    run(repo, "push", "-q", "origin", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "x\n");
    run(repo, "add", "a.txt");
    run(repo, ...GIT_ID, "commit", "-q", "-m", "c2");

    const before = await captureGitSnapshot(repo);
    run(repo, "push", "-q", "origin", "main");
    const v = detectApprovalViolations(before, await captureGitSnapshot(repo));
    expect(v).toEqual(["updated refs/remotes/origin/main (push or fetch)"]);
  });
});

describe("worker approval enforcement", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.worker.idle();
    removeTmpDir(h.root);
  });

  function enqueue(h: Harness) {
    return h.store.createJob({
      deliveryId: "d-1",
      issue: makeIssue(),
      project: "TestProject",
      workspace: path.join(h.workspaceRoot, "test-project"),
      agent: "fake",
      state: "queued",
    });
  }

  it("fails a job whose agent committed, and leaves the commit in place", async () => {
    const agent = new FakeAgent((req) => {
      fs.writeFileSync(path.join(req.workspace.path, "feature.txt"), "done\n");
      run(req.workspace.path, "add", "feature.txt");
      run(req.workspace.path, ...GIT_ID, "commit", "-q", "-m", "agent commit");
      return { summary: "Committed it" };
    });
    h = makeHarness({ agent });
    const repo = makeRepo(h.workspaceRoot, "test-project");
    const job = enqueue(h);
    h.worker.kick();
    await h.worker.idle();

    const done = h.store.getJob(job.id)!;
    expect(done.state).toBe("failed");
    expect(done.reason).toMatch(/approval-gated Git action/);
    expect(done.result!.verification!.approvalViolations[0]).toMatch(/moved HEAD/);
    expect(done.result!.verification!.passed).toBe(false);
    const comment = h.linear.comments.at(-1)!.body;
    expect(comment).toMatch(/Beast: Failed/);
    expect(comment).toMatch(/Approval-gated Git actions performed without approval/);
    // Beast reports, it does not undo: the agent's commit is still there.
    expect(run(repo, "log", "--format=%s", "-1").trim()).toBe("agent commit");
  });

  it("fails a job whose agent switched branches", async () => {
    h = makeHarness({ agent: new FakeAgent((req) => (run(req.workspace.path, "switch", "-q", "-c", "agent-branch"), {})) });
    makeRepo(h.workspaceRoot, "test-project");
    const job = enqueue(h);
    h.worker.kick();
    await h.worker.idle();
    const done = h.store.getJob(job.id)!;
    expect(done.state).toBe("failed");
    expect(done.reason).toMatch(/switched branch/);
  });

  it("still completes a job that only edited files", async () => {
    h = makeHarness({ agent: new FakeAgent((req) => (fs.writeFileSync(path.join(req.workspace.path, "f.txt"), "x\n"), {})) });
    makeRepo(h.workspaceRoot, "test-project");
    const job = enqueue(h);
    h.worker.kick();
    await h.worker.idle();
    const done = h.store.getJob(job.id)!;
    expect(done.state).toBe("completed");
    expect(done.result!.verification!.approvalViolations).toEqual([]);
  });
});
