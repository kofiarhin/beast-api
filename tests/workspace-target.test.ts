import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { loadConfig } from "../src/config.js";
import { ProjectRegistry } from "../src/registry/registry.js";
import { resolveWorkspaceTarget } from "../src/workspace/target.js";
import { validateWorkspace } from "../src/workspace/validate.js";
import { makeHarness, makeIssue, makeRepo, removeTmpDir, sign, webhookBody, type Harness } from "./helpers.js";

let root: string;
let h: Harness | undefined;
afterEach(async () => {
  if (h) { await h.worker.idle(); removeTmpDir(h.root); h = undefined; }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
function setup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "beast-target-"));
  const ws = path.join(root, "projects");
  fs.mkdirSync(ws);
  return { ws, registry: new ProjectRegistry([], ws) };
}

describe("ticket workspace targets", () => {
  it("fixes the production root", () => {
    expect(loadConfig({}).workspaceRoot).toBe("/home/ubuntu/projects");
    expect(loadConfig({ BEAST_WORKSPACE_ROOT: "/home/ubuntu/projects/" }).workspaceRoot).toBe("/home/ubuntu/projects");
    expect(() => loadConfig({ BEAST_WORKSPACE_ROOT: "/tmp" })).toThrow(/must be/);
    expect(() => loadConfig({ BEAST_WORKSPACE_ROOT: "/home/ubuntu" })).toThrow(/must be/);
  });
  it("uses explicit directives and rejects ambiguous or invalid modes", () => {
    const { ws, registry } = setup();
    const issue = { project: null, description: `Beast workspace: ${ws}/escowear\nBeast workspace mode: create` };
    expect(resolveWorkspaceTarget(registry, issue)).toMatchObject({ workspace: `${ws}/escowear`, mode: "create" });
    expect(resolveWorkspaceTarget(registry, { ...issue, description: `Please inspect ${ws}/escowear` })).toBeUndefined();
    for (const description of [issue.description + `\nBeast workspace: ${ws}/other`, `Beast workspace mode: create`, `Beast workspace: ${ws}/x\nBeast workspace mode: overwrite`]) {
      expect(() => resolveWorkspaceTarget(registry, { ...issue, description })).toThrow();
    }
  });
  it("creates a new child Git workspace without a commit and refuses reuse", async () => {
    const { ws, registry } = setup();
    const entry = { name: "Escowear", workspace: `${ws}/escowear`, mode: "create" as const };
    const check = await validateWorkspace(registry, entry);
    expect(check).toMatchObject({ ok: true, workspace: { path: entry.workspace, headBefore: null } });
    fs.writeFileSync(`${entry.workspace}/keep.txt`, "keep");
    expect(await validateWorkspace(registry, entry)).toMatchObject({ ok: false, code: "exists" });
    expect(fs.readFileSync(`${entry.workspace}/keep.txt`, "utf8")).toBe("keep");
  });
  it("accepts a clean existing child repository that is not registered", async () => {
    const { ws, registry } = setup();
    const repo = makeRepo(ws, "escowear");
    const entry = resolveWorkspaceTarget(registry, { project: null, description: `Beast workspace: ${repo}` });
    expect(entry).toMatchObject({ workspace: repo, mode: "existing" });
    expect(await validateWorkspace(registry, entry!)).toMatchObject({ ok: true, workspace: { path: repo } });
  });
  it("blocks existing mode when the child does not exist, without creating it", async () => {
    const { ws, registry } = setup();
    expect(await validateWorkspace(registry, { name: "X", workspace: `${ws}/nope` })).toMatchObject({ ok: false, code: "missing" });
    expect(fs.existsSync(`${ws}/nope`)).toBe(false);
  });
  it("preserves dirty protection on unregistered repositories", async () => {
    const { ws, registry } = setup();
    const repo = makeRepo(ws, "dirty", { dirty: true });
    expect(await validateWorkspace(registry, { name: "D", workspace: repo })).toMatchObject({ ok: false, code: "dirty" });
  });
  it("rejects outside paths, root itself, prefix siblings, relative paths, and traversal before creation", async () => {
    const { ws, registry } = setup();
    for (const workspace of ["/etc", root + "/outside", ws, ws + "-other/new", "relative", `${ws}/../escape`, `${ws}/x/../new`, `${ws}/trailing/`, `${ws}/./dot`]) {
      expect(await validateWorkspace(registry, { name: "X", workspace, mode: "create" })).toMatchObject({ ok: false, code: "outside_root" });
      expect(() => resolveWorkspaceTarget(registry, { project: null, description: `Beast workspace: ${workspace}` })).toThrow();
    }
    expect(fs.readdirSync(ws)).toEqual([]);
  });
  it("rejects symlink targets, symlink parents, dangling links, and a symlink root", async () => {
    const { ws, registry } = setup();
    const outside = makeRepo(root, "outside");
    fs.symlinkSync(outside, `${ws}/link`);
    fs.symlinkSync(`${root}/missing`, `${ws}/dangling`);
    for (const workspace of [`${ws}/link`, `${ws}/link/new`, `${ws}/dangling`]) {
      expect(await validateWorkspace(registry, { name: "X", workspace, mode: "create" })).toMatchObject({ ok: false, code: "outside_root" });
    }
    expect(fs.existsSync(`${outside}/new`)).toBe(false);
    fs.symlinkSync(ws, `${root}/alias`);
    expect(await validateWorkspace(new ProjectRegistry([], `${root}/alias`), { name: "X", workspace: `${root}/alias/new`, mode: "create" })).toMatchObject({ ok: false, code: "outside_root" });
  });
  it("refuses creation inside an existing repository", async () => {
    const { ws, registry } = setup();
    const repo = makeRepo(ws, "parent", { dirty: true });
    expect(await validateWorkspace(registry, { name: "X", workspace: `${repo}/child`, mode: "create" })).toMatchObject({ ok: false, code: "not_git" });
    expect(fs.existsSync(`${repo}/child`)).toBe(false);
  });
  it("blocks a ticket whose registered project is outside the root without running the agent", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "beast-outside-"));
    const outside = makeRepo(root, "beast-api");
    h = makeHarness({ projects: () => [{ name: "TestProject", workspace: outside }] });
    const issue = makeIssue();
    h.linear.issues[issue.id] = issue;
    const body = webhookBody(issue);
    await request(h.app).post("/webhooks/linear").set("linear-signature", sign(body)).set("Content-Type", "application/json").send(body);
    await h.worker.idle();
    expect(h.agent.calls).toHaveLength(0);
    expect(h.store.listJobs()).toMatchObject([{ state: "blocked", reason: expect.stringMatching(/inside/) }]);
    expect(fs.readdirSync(outside).sort()).toEqual([".git", "README.md"]);
  });
  it("routes an authorized webhook to a child instead of its registered project", async () => {
    h = makeHarness();
    const repo = makeRepo(h.workspaceRoot, "other");
    const issue = makeIssue({ description: `Beast workspace: ${repo}` });
    h.linear.issues[issue.id] = issue;
    const body = webhookBody(issue);
    await request(h.app).post("/webhooks/linear").set("linear-signature", sign(body)).set("Content-Type", "application/json").send(body);
    await h.worker.idle();
    expect(h.agent.calls).toHaveLength(1);
    expect(h.agent.calls[0]?.workspace.path).toBe(repo);
    expect(h.store.findActiveByIssue(issue.id)).toBeUndefined();
  });
});
