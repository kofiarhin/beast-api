import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectEntry, ProjectRegistry } from "../registry/registry.js";
import { git, gitHead, gitStatus } from "./git.js";

/**
 * A workspace that passed every safety check. Instances can only be created
 * by `validateWorkspace` and are tracked in a private WeakSet, so the agent
 * launcher can verify at runtime that it was handed a genuinely validated,
 * registered workspace rather than an arbitrary path.
 */
export interface ValidatedWorkspace {
  readonly project: string;
  readonly path: string;
  readonly headBefore: string | null;
}

export type WorkspaceBlockCode = "unregistered" | "outside_root" | "missing" | "not_git" | "dirty" | "git_error";

export type WorkspaceCheck =
  | { ok: true; workspace: ValidatedWorkspace }
  | { ok: false; code: WorkspaceBlockCode; reason: string; dirtyFiles?: string[] };

const validated = new WeakSet<ValidatedWorkspace>();

export function isValidatedWorkspace(value: unknown): value is ValidatedWorkspace {
  return typeof value === "object" && value !== null && validated.has(value as ValidatedWorkspace);
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function validateWorkspace(registry: ProjectRegistry, entry: ProjectEntry): Promise<WorkspaceCheck> {
  // 1. Must be an explicitly registered workspace.
  if (!registry.isRegisteredWorkspace(entry.workspace)) {
    return { ok: false, code: "unregistered", reason: `Workspace ${entry.workspace} is not registered` };
  }

  // 2. Must exist and be a directory.
  let realPath: string;
  try {
    const stat = await fs.stat(entry.workspace);
    if (!stat.isDirectory()) {
      return { ok: false, code: "missing", reason: `Workspace ${entry.workspace} is not a directory` };
    }
    realPath = await fs.realpath(entry.workspace);
  } catch {
    return { ok: false, code: "missing", reason: `Workspace ${entry.workspace} does not exist` };
  }

  // Symlinks must not escape the workspace root.
  let realRoot: string;
  try {
    realRoot = await fs.realpath(registry.workspaceRoot);
  } catch {
    return { ok: false, code: "missing", reason: `Workspace root ${registry.workspaceRoot} does not exist` };
  }
  if (!isInside(realRoot, realPath)) {
    return { ok: false, code: "outside_root", reason: `Workspace ${entry.workspace} resolves outside ${realRoot}` };
  }

  // 3. Must be the root of a Git repository (not a subdirectory of some other repo).
  const top = await git(realPath, ["rev-parse", "--show-toplevel"]);
  if (top.exitCode !== 0) {
    return { ok: false, code: "not_git", reason: `Workspace ${entry.workspace} is not a Git repository` };
  }
  const topLevel = await fs.realpath(top.stdout.trim()).catch(() => top.stdout.trim());
  if (topLevel !== realPath) {
    return {
      ok: false,
      code: "not_git",
      reason: `Workspace ${entry.workspace} is not the root of a Git repository (repository root is ${topLevel})`,
    };
  }

  // 4-5. Working tree must be clean. Never stash, discard or commit anything.
  const status = await gitStatus(realPath);
  if (!status.ok) {
    return { ok: false, code: "git_error", reason: `git status failed: ${status.error ?? "unknown error"}` };
  }
  if (status.files.length > 0) {
    return {
      ok: false,
      code: "dirty",
      reason: `Workspace ${entry.workspace} has ${status.files.length} uncommitted change(s)`,
      dirtyFiles: status.files.slice(0, 50),
    };
  }

  const workspace: ValidatedWorkspace = Object.freeze({
    project: entry.name,
    path: entry.workspace,
    headBefore: await gitHead(realPath),
  });
  validated.add(workspace);
  return { ok: true, workspace };
}
