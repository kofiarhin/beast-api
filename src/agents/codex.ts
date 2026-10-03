import fs from "node:fs";
import fsp from "node:fs/promises";
import { CAPTURE_FILE_TOKEN } from "../admin/protocol.js";
import { childEnv, runCommand } from "../util/exec.js";
import { createRedactingWriter, redactSecrets } from "../util/redact.js";
import type { AgentAdapter, AgentResult, AgentRunRequest } from "./types.js";

export interface CodexOptions {
  bin: string;
  model?: string;
}

/**
 * Build the `codex exec` argument list. Exported for tests. The last message goes to a
 * private capture file (the agent may run as another user that cannot write Beast's logs).
 */
export function buildCodexArgs(workspacePath: string, lastMessageFile: string = CAPTURE_FILE_TOKEN, model?: string): string[] {
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

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";

  constructor(private readonly options: CodexOptions) {}

  async run(req: AgentRunRequest): Promise<AgentResult> {
    const lastMessageFile = `${req.logFile}.last-message.txt`;
    const log = fs.createWriteStream(req.logFile, { flags: "a", mode: 0o600 });
    // The transcript is redacted as it streams, so secrets the agent prints never reach disk.
    const transcript = createRedactingWriter((text) => log.write(text));
    const args = buildCodexArgs(req.workspace.path, CAPTURE_FILE_TOKEN, this.options.model);

    try {
      const res = await runCommand(this.options.bin, args, {
        cwd: req.workspace.path,
        env: childEnv(),
        input: req.prompt,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        captureFile: true,
        onOutput: (_stream, chunk) => transcript.write(chunk),
      });
      const summary = res.captured;
      // The last message is kept next to the log, owner-only and redacted.
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
