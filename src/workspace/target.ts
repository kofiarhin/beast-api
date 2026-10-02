import path from "node:path";
import type { ProjectEntry, ProjectRef, ProjectRegistry } from "../registry/registry.js";

export interface WorkspaceTarget extends ProjectEntry {
  mode?: "existing" | "create";
}

export function isChildPath(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function validTargetPath(root: string, candidate: string): boolean {
  return path.isAbsolute(candidate) && !candidate.endsWith(path.sep) && !candidate.split(path.sep).includes("..") &&
    path.normalize(candidate) === candidate && isChildPath(root, candidate);
}

/** Explicit directives only: prose mentioning a path never grants workspace access. */
export function resolveWorkspaceTarget(
  registry: ProjectRegistry,
  issue: { description: string; project: ProjectRef | null },
): WorkspaceTarget | undefined {
  const lines = issue.description.split(/\r?\n/);
  const targets = lines.filter((line) => /^Beast workspace:/i.test(line));
  const modes = lines.filter((line) => /^Beast workspace mode:/i.test(line));
  if (!targets.length && !modes.length) return registry.resolve(issue.project);
  if (targets.length !== 1 || modes.length > 1) throw new Error("Provide exactly one Beast workspace directive and at most one Beast workspace mode");
  const workspace = targets[0]!.slice("Beast workspace:".length).trim();
  const mode = modes[0]?.slice("Beast workspace mode:".length).trim().toLowerCase() ?? "existing";
  if (mode !== "existing" && mode !== "create") throw new Error("Beast workspace mode must be existing or create");
  if (!validTargetPath(registry.workspaceRoot, workspace)) throw new Error(`Workspace must be a normalized child path inside ${registry.workspaceRoot}, without traversal`);
  return { name: issue.project?.name ?? path.basename(workspace), workspace, mode };
}
