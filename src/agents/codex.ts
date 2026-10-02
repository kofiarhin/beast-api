import fs from "node:fs";
import fsp from "node:fs/promises";
import { childEnv, runCommand } from "../util/exec.js";
import { createRedactingWriter, redactSecrets } from "../util/redact.js";
import type { AgentAdapter, AgentResult, AgentRunRequest } from "./types.js";

export interface CodexOptions {
  bin: string;
  model?: string;
}

/** Build the `codex exec` argument list. Exported for tests. */
export function buildCodexArgs(workspacePath: string, lastMessageFile: string, model?: string): string[] {
  return [
    "exec",
    // Sandbox confines file writes to the workspace; no approval prompts in unattended mode.
    "--sandbox",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    "--cd",
    workspacePath,
    "--color",
    "never",
    "--output-last-message",
    lastMessageFile,
    ...(model ? ["--model", model] : []),
    // Read the prompt from stdin.
    "-",
  ];
}

/** Ensure `file` has mode 0600, optionally creating it (empty) if missing. */
async function restrictFile(file: string, create: boolean): Promise<void> {
  if (create) {
    const handle = await fsp.open(file, "a", 0o600);
    await handle.close();
  }
  await fsp.chmod(file, 0o600).catch(() => undefined);
}

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";

  constructor(private readonly options: CodexOptions) {}

  async run(req: AgentRunRequest): Promise<AgentResult> {
    const lastMessageFile = `${req.logFile}.last-message.txt`;
    const log = fs.createWriteStream(req.logFile, { flags: "a", mode: 0o600 });
    // The transcript is redacted as it streams, so secrets the agent prints never reach disk.
    const transcript = createRedactingWriter((text) => log.write(text));
    const args = buildCodexArgs(req.workspace.path, lastMessageFile, this.options.model);

    try {
      // Create the last-message file owner-only up front, and re-apply 0600 after
      // the run in case Codex replaced it with a file of its own.
      await restrictFile(lastMessageFile, true);
      const res = await runCommand(this.options.bin, args, {
        cwd: req.workspace.path,
        env: childEnv(),
        input: req.prompt,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        onOutput: (_stream, chunk) => transcript.write(chunk),
      });
      await restrictFile(lastMessageFile, false);
      const summary = await fsp.readFile(lastMessageFile, "utf8").catch(() => undefined);
      // The last-message file stays on disk next to the log; keep only the redacted text there too.
      if (summary) await fsp.writeFile(lastMessageFile, redactSecrets(summary), { mode: 0o600 }).catch(() => undefined);
      return {
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        cancelled: res.aborted,
        durationMs: res.durationMs,
        summary: summary ? redactSecrets(summary).trim() || undefined : undefined,
        error: res.spawnError,
      };
    } finally {
      transcript.end();
      await new Promise<void>((resolve) => log.end(resolve));
    }
  }
}
