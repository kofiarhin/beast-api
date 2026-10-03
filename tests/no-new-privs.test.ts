import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../src/agents/codex.js";
import type { ValidatedWorkspace } from "../src/workspace/validate.js";
import { runCommand, SETPRIV_BIN } from "../src/util/exec.js";
import { ESCALATION_BLOCKED_DETAIL, verifyWorkspace } from "../src/verify/verify.js";
import { makeRepo, makeTmpDir, removeTmpDir } from "./helpers.js";

/**
 * Ordinary agent and verification jobs must be unable to gain sudo/root privileges.
 * Every child Beast starts runs under no-new-privs, so setuid escalation is refused by
 * the kernel, regardless of the host's sudoers configuration.
 */
let root: string;
beforeEach(() => (root = makeTmpDir()));
afterEach(() => {
  vi.restoreAllMocks();
  removeTmpDir(root);
});

const has = (bin: string) => ["/usr/bin", "/bin", "/usr/sbin"].some((d) => fs.existsSync(path.join(d, bin)));

describe("no-new-privs for every child process", () => {
  it("sets NoNewPrivs on the child and on everything it starts", async () => {
    const res = await runCommand("sh", ["-c", "grep NoNewPrivs /proc/self/status; sh -c 'grep NoNewPrivs /proc/self/status'"], { cwd: root });
    expect(res.stdout.match(/NoNewPrivs:\s+1/g)).toHaveLength(2);
  });

  it.skipIf(!has("sudo"))("sudo cannot raise privileges", async () => {
    const res = await runCommand("sudo", ["-n", "true"], { cwd: root });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/no new privileges/);
    const id = await runCommand("sudo", ["-n", "id", "-u"], { cwd: root });
    expect(id.stdout.trim()).not.toBe("0");
  });

  it.skipIf(!has("su"))("su cannot switch to root", async () => {
    const res = await runCommand("su", ["-c", "id -u", "root"], { cwd: root, input: "" });
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout.trim()).not.toBe("0");
  });

  it.skipIf(!has("pkexec"))("pkexec cannot raise privileges", async () => {
    const res = await runCommand("pkexec", ["true"], { cwd: root });
    expect(res.exitCode).not.toBe(0);
  });

  it("refuses to run anything when setpriv is unavailable (fail closed)", async () => {
    const real = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation((p) => (p === SETPRIV_BIN ? false : real(p)));
    const marker = path.join(root, "ran");
    const res = await runCommand("touch", [marker], { cwd: root });
    expect(res.spawnError).toMatch(/refusing to run touch without no-new-privs/);
    expect(real(marker)).toBe(false);
  });

  it("still reports a missing binary as a spawn error", async () => {
    const res = await runCommand("definitely-not-a-binary-xyz", [], { cwd: root });
    expect(res.spawnError).toMatch(/ENOENT/);
  });
});

describe("ordinary jobs cannot escalate", () => {
  it("the coding agent runs under no-new-privs", async () => {
    const out = path.join(root, "agent-status.txt");
    const bin = path.join(root, "fake-codex");
    fs.writeFileSync(bin, `#!/bin/sh\ngrep NoNewPrivs /proc/self/status > ${out}\nsudo -n true 2>> ${out}; echo "sudo=$?" >> ${out}\n`, { mode: 0o755 });
    const repo = makeRepo(root, "repo");
    const workspace = { project: "p", path: repo, headBefore: null } as ValidatedWorkspace;
    const result = await new CodexAdapter({ bin }).run({
      task: { jobId: "j", issueId: "i", identifier: "X-1", title: "t", description: "", url: null, project: "p", workspacePath: repo },
      workspace,
      prompt: "hi",
      timeoutMs: 10_000,
      logFile: path.join(root, "agent.log"),
    });
    expect(result.exitCode).toBe(0);
    const status = fs.readFileSync(out, "utf8");
    expect(status).toMatch(/NoNewPrivs:\s+1/);
    expect(status).toMatch(/sudo=1/);
  });

  it("verification that relies on sudo fails clearly instead of bypassing the protection", async () => {
    const repo = makeRepo(root, "repo");
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "sudo -n true", lint: "echo lint ok" } }));
    fs.mkdirSync(path.join(repo, "node_modules"));
    const res = await verifyWorkspace({
      workspacePath: repo,
      headBefore: null,
      agentExitCode: 0,
      agentTimedOut: false,
      scripts: ["test", "lint"],
      timeoutMs: 20_000,
    });
    const test = res.checks.find((c) => c.name === "test")!;
    expect(test.status).toBe("failed");
    expect(test.detail).toBe(ESCALATION_BLOCKED_DETAIL);
    expect(res.checks.find((c) => c.name === "lint")!.status).toBe("passed");
    expect(res.passed).toBe(false);
  });
});
