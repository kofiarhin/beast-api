import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/agents/codex.js";
import { LinearReporter } from "../src/linear/reporter.js";
import { silentLogger } from "../src/logger.js";
import { JobStore } from "../src/queue/store.js";
import { Worker } from "../src/queue/worker.js";
import { ProjectRegistry } from "../src/registry/registry.js";
import { killActiveProcessGroups, runCommand } from "../src/util/exec.js";
import { FakeLinear, makeIssue, makeRepo, makeTmpDir, removeTmpDir } from "./helpers.js";

let root: string | undefined;
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (root) removeTmpDir(root);
  root = undefined;
});

/** Alive = exists and is not a zombie. */
function isAlive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Waits until the child has written the PID of its background grandchild. */
async function grandchildPid(pidFile: string): Promise<number> {
  const pid = await waitFor(() => {
    const text = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : "";
    return text ? Number(text) : undefined;
  });
  pids.push(pid);
  return pid;
}

async function expectDead(pid: number): Promise<void> {
  await waitFor(() => (isAlive(pid) ? undefined : true));
}

describe("agent process group termination", () => {
  it("on timeout, escalates to SIGKILL for processes that ignore SIGTERM", async () => {
    root = makeTmpDir();
    const pidFile = path.join(root, "pid");
    // Both the shell and its background child ignore SIGTERM.
    const run = runCommand("sh", ["-c", `trap "" TERM; sleep 30 & echo $! > ${pidFile}; wait`], {
      cwd: root,
      timeoutMs: 300,
      killGraceMs: 200,
    });
    const pid = await grandchildPid(pidFile);
    const res = await run;
    expect(res.timedOut).toBe(true);
    await expectDead(pid);
  });

  it("on timeout, kills processes left behind after the leader exits", async () => {
    root = makeTmpDir();
    const pidFile = path.join(root, "pid");
    // Background child ignores SIGTERM and holds no pipes, so the leader's exit
    // alone would leave it running; the grace period is too long to help.
    const run = runCommand(
      "sh",
      ["-c", `(trap "" TERM; exec sleep 30) </dev/null >/dev/null 2>&1 & echo $! > ${pidFile}; wait`],
      { cwd: root, timeoutMs: 300, killGraceMs: 60_000 },
    );
    const pid = await grandchildPid(pidFile);
    const res = await run;
    expect(res.timedOut).toBe(true);
    await expectDead(pid);
  });

  it("stops the whole process group when aborted", async () => {
    root = makeTmpDir();
    const pidFile = path.join(root, "pid");
    const controller = new AbortController();
    const run = runCommand("sh", ["-c", `sleep 30 </dev/null >/dev/null 2>&1 & echo $! > ${pidFile}; wait`], {
      cwd: root,
      signal: controller.signal,
    });
    const pid = await grandchildPid(pidFile);
    controller.abort();
    const res = await run;
    expect(res.aborted).toBe(true);
    expect(res.timedOut).toBe(false);
    await expectDead(pid);
  });

  it("killActiveProcessGroups kills every running child group (used on Beast exit)", async () => {
    root = makeTmpDir();
    const pidFile = path.join(root, "pid");
    const run = runCommand("sh", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], { cwd: root });
    const pid = await grandchildPid(pidFile);
    expect(killActiveProcessGroups("SIGKILL")).toBeGreaterThanOrEqual(1);
    await run;
    await expectDead(pid);
    expect(killActiveProcessGroups("SIGKILL")).toBe(0);
  });
});

describe("worker cancel and shutdown stop the Codex process group", () => {
  function setup() {
    root = makeTmpDir();
    const workspaceRoot = path.join(root, "projects");
    const repo = makeRepo(workspaceRoot, "test-project");
    const pidFile = path.join(root, "pid");
    // Stand-in codex: starts a detached-stdio background process and waits forever.
    const bin = path.join(root, "fake-codex.sh");
    fs.writeFileSync(bin, `#!/bin/sh\nsleep 30 </dev/null >/dev/null 2>&1 &\necho $! > ${pidFile}\nwait\n`, {
      mode: 0o755,
    });
    const store = new JobStore(path.join(root, "data"));
    const linear = new FakeLinear();
    const worker = new Worker({
      store,
      registry: new ProjectRegistry([{ name: "TestProject", workspace: repo }], workspaceRoot),
      adapter: new CodexAdapter({ bin }),
      reporter: new LinearReporter(linear, silentLogger),
      logger: silentLogger,
      logDir: path.join(root, "data", "logs"),
      agentTimeoutMs: 60_000,
      verifyTimeoutMs: 10_000,
      verifyScripts: ["test"],
    });
    const enqueue = (id: string) =>
      store.createJob({
        deliveryId: `d-${id}`,
        issue: makeIssue({ id, identifier: id.toUpperCase() }),
        project: "TestProject",
        workspace: repo,
        agent: "codex",
        state: "queued",
      });
    return { store, linear, worker, enqueue, pidFile };
  }

  it("cancel() terminates the running agent and marks the job failed", async () => {
    const { store, linear, worker, enqueue, pidFile } = setup();
    const job = enqueue("issue-1");
    worker.kick();
    const pid = await grandchildPid(pidFile);

    expect(worker.cancel("some-other-job")).toBe(false);
    expect(worker.cancel(job.id)).toBe(true);
    await worker.idle();

    await expectDead(pid);
    const done = store.getJob(job.id)!;
    expect(done.state).toBe("failed");
    expect(done.reason).toBe("Agent was stopped: Job cancelled");
    expect(done.result?.verification?.checks).toEqual([]);
    expect(linear.comments.at(-1)?.body).toMatch(/Beast: Failed/);
  });

  it("shutdown() terminates the running agent and starts no further jobs", async () => {
    const { store, worker, enqueue, pidFile } = setup();
    const first = enqueue("issue-1");
    const second = enqueue("issue-2");
    worker.kick();
    const pid = await grandchildPid(pidFile);

    await worker.shutdown();

    await expectDead(pid);
    expect(store.getJob(first.id)?.state).toBe("failed");
    expect(store.getJob(first.id)?.reason).toBe("Agent was stopped: Beast API shutting down");
    expect(store.getJob(second.id)?.state).toBe("queued");
    worker.kick();
    expect(worker.busy).toBe(false);
  });
});
