import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchAgent, UnsafeWorkspaceError } from "../src/agents/launcher.js";
import { ProjectRegistry } from "../src/registry/registry.js";
import { validateWorkspace, type ValidatedWorkspace } from "../src/workspace/validate.js";
import { FakeAgent, makeRepo, makeTmpDir, removeTmpDir } from "./helpers.js";

let root: string;
afterEach(() => removeTmpDir(root));

function task(workspacePath: string) {
  return {
    jobId: "j1",
    issueId: "i1",
    identifier: "BEA-1",
    title: "t",
    description: "d",
    url: null,
    project: "P",
    workspacePath,
  };
}

describe("project registry", () => {
  it("quarantines workspaces outside the workspace root so they can never be validated", async () => {
    root = makeTmpDir();
    const ws = path.join(root, "projects");
    fs.mkdirSync(ws);
    const outside = makeRepo(root, "outside");
    const reg = new ProjectRegistry([{ name: "Evil", workspace: "/etc" }, { name: "Out", workspace: outside }], ws);
    expect(reg.outsideRoot).toEqual(["Evil", "Out"]);
    expect(reg.isRegisteredWorkspace(outside)).toBe(false);
    for (const name of ["Evil", "Out"]) {
      expect(await validateWorkspace(reg, reg.resolve({ name })!)).toMatchObject({ ok: false, code: "outside_root" });
    }
  });

  it("rejects relative, non-normalized and duplicate entries", () => {
    root = makeTmpDir();
    const ws = path.join(root, "projects");
    expect(() => new ProjectRegistry([{ name: "R", workspace: "projects/x" }], ws)).toThrow(/absolute/);
    expect(() => new ProjectRegistry([{ name: "R", workspace: `${ws}/a/../../etc` }], ws)).toThrow();
    expect(
      () =>
        new ProjectRegistry(
          [
            { name: "A", workspace: `${ws}/a` },
            { name: "a", workspace: `${ws}/b` },
          ],
          ws,
        ),
    ).toThrow(/Duplicate/);
  });

  it("resolves only exact registered names and never guesses", () => {
    root = makeTmpDir();
    const ws = path.join(root, "projects");
    const reg = new ProjectRegistry([{ name: "IdeaHub API", workspace: `${ws}/ideahub-api` }], ws);
    expect(reg.resolve({ name: "ideahub api" })?.workspace).toBe(`${ws}/ideahub-api`);
    expect(reg.resolve({ name: "IdeaHub" })).toBeUndefined();
    expect(reg.resolve({ name: "ideahub-api" })).toBeUndefined();
    expect(reg.resolve(null)).toBeUndefined();
  });

  it("prefers a pinned Linear project ID", () => {
    root = makeTmpDir();
    const ws = path.join(root, "projects");
    const reg = new ProjectRegistry([{ name: "X", workspace: `${ws}/x`, linearProjectId: "pid" }], ws);
    expect(reg.resolve({ id: "pid", name: "Renamed" })?.name).toBe("X");
    expect(reg.resolve({ id: "other", name: "X" })).toBeUndefined();
  });

  it("loads the shipped registry, quarantining the out-of-root Beast API entry", async () => {
    const { loadRegistry } = await import("../src/registry/registry.js");
    const reg = loadRegistry(path.resolve(import.meta.dirname, "../config/projects.json"), "/home/ubuntu/projects");
    // The live registry may gain projects; check the baseline entries rather than the exact list.
    expect(reg.list().map((p) => [p.name, p.workspace])).toEqual(
      expect.arrayContaining([
        ["Beast", "/home/ubuntu/projects/beast"],
        ["DevKofi", "/home/ubuntu/projects/devkofi"],
        ["IdeaHub API", "/home/ubuntu/projects/ideahub-api"],
        ["LeadRadar", "/home/ubuntu/projects/leadradar"],
        ["Beast API", "/home/ubuntu/apps/beast-api"],
      ]),
    );
    expect(reg.outsideRoot).toEqual(["Beast API"]);
    expect(await validateWorkspace(reg, reg.resolve({ name: "Beast API" })!)).toMatchObject({ ok: false, code: "outside_root" });
  });
});

describe("workspace validation", () => {
  it("accepts a clean registered repo", async () => {
    root = makeTmpDir();
    const ws = path.join(root, "projects");
    const repo = makeRepo(ws, "p");
    const reg = new ProjectRegistry([{ name: "P", workspace: repo }], ws);
    const check = await validateWorkspace(reg, reg.list()[0]!);
    expect(check.ok).toBe(true);
  });

  it("accepts a clean child repository that is not in the registry", async () => {
    root = makeTmpDir();
    const ws = path.join(root, "projects");
    const repo = makeRepo(ws, "p");
    const reg = new ProjectRegistry([], ws);
    const check = await validateWorkspace(reg, { name: "P", workspace: repo });
    expect(check.ok).toBe(true);
  });

  it("rejects a subdirectory of another git repo", async () => {
    root = makeTmpDir();
    const ws = path.join(root, "projects");
    const repo = makeRepo(ws, "p");
    fs.mkdirSync(path.join(repo, "sub"));
    // The registry root is the repo itself, so "sub" is inside the root but not a repo root.
    const reg = new ProjectRegistry([{ name: "Sub", workspace: path.join(repo, "sub") }], repo);
    const check = await validateWorkspace(reg, reg.list()[0]!);
    expect(check).toMatchObject({ ok: false, code: "not_git" });
  });

  it("rejects a symlink that escapes the workspace root", async () => {
    root = makeTmpDir();
    const ws = path.join(root, "projects");
    fs.mkdirSync(ws);
    const outside = makeRepo(root, "outside");
    fs.symlinkSync(outside, path.join(ws, "link"));
    const reg = new ProjectRegistry([{ name: "Link", workspace: path.join(ws, "link") }], ws);
    const check = await validateWorkspace(reg, reg.list()[0]!);
    expect(check).toMatchObject({ ok: false, code: "outside_root" });
  });
});

describe("agent launcher", () => {
  it("refuses a workspace object that was not produced by validation", async () => {
    root = makeTmpDir();
    const ws = path.join(root, "projects");
    const repo = makeRepo(ws, "p");
    const reg = new ProjectRegistry([{ name: "P", workspace: repo }], ws);
    const agent = new FakeAgent();
    const forged: ValidatedWorkspace = { project: "P", path: repo, headBefore: null };
    await expect(launchAgent(agent, reg, forged, task(repo), { timeoutMs: 1000, logFile: "/dev/null" })).rejects.toThrow(
      UnsafeWorkspaceError,
    );
    expect(agent.calls).toHaveLength(0);
  });

  it("refuses a workspace validated against a different registry", async () => {
    root = makeTmpDir();
    const ws = path.join(root, "projects");
    const repo = makeRepo(ws, "p");
    const reg = new ProjectRegistry([{ name: "P", workspace: repo }], ws);
    const check = await validateWorkspace(reg, reg.list()[0]!);
    if (!check.ok) throw new Error("expected ok");
    const otherRegistry = new ProjectRegistry([], ws);
    const agent = new FakeAgent();
    await expect(
      launchAgent(agent, otherRegistry, check.workspace, task(repo), { timeoutMs: 1000, logFile: "/dev/null" }),
    ).rejects.toThrow(/not validated against this registry/);
    expect(agent.calls).toHaveLength(0);
  });

  it("refuses a task whose path differs from the validated workspace", async () => {
    root = makeTmpDir();
    const ws = path.join(root, "projects");
    const repo = makeRepo(ws, "p");
    const reg = new ProjectRegistry([{ name: "P", workspace: repo }], ws);
    const check = await validateWorkspace(reg, reg.list()[0]!);
    if (!check.ok) throw new Error("expected ok");
    const agent = new FakeAgent();
    await expect(
      launchAgent(agent, reg, check.workspace, task("/home/ubuntu"), { timeoutMs: 1000, logFile: "/dev/null" }),
    ).rejects.toThrow(UnsafeWorkspaceError);
    expect(agent.calls).toHaveLength(0);
  });
});
