import { git } from "./git.js";

/**
 * Approval enforcement.
 *
 * Committing, stashing, switching or creating branches, tagging, pushing and
 * changing remotes all need a human's approval. The agent prompt forbids them,
 * but a prompt is not enforcement: Beast snapshots the repository's Git state
 * before the agent runs and compares it afterwards. Any difference fails the job.
 */
export interface GitSnapshot {
  head: string | null;
  branch: string | null;
  /** `<ref> <object>` lines for every local branch, tag and remote-tracking ref. */
  refs: string[];
  stash: string[];
  remotes: string[];
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export async function captureGitSnapshot(cwd: string): Promise<GitSnapshot> {
  const [head, branch, refs, stash, remotes] = await Promise.all([
    git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]),
    git(cwd, ["symbolic-ref", "-q", "HEAD"]),
    git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags", "refs/remotes"]),
    git(cwd, ["stash", "list", "--format=%H"]),
    git(cwd, ["remote", "-v"]),
  ]);
  return {
    head: head.exitCode === 0 ? head.stdout.trim() || null : null,
    branch: branch.exitCode === 0 ? branch.stdout.trim() || null : null,
    refs: refs.exitCode === 0 ? lines(refs.stdout).sort() : [],
    stash: stash.exitCode === 0 ? lines(stash.stdout) : [],
    remotes: remotes.exitCode === 0 ? lines(remotes.stdout).sort() : [],
  };
}

function refMap(refs: string[]): Map<string, string> {
  return new Map(
    refs.map((l) => {
      const i = l.lastIndexOf(" ");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
  );
}

/** Human-readable descriptions of every approval-gated change between two snapshots. */
export function detectApprovalViolations(before: GitSnapshot, after: GitSnapshot): string[] {
  const violations: string[] = [];
  if (before.branch !== after.branch) {
    violations.push(`switched branch from ${before.branch ?? "(detached)"} to ${after.branch ?? "(detached)"}`);
  }
  if (before.head !== after.head) {
    violations.push(`moved HEAD from ${before.head?.slice(0, 12) ?? "(none)"} to ${after.head?.slice(0, 12) ?? "(none)"} (commit, reset or checkout)`);
  }

  const b = refMap(before.refs);
  const a = refMap(after.refs);
  for (const [ref, obj] of a) {
    const prev = b.get(ref);
    // A commit on the current branch is already reported as a HEAD move.
    if (ref === after.branch && ref === before.branch && obj === after.head && prev === before.head) continue;
    if (prev === undefined) violations.push(`created ${ref}`);
    else if (prev !== obj) violations.push(ref.startsWith("refs/remotes/") ? `updated ${ref} (push or fetch)` : `updated ${ref}`);
  }
  for (const ref of b.keys()) if (!a.has(ref)) violations.push(`deleted ${ref}`);

  if (before.stash.join("\n") !== after.stash.join("\n")) violations.push("changed the stash");
  if (before.remotes.join("\n") !== after.remotes.join("\n")) violations.push("changed Git remotes");
  return violations;
}
