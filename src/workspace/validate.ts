import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectRegistry } from "../registry/registry.js";
import { validTargetPath, type WorkspaceTarget } from "./target.js";
import { git, gitHead, gitStatus } from "./git.js";

/**
 * A workspace that passed every safety check. Instances can only be created
 * by `validateWorkspace` and are tracked in a private WeakMap, so the agent
 * launcher can verify at runtime that it was handed a genuinely validated,
 * workspace inside the root rather than an arbitrary path.
 */
export interface ValidatedWorkspace {
  readonly project: string;
  readonly path: string;
  readonly headBefore: string | null;
}

export type WorkspaceBlockCode = "exists" | "outside_root" | "missing" | "not_git" | "dirty" | "git_error";

export type WorkspaceCheck =
  | { ok: true; workspace: ValidatedWorkspace }
  | { ok: false; code: WorkspaceBlockCode; reason: string; dirtyFiles?: string[] };

const validated = new WeakMap<ValidatedWorkspace, ProjectRegistry>();

export function isValidatedWorkspace(value: unknown, registry?: ProjectRegistry): value is ValidatedWorkspace {
  return typeof value === "object" && value !== null && validated.has(value as ValidatedWorkspace) &&
    (!registry || validated.get(value as ValidatedWorkspace) === registry);
}

export async function validateWorkspace(registry: ProjectRegistry, entry: WorkspaceTarget): Promise<WorkspaceCheck> {
  const root = registry.workspaceRoot;
  if (!validTargetPath(root, entry.workspace)) {
    return { ok: false, code: "outside_root", reason: `Workspace must be a normalized child path inside ${root}, without traversal` };
  }

  // Fail closed on symlinks, including dangling links and any parent component.
  // The configured root must itself be canonical, never an alias outside the boundary.
  let realPath: string;
  try {
    if (await fs.realpath(root) !== root) {
      return { ok: false, code: "outside_root", reason: "Workspace root must not contain symlinks" };
    }
    const parts = path.relative(root, entry.workspace).split(path.sep);
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      if (stat?.isSymbolicLink()) return { ok: false, code: "outside_root", reason: `Workspace path contains a symlink: ${current}` };
      const leaf = index === parts.length - 1;
      if (leaf && entry.mode === "create") {
        if (stat) return { ok: false, code: "exists", reason: `Refusing to overwrite existing project ${current}` };
        // Do not create inside another repository, even a clean one.
        const parentRepo = await git(path.dirname(current), ["rev-parse", "--show-toplevel"]);
        if (parentRepo.exitCode === 0) return { ok: false, code: "not_git", reason: "Cannot create a project inside another Git repository" };
        // Exclusive mkdir: a competing creator must never be silently reused.
        await fs.mkdir(current);
        const init = await git(current, ["init", "--quiet"]);
        if (init.exitCode !== 0) return { ok: false, code: "git_error", reason: "Could not initialize new project repository; directory retained for inspection" };
      } else if (!stat?.isDirectory()) {
        return { ok: false, code: "missing", reason: `Workspace directory ${current} does not exist or is not a directory` };
      }
    }
    realPath = await fs.realpath(entry.workspace);
    if (realPath !== entry.workspace) return { ok: false, code: "outside_root", reason: "Workspace path changed during validation" };
  } catch (err) {
    return { ok: false, code: "missing", reason: `Could not prepare workspace: ${err instanceof Error ? err.message : String(err)}` };
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
  validated.set(workspace, registry);
  return { ok: true, workspace };
}
