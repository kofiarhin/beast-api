import fs from "node:fs";
import { childEnv, runCommand } from "../util/exec.js";
import { createRedactingWriter, redactSecrets } from "../util/redact.js";
import type { AgentAdapter, AgentResult, AgentRunRequest } from "./types.js";

export interface ClaudeOptions {
  bin: string;
  model?: string;
}

/** Built-in tools the agent gets. No web access, sub-agents, MCP or browser tools. */
export const CLAUDE_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] as const;

/**
 * Commands denied outright. Defence in depth only: Beast's post-run Git approval
 * checks remain the enforcing gate, and prefix rules cannot catch every spelling.
 */
export const CLAUDE_DENIED_BASH = [
  "git push",
  "git commit",
  "git stash",
  "git reset",
  "git checkout",
  "git switch",
  "git restore",
  "git clean",
  "git branch",
  "git tag",
  "git remote",
  "git merge",
  "git rebase",
  "git cherry-pick",
  "git revert",
  "git update-ref",
  "git symbolic-ref",
  "git config",
  "gh",
  "sudo",
  "pm2",
  "systemctl",
  "service",
  "nginx",
  "certbot",
  "ufw",
  "crontab",
  "docker",
  "vercel",
  "netlify",
  "ssh",
  "scp",
  "rsync",
] as const;

/**
 * Commands that may run without approval: the project's own checks and read-only Git,
 * as the task prompt allows. Any other command is auto-allowed only inside Claude Code's
 * OS sandbox and is otherwise denied, because nobody answers permission prompts.
 */
export const CLAUDE_ALLOWED_BASH = [
  "npm test",
  "npm run test",
  "npm run lint",
  "npm run typecheck",
  "npm run build",
  "git status",
  "git diff",
  "git log",
  "git show",
] as const;

/** Settings passed with `--settings`. Exported for tests. */
export function buildClaudeSettings(): Record<string, unknown> {
  return {
    permissions: {
      allow: CLAUDE_ALLOWED_BASH.map((cmd) => `Bash(${cmd}:*)`),
      deny: [
        ...CLAUDE_DENIED_BASH.map((cmd) => `Bash(${cmd}:*)`),
        "Read(./.env)",
        "Read(./.env.*)",
        "Edit(./.env)",
        "Edit(./.env.*)",
        "Write(./.env)",
        "Write(./.env.*)",
        "WebFetch",
        "WebSearch",
      ],
      // Never let a session upgrade itself to bypassPermissions.
      disableBypassPermissionsMode: "disable",
    },
    // OS-level sandbox for other Bash commands (writes confined to the working directory, no
    // unsandboxed retry). Needs bubblewrap + socat; without them Claude Code disables the
    // sandbox and those commands fall back to permission prompts, which are denied.
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
    },
    disableAllHooks: true,
  };
}

/** Build the `claude -p` argument list. Exported for tests. */
export function buildClaudeArgs(model?: string): string[] {
  return [
    "-p",
    // One JSON event per line: a full transcript for the log and a final `result` event.
    "--output-format",
    "stream-json",
    "--verbose",
    // Edits inside the workspace are accepted; anything that would need approval is denied
    // because nobody answers prompts in an unattended run.
    "--permission-mode",
    "acceptEdits",
    "--permission-prompts",
    "none",
    "--tools",
    CLAUDE_TOOLS.join(","),
    // Ignore user/project/local settings so a repository cannot grant itself permissions,
    // and ignore every configured MCP server (Linear, browsers, ...).
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify(buildClaudeSettings()),
    "--strict-mcp-config",
    "--disable-slash-commands",
    // Do not keep an unredacted copy of the session under ~/.claude.
    "--no-session-persistence",
    ...(model ? ["--model", model] : []),
  ];
}

interface ResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
}

function parseResultEvent(line: string): ResultEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const event = JSON.parse(trimmed) as { type?: unknown };
    return event && event.type === "result" ? (event as ResultEvent) : undefined;
  } catch {
    return undefined;
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name = "claude";

  constructor(private readonly options: ClaudeOptions) {}

  async run(req: AgentRunRequest): Promise<AgentResult> {
    const log = fs.createWriteStream(req.logFile, { flags: "a", mode: 0o600 });
    // The transcript is redacted as it streams, so secrets the agent prints never reach disk.
    const transcript = createRedactingWriter((text) => log.write(text));
    let pending = "";
    let result: ResultEvent | undefined;

    // Read the final `result` event from the full stdout stream, not the bounded tail.
    const scanStdout = (chunk: string) => {
      pending += chunk;
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        result = parseResultEvent(pending.slice(0, nl)) ?? result;
        pending = pending.slice(nl + 1);
      }
    };

    try {
      const res = await runCommand(this.options.bin, buildClaudeArgs(this.options.model), {
        cwd: req.workspace.path,
        env: childEnv(),
        input: req.prompt,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        onOutput: (stream, chunk) => {
          if (stream === "stdout") scanStdout(chunk);
          transcript.write(chunk);
        },
      });
      result = parseResultEvent(pending) ?? result;
      const summary = typeof result?.result === "string" ? redactSecrets(result.result).trim() || undefined : undefined;
      // Claude can exit 0 while reporting an error result (e.g. max turns); report that as a failed run.
      const exitCode = res.exitCode === 0 && result?.is_error ? 1 : res.exitCode;
      return {
        exitCode,
        timedOut: res.timedOut,
        cancelled: res.aborted,
        durationMs: res.durationMs,
        summary,
        error: res.spawnError,
      };
    } finally {
      transcript.end();
      await new Promise<void>((resolve) => log.end(resolve));
    }
  }
}
