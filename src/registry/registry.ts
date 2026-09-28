import fs from "node:fs";
import path from "node:path";

/**
 * A registered project. `name` must match the Linear project name exactly
 * (case-insensitive). `linearProjectId` optionally pins the mapping to a
 * Linear project ID, which is preferred when present.
 */
export interface ProjectEntry {
  name: string;
  workspace: string;
  linearProjectId?: string;
}

export interface ProjectRef {
  id?: string | null;
  name?: string | null;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export class ProjectRegistry {
  private readonly entries: readonly ProjectEntry[];

  constructor(
    entries: ProjectEntry[],
    readonly workspaceRoot: string,
  ) {
    const seenNames = new Set<string>();
    const seenPaths = new Set<string>();
    for (const e of entries) {
      if (!e.name?.trim()) throw new Error("Registry entry is missing a name");
      if (!e.workspace || !path.isAbsolute(e.workspace)) {
        throw new Error(`Registry entry "${e.name}" must have an absolute workspace path`);
      }
      if (path.resolve(e.workspace) !== e.workspace.replace(/\/+$/, "")) {
        throw new Error(`Registry entry "${e.name}" workspace path must be normalized`);
      }
      if (!isInside(workspaceRoot, e.workspace)) {
        throw new Error(`Registry entry "${e.name}" workspace must be inside ${workspaceRoot}`);
      }
      const key = e.name.trim().toLowerCase();
      if (seenNames.has(key)) throw new Error(`Duplicate registry project name "${e.name}"`);
      if (seenPaths.has(e.workspace)) throw new Error(`Duplicate registry workspace "${e.workspace}"`);
      seenNames.add(key);
      seenPaths.add(e.workspace);
    }
    this.entries = Object.freeze(entries.map((e) => Object.freeze({ ...e, workspace: path.resolve(e.workspace) })));
  }

  list(): readonly ProjectEntry[] {
    return this.entries;
  }

  /** Exact lookup only. Never guesses: no fuzzy matching, no path derivation. */
  resolve(project: ProjectRef | null | undefined): ProjectEntry | undefined {
    if (!project) return undefined;
    if (project.id) {
      const byId = this.entries.find((e) => e.linearProjectId === project.id);
      if (byId) return byId;
    }
    const name = project.name?.trim().toLowerCase();
    if (!name) return undefined;
    // Name match; an entry pinned to a Linear project ID never matches a different ID.
    return this.entries.find(
      (e) =>
        e.name.trim().toLowerCase() === name && (!e.linearProjectId || !project.id || e.linearProjectId === project.id),
    );
  }

  isRegisteredWorkspace(workspacePath: string): boolean {
    const resolved = path.resolve(workspacePath);
    return this.entries.some((e) => e.workspace === resolved);
  }
}

export function loadRegistry(file: string, workspaceRoot: string): ProjectRegistry {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { projects?: ProjectEntry[] };
  if (!Array.isArray(raw.projects)) throw new Error(`${file} must contain a "projects" array`);
  return new ProjectRegistry(raw.projects, path.resolve(workspaceRoot));
}
