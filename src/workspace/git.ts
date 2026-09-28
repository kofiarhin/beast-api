import { childEnv, runCommand, type ExecResult } from "../util/exec.js";

export function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<ExecResult> {
  return runCommand("git", ["-C", cwd, ...args], {
    cwd,
    timeoutMs,
    env: childEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }),
  });
}

/** Parse `git status --porcelain=v1` output into file paths. */
export function parsePorcelain(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => {
      const file = line.slice(3);
      const arrow = file.indexOf(" -> ");
      return arrow >= 0 ? file.slice(arrow + 4) : file;
    });
}

export async function gitStatus(cwd: string): Promise<{ ok: boolean; output: string; files: string[]; error?: string }> {
  const res = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (res.exitCode !== 0) {
    return { ok: false, output: "", files: [], error: (res.spawnError ?? res.stderr).trim() };
  }
  return { ok: true, output: res.stdout, files: parsePorcelain(res.stdout) };
}

export async function gitHead(cwd: string): Promise<string | null> {
  const res = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
  return res.exitCode === 0 ? res.stdout.trim() : null;
}
