import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  buildClaudeSettings,
  CLAUDE_ALLOWED_BASH,
  CLAUDE_DENIED_BASH,
  CLAUDE_TOOLS,
  ClaudeAdapter,
} from "../src/agents/claude.js";
import type { AgentRunRequest } from "../src/agents/types.js";
import { ProjectRegistry } from "../src/registry/registry.js";
import { validateWorkspace } from "../src/workspace/validate.js";
import { makeRepo, makeTmpDir, removeTmpDir } from "./helpers.js";

let root: string | undefined;
afterEach(() => {
  if (root) removeTmpDir(root);
  root = undefined;
});

/** A validated throwaway workspace plus a run request for it. */
async function setup(extra: Partial<AgentRunRequest> = {}): Promise<{ repo: string; req: AgentRunRequest }> {
  root = makeTmpDir();
  const ws = path.join(root, "projects");
  const repo = makeRepo(ws, "p");
  const reg = new ProjectRegistry([{ name: "P", workspace: repo }], ws);
  const check = await validateWorkspace(reg, reg.list()[0]!);
  if (!check.ok) throw new Error("expected ok");
  return {
    repo,
    req: {
      task: {
        jobId: "j",
        issueId: "i",
        identifier: "BEA-9",
        title: "T",
        description: "D",
        url: null,
        project: "P",
        workspacePath: repo,
      },
      workspace: check.workspace,
      prompt: "PROMPT-TEXT",
      timeoutMs: 10_000,
      logFile: path.join(root, "job.log"),
      ...extra,
    },
  };
}

/** Write a stand-in "claude" binary with the given body (an ES module). */
function fakeClaude(body: string): string {
  const bin = path.join(root!, "fake-claude.mjs");
  fs.writeFileSync(bin, `#!/usr/bin/env node\nimport fs from "node:fs";\n${body}\n`, { mode: 0o755 });
  return bin;
}

const resultLine = (fields: Record<string, unknown>) => JSON.stringify({ type: "result", subtype: "success", is_error: false, ...fields });

describe("claude CLI arguments", () => {
  it("runs one non-interactive session with no permission bypass", () => {
    const args = buildClaudeArgs();
    expect(args[0]).toBe("-p");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(args).toContain("--no-session-persistence");
    for (const unsafe of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions", "--add-dir", "--resume", "--continue"]) {
      expect(args).not.toContain(unsafe);
    }
    expect(args).not.toContain("--model");
    expect(buildClaudeArgs("opus").slice(-2)).toEqual(["--model", "opus"]);
  });

  it("ignores user/project settings and every MCP server, and limits the tool set", () => {
    const args = buildClaudeArgs();
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe(CLAUDE_TOOLS.join(","));
    expect(CLAUDE_TOOLS).not.toContain("WebFetch");
    expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toEqual(buildClaudeSettings());
  });

  it("denies Git ref changes, publishing and system changes; only allows checks and read-only Git", () => {
    const settings = buildClaudeSettings() as {
      permissions: { allow: string[]; deny: string[]; disableBypassPermissionsMode: string };
      sandbox: { enabled: boolean; allowUnsandboxedCommands: boolean };
      disableAllHooks: boolean;
    };
    for (const cmd of ["git push", "git commit", "git stash", "git reset", "git branch", "git remote", "gh", "pm2", "sudo"]) {
      expect(settings.permissions.deny).toContain(`Bash(${cmd}:*)`);
    }
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Read(./.env)", "Edit(./.env)", "Write(./.env)", "WebFetch"]));
    expect(settings.permissions.allow).toEqual(CLAUDE_ALLOWED_BASH.map((c) => `Bash(${c}:*)`));
    for (const allowed of CLAUDE_ALLOWED_BASH) {
      expect(allowed).toMatch(/^(npm (test|run (test|lint|typecheck|build))|git (status|diff|log|show))$/);
      expect(CLAUDE_DENIED_BASH.some((d) => allowed.startsWith(d))).toBe(false);
    }
    expect(settings.permissions.disableBypassPermissionsMode).toBe("disable");
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(settings.disableAllHooks).toBe(true);
  });
});

describe("claude adapter", () => {
  it("launches a fresh process in the workspace with the prompt on stdin and no Beast secrets", async () => {
    const { repo, req } = await setup();
    const record = path.join(root!, "record.json");
    const bin = fakeClaude(`
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), input,
    hasKey: "LINEAR_API_KEY" in process.env, hasSecret: "LINEAR_WEBHOOK_SECRET" in process.env }));
  // Emit the result event in two chunks to exercise line buffering.
  const line = ${JSON.stringify(resultLine({ result: "all done" }))} + "\\n";
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n" + line.slice(0, 20));
  setTimeout(() => process.stdout.write(line.slice(20)), 50);
});`);

    process.env.LINEAR_API_KEY = "should-not-leak";
    process.env.LINEAR_WEBHOOK_SECRET = "should-not-leak";
    try {
      const result = await new ClaudeAdapter({ bin, model: "sonnet" }).run(req);
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.cancelled).toBe(false);
      expect(result.error).toBeUndefined();
      expect(result.summary).toBe("all done");
    } finally {
      delete process.env.LINEAR_API_KEY;
      delete process.env.LINEAR_WEBHOOK_SECRET;
    }

    const rec = JSON.parse(fs.readFileSync(record, "utf8"));
    expect(rec.cwd).toBe(fs.realpathSync(repo));
    expect(rec.input).toBe("PROMPT-TEXT");
    expect(rec.args).toEqual(buildClaudeArgs("sonnet"));
    expect(rec.hasKey).toBe(false);
    expect(rec.hasSecret).toBe(false);
    expect(fs.statSync(req.logFile).mode & 0o777).toBe(0o600);
  });

  it("redacts secrets in the transcript and the summary", async () => {
    const { req } = await setup();
    const token = "lin_api_" + "A".repeat(40);
    const bin = fakeClaude(`
process.stdout.write(JSON.stringify({ type: "assistant", text: "found ${token}" }) + "\\n");
process.stderr.write("leaked: " + process.env.BEAST_TEST_SECRET + "\\n");
process.stdout.write(${JSON.stringify(resultLine({ result: `summary ${token}` }))} + "\\n");`);

    process.env.BEAST_TEST_SECRET = "super-secret-value-123";
    try {
      const result = await new ClaudeAdapter({ bin }).run(req);
      expect(result.summary).toBe("summary [REDACTED]");
    } finally {
      delete process.env.BEAST_TEST_SECRET;
    }
    const log = fs.readFileSync(req.logFile, "utf8");
    expect(log).toContain("[REDACTED]");
    expect(log).not.toContain(token);
    expect(log).not.toContain("super-secret-value-123");
  });

  it("reports an error result as a failed run even when claude exits 0", async () => {
    const { req } = await setup();
    const bin = fakeClaude(`process.stdout.write(${JSON.stringify(resultLine({ subtype: "error_max_turns", is_error: true, result: "ran out of turns" }))} + "\\n");`);
    const result = await new ClaudeAdapter({ bin }).run(req);
    expect(result.exitCode).toBe(1);
    expect(result.summary).toBe("ran out of turns");
  });

  it("passes through a non-zero exit with no result event", async () => {
    const { req } = await setup();
    const bin = fakeClaude(`process.stdout.write("not json\\n"); process.exit(3);`);
    const result = await new ClaudeAdapter({ bin }).run(req);
    expect(result.exitCode).toBe(3);
    expect(result.summary).toBeUndefined();
  });

  it("reports a missing binary as a launch error", async () => {
    const { req } = await setup();
    const result = await new ClaudeAdapter({ bin: path.join(root!, "no-such-claude") }).run(req);
    expect(result.exitCode).toBeNull();
    expect(result.error).toMatch(/ENOENT/);
  });

  it("stops the process when the job is cancelled", async () => {
    const controller = new AbortController();
    const { req } = await setup({ signal: controller.signal });
    const started = path.join(root!, "started");
    const bin = fakeClaude(`fs.writeFileSync(${JSON.stringify(started)}, "1"); setInterval(() => {}, 1000);`);
    const run = new ClaudeAdapter({ bin }).run(req);
    for (let i = 0; i < 250 && !fs.existsSync(started); i++) await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const result = await run;
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("stops the process on timeout", async () => {
    const { req } = await setup({ timeoutMs: 300 });
    const bin = fakeClaude(`setInterval(() => {}, 1000);`);
    const result = await new ClaudeAdapter({ bin }).run(req);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });
});
