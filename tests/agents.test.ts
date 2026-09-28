import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexArgs, CodexAdapter } from "../src/agents/codex.js";
import { createAgentAdapter } from "../src/agents/index.js";
import { buildAgentPrompt, extractAcceptanceCriteria } from "../src/agents/prompt.js";
import { loadConfig } from "../src/config.js";
import { ProjectRegistry } from "../src/registry/registry.js";
import { childEnv } from "../src/util/exec.js";
import { validateWorkspace } from "../src/workspace/validate.js";
import { makeRepo, makeTmpDir, removeTmpDir } from "./helpers.js";

let root: string | undefined;
afterEach(() => {
  if (root) removeTmpDir(root);
  root = undefined;
});

describe("agent adapter selection", () => {
  it("selects codex by default", () => {
    const adapter = createAgentAdapter(loadConfig({}));
    expect(adapter).toBeInstanceOf(CodexAdapter);
    expect(adapter.name).toBe("codex");
  });

  it("reports claude as not implemented yet", () => {
    expect(() => createAgentAdapter(loadConfig({ BEAST_AGENT: "claude" }))).toThrow(/not implemented/);
  });

  it("rejects unknown agents", () => {
    expect(() => createAgentAdapter(loadConfig({ BEAST_AGENT: "rm -rf" }))).toThrow(/Unknown BEAST_AGENT/);
  });
});

describe("codex adapter", () => {
  it("confines codex to the workspace with the workspace-write sandbox", () => {
    const args = buildCodexArgs("/home/ubuntu/projects/leadradar", "/tmp/out.txt");
    expect(args[0]).toBe("exec");
    expect(args).toContain("workspace-write");
    expect(args[args.indexOf("--cd") + 1]).toBe("/home/ubuntu/projects/leadradar");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("danger-full-access");
    expect(args.at(-1)).toBe("-");
  });

  it("launches a fresh process with the workspace as cwd, prompt on stdin, and no Beast secrets", async () => {
    root = makeTmpDir();
    const ws = path.join(root, "projects");
    const repo = makeRepo(ws, "p");
    const reg = new ProjectRegistry([{ name: "P", workspace: repo }], ws);
    const check = await validateWorkspace(reg, reg.list()[0]!);
    if (!check.ok) throw new Error("expected ok");

    // Stand-in "codex" binary that records what it was given.
    const record = path.join(root, "record.json");
    const bin = path.join(root, "fake-codex.mjs");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
import fs from "node:fs";
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), args, input,
    hasKey: "LINEAR_API_KEY" in process.env, hasSecret: "LINEAR_WEBHOOK_SECRET" in process.env }));
  fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], "all done");
});
`,
      { mode: 0o755 },
    );

    process.env.LINEAR_API_KEY = "should-not-leak";
    process.env.LINEAR_WEBHOOK_SECRET = "should-not-leak";
    try {
      const adapter = new CodexAdapter({ bin });
      const result = await adapter.run({
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
      });
      expect(result.exitCode).toBe(0);
      expect(result.summary).toBe("all done");
    } finally {
      delete process.env.LINEAR_API_KEY;
      delete process.env.LINEAR_WEBHOOK_SECRET;
    }

    const rec = JSON.parse(fs.readFileSync(record, "utf8"));
    expect(rec.cwd).toBe(fs.realpathSync(repo));
    expect(rec.input).toBe("PROMPT-TEXT");
    expect(rec.args[rec.args.indexOf("--cd") + 1]).toBe(repo);
    expect(rec.hasKey).toBe(false);
    expect(rec.hasSecret).toBe(false);
  });

  it("keeps the last-message file at mode 0600 even if codex replaces it", async () => {
    root = makeTmpDir();
    const ws = path.join(root, "projects");
    const repo = makeRepo(ws, "p");
    const reg = new ProjectRegistry([{ name: "P", workspace: repo }], ws);
    const check = await validateWorkspace(reg, reg.list()[0]!);
    if (!check.ok) throw new Error("expected ok");

    // Stand-in codex that records the file's mode during the run, then replaces it
    // with a new world-readable file (as a write-to-temp-and-rename would).
    const seen = path.join(root, "mode-during-run");
    const bin = path.join(root, "fake-codex.mjs");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const out = args[args.indexOf("--output-last-message") + 1];
fs.writeFileSync(${JSON.stringify(seen)}, String(fs.statSync(out).mode & 0o777));
fs.writeFileSync(out + ".tmp", "summary text", { mode: 0o644 });
fs.chmodSync(out + ".tmp", 0o644);
fs.renameSync(out + ".tmp", out);
`,
      { mode: 0o755 },
    );

    const logFile = path.join(root, "job.log");
    const result = await new CodexAdapter({ bin }).run({
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
      logFile,
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("summary text");
    expect(Number(fs.readFileSync(seen, "utf8"))).toBe(0o600);
    expect(fs.statSync(`${logFile}.last-message.txt`).mode & 0o777).toBe(0o600);
  });
});

describe("agent prompt", () => {
  it("includes ticket context and safety restrictions", () => {
    const prompt = buildAgentPrompt({
      jobId: "j",
      issueId: "uuid-1",
      identifier: "LEAD-42",
      title: "Add CSV export",
      description: "Export leads.\n\n## Acceptance Criteria\n- CSV has headers\n\n## Notes\nnone",
      url: "https://linear.app/x",
      project: "LeadRadar",
      workspacePath: "/home/ubuntu/projects/leadradar",
    });
    for (const s of ["LEAD-42", "Add CSV export", "LeadRadar", "/home/ubuntu/projects/leadradar", "CSV has headers"]) {
      expect(prompt).toContain(s);
    }
    expect(prompt).toMatch(/Implement ONLY/);
    expect(prompt).toMatch(/git push/);
    expect(prompt).toMatch(/Expected verification/);
  });

  it("extracts an acceptance criteria section", () => {
    expect(extractAcceptanceCriteria("x\n## Acceptance criteria\n- a\n- b\n## Other\nz")).toBe("- a\n- b");
    expect(extractAcceptanceCriteria("no section")).toBeNull();
  });
});

describe("child environment", () => {
  it("strips Beast secrets", () => {
    const env = childEnv({}, { PATH: "/bin", LINEAR_API_KEY: "k", LINEAR_WEBHOOK_SECRET: "s" });
    expect(env).toEqual({ PATH: "/bin" });
  });
});
