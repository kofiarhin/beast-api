import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAdminDirective } from "../src/admin/directive.js";
import { checkPathSyntax, isProtectedPath } from "../src/admin/paths.js";
import { loadPolicy, parsePolicy } from "../src/admin/policy.js";
import { getOperation, operationIds, type ParamSpec } from "../src/admin/registry.js";
import { isValidatedOperation, validateOperation, type ValidationContext } from "../src/admin/validate.js";
import { FakeProbe, policyWith } from "./admin-helpers.js";
import { makeTmpDir, removeTmpDir } from "./helpers.js";

let root: string;
let probe: FakeProbe;
let ctx: ValidationContext;
beforeEach(() => {
  root = makeTmpDir();
  probe = new FakeProbe();
  ctx = { requestId: "req-1", policy: policyWith(), probe, beastPaths: [path.join(root, "beast")] };
});
afterEach(() => removeTmpDir(root));

const validate = (op: unknown, params?: unknown, c: ValidationContext = ctx) => validateOperation({ op, params }, c);

describe("operation registry", () => {
  it("contains exactly the approved v1 operations (snapshot: any change shows up in review)", () => {
    expect(operationIds().sort()).toEqual([
      "deploy.rollback",
      "deploy.run",
      "deploy.status",
      "filesystem.chown",
      "filesystem.inspect",
      "nginx.reload",
      "nginx.test",
      "package.inspect",
      "pm2.restart",
      "pm2.status",
      "service.restart",
      "service.status",
      "system.logs",
    ]);
  });

  it("has no free-form string or argument-list parameter types", () => {
    const allowed = new Set(["unit", "pm2App", "path", "user", "group", "package", "deployTarget", "commit", "int", "bool", "enum"]);
    for (const id of operationIds()) {
      for (const spec of Object.values(getOperation(id)!.params) as ParamSpec[]) expect(allowed.has(spec.type)).toBe(true);
    }
  });

  it("does not expose profile.update in v1", async () => {
    expect(getOperation("profile.update")).toBeUndefined();
    const res = await validate("profile.update", {});
    expect(res).toMatchObject({ ok: false, code: "unknown_operation" });
  });

  it("ships with every operation disabled (opt-in per operation)", () => {
    const shipped = loadPolicy(path.resolve(import.meta.dirname, "../config/admin-policy.json"));
    expect(shipped).toEqual({
      ok: true,
      policy: { enabledOperations: [], additionalProtectedServices: [], additionalProtectedPaths: [] },
    });
  });
});

describe("fail closed on unknown, disabled or malformed requests", () => {
  it("rejects unknown operations", async () => {
    for (const op of ["shell.exec", "sudo", "execRoot", "runAsRoot", "service.restart; rm -rf /", ""]) {
      expect((await validate(op, {})).ok).toBe(false);
    }
  });

  it("rejects a registered operation that the policy does not enable", async () => {
    const res = await validate("service.status", { unit: "nginx.service" }, { ...ctx, policy: policyWith(["nginx.test"]) });
    expect(res).toMatchObject({ ok: false, code: "operation_disabled" });
  });

  it("denies everything when the policy is invalid", async () => {
    const res = await validate("nginx.test", {}, { ...ctx, policy: { ok: false, error: "bad policy" } });
    expect(res).toMatchObject({ ok: false, code: "policy_invalid" });
  });

  it("rejects malformed params", async () => {
    const cases: unknown[] = [[], "unit=nginx", 5, ["nginx.service"]];
    for (const params of cases) expect(await validate("service.status", params)).toMatchObject({ ok: false, code: "malformed" });
    expect(await validate("service.status", {})).toMatchObject({ ok: false, code: "invalid_params" });
    expect(await validate("service.status", { unit: "nginx.service", extra: "x" })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(await validate("service.status", { unit: 42 })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(await validate("system.logs", { unit: "nginx.service", lines: 0 })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(await validate("system.logs", { unit: "nginx.service", lines: 501 })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(await validate("system.logs", { unit: "nginx.service", lines: 1.5 })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(await validate("system.logs", { lines: 10 })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(await validate("system.logs", { unit: "nginx.service", app: "ideahub-api", lines: 10 })).toMatchObject({ ok: false });
    expect(await validate("filesystem.chown", { path: root, owner: "ubuntu", group: "ubuntu", recursive: "yes" })).toMatchObject({
      ok: false,
      code: "invalid_params",
    });
  });

  it("rejects a params object that is not a plain object", async () => {
    const res = await validate("nginx.test", Object.create({ inherited: true }));
    expect(res).toMatchObject({ ok: false, code: "malformed" });
  });
});

describe("arbitrary shell commands are rejected", () => {
  const payloads = [
    "nginx.service; rm -rf /",
    "nginx.service && id",
    "nginx.service | sh",
    "$(id).service",
    "`id`.service",
    "nginx.service\nid",
    "nginx.service > /etc/passwd",
    "'nginx.service'",
    "nginx.service #",
    "bash -c id",
    "sh -c 'id'",
    "nginx.service\u0000",
  ];
  it.each(payloads)("unit %j", async (unit) => {
    const res = await validate("service.restart", { unit });
    expect(res.ok).toBe(false);
    expect(probe.calls).toBe(0); // rejected before any host lookup
  });

  it("rejects shell syntax in every string parameter type", async () => {
    expect((await validate("pm2.restart", { app: "ideahub-api;id" })).ok).toBe(false);
    expect((await validate("package.inspect", { name: "nginx$(id)" })).ok).toBe(false);
    expect((await validate("filesystem.chown", { path: "/srv/$(id)", owner: "ubuntu", group: "ubuntu", recursive: false })).ok).toBe(false);
    expect((await validate("filesystem.chown", { path: root, owner: "root;id", group: "ubuntu", recursive: false })).ok).toBe(false);
    expect((await validate("system.logs", { nginx: "access|id", lines: 5 })).ok).toBe(false);
  });

  it("rejects values that would look like command-line options", async () => {
    expect((await validate("service.status", { unit: "--help.service" })).ok).toBe(false);
    expect((await validate("pm2.status", { app: "-s" })).ok).toBe(false);
    expect((await validate("package.inspect", { name: "-x" })).ok).toBe(false);
    expect(checkPathSyntax("/srv/-rf")).toMatch(/must not start with -/);
  });
});

describe("unsupported services and targets are rejected", () => {
  it("rejects units and PM2 apps that do not exist", async () => {
    expect(await validate("service.restart", { unit: "ghost.service" })).toMatchObject({ ok: false, code: "unsupported_target" });
    expect(await validate("service.restart", { unit: "unknown.service" })).toMatchObject({ ok: false, code: "unsupported_target" });
    expect(await validate("pm2.restart", { app: "no-such-app" })).toMatchObject({ ok: false, code: "unsupported_target" });
    expect(await validate("service.status", { unit: "nginx" })).toMatchObject({ ok: false, code: "invalid_params" });
  });

  it("denies when the host cannot be queried (uncertain)", async () => {
    probe.units["nginx.service"] = null;
    probe.apps = null;
    expect(await validate("service.status", { unit: "nginx.service" })).toMatchObject({ ok: false, code: "uncertain" });
    expect(await validate("pm2.status", { app: "ideahub-api" })).toMatchObject({ ok: false, code: "uncertain" });
  });

  it("rejects unknown owners and groups, and numeric IDs", async () => {
    const base = { path: root, recursive: false };
    expect(await validate("filesystem.chown", { ...base, owner: "nobody-here", group: "ubuntu" })).toMatchObject({ ok: false, code: "unsupported_target" });
    expect(await validate("filesystem.chown", { ...base, owner: "ubuntu", group: "nogroup-here" })).toMatchObject({ ok: false, code: "unsupported_target" });
    expect(await validate("filesystem.chown", { ...base, owner: "0", group: "ubuntu" })).toMatchObject({ ok: false, code: "invalid_params" });
  });

  it("rejects pseudo filesystems", async () => {
    for (const p of ["/proc/1", "/sys/kernel", "/dev/sda", "/run/user/1000"]) {
      expect(await validate("filesystem.inspect", { path: p })).toMatchObject({ ok: false, code: "invalid_params" });
    }
  });

  it("refuses beast-api and beast-executor restarts outright", async () => {
    for (const unit of ["beast-api.service", "beast-executor.service", "beast-executor.socket", "beast-api@x.service"]) {
      expect(await validate("service.restart", { unit })).toMatchObject({ ok: false, code: "refused" });
    }
    expect(await validate("pm2.restart", { app: "beast-api" })).toMatchObject({ ok: false, code: "refused" });
    expect(await validate("pm2.restart", { app: "beast-executor" })).toMatchObject({ ok: false, code: "refused" });
  });
});

describe("path traversal and unsafe symlinks are rejected", () => {
  it.each([
    "relative/path",
    "/srv/../etc/shadow",
    "/srv/./x",
    "/srv//x",
    "/srv/x/",
    "/srv/x/..",
    "/srv/%2e%2e/etc",
    "/srv/x y",
    "/srv/x\ny",
    "/srv/\u0000",
    "~/x",
    "",
  ])("path %j", async (p) => {
    const res = await validate("filesystem.inspect", { path: p });
    expect(res.ok).toBe(false);
  });

  it("rejects a symlink leaf, a symlinked parent and a dangling symlink", async () => {
    const real = path.join(root, "real");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "f"), "x");
    fs.symlinkSync(real, path.join(root, "link-dir"));
    fs.symlinkSync(path.join(real, "f"), path.join(root, "link-file"));
    fs.symlinkSync(path.join(root, "missing"), path.join(root, "dangling"));
    for (const p of [path.join(root, "link-file"), path.join(root, "link-dir", "f"), path.join(root, "dangling")]) {
      const res = await validate("filesystem.chown", { path: p, owner: "ubuntu", group: "ubuntu", recursive: false });
      expect(res).toMatchObject({ ok: false, code: "unsafe_path" });
    }
  });

  it("rejects missing paths and paths it cannot verify", async () => {
    expect(await validate("filesystem.inspect", { path: path.join(root, "nope") })).toMatchObject({ ok: false, code: "unsupported_target" });
    probe.pathOverrides[root] = "denied";
    expect(await validate("filesystem.inspect", { path: path.join(root, "x") })).toMatchObject({ ok: false, code: "uncertain" });
  });

  it("accepts a canonical real path and records its identity as facts", async () => {
    const dir = path.join(root, "uploads");
    fs.mkdirSync(dir);
    const res = await validate("filesystem.chown", { path: dir, owner: "www-data", group: "www-data", recursive: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(isValidatedOperation(res.operation)).toBe(true);
    expect(isValidatedOperation({ ...res.operation })).toBe(false);
    expect(res.operation.riskClass).toBe("C");
    expect(res.operation.facts["path.ino"]).toBe(String(fs.statSync(dir).ino));
    expect(res.operation.facts["owner.uid"]).toBe("33");
    expect(Object.isFrozen(res.operation.params)).toBe(true);
  });
});

describe("risk classes", () => {
  it("classifies inspection as A, ordinary restarts as B and protected restarts and chown as C", async () => {
    const cls = async (op: string, params: Record<string, unknown>) => {
      const res = await validate(op, params);
      if (!res.ok) throw new Error(res.reason);
      return [res.operation.riskClass, res.operation.protected];
    };
    expect(await cls("service.status", { unit: "ssh.service" })).toEqual(["A", false]);
    expect(await cls("system.logs", { app: "ideahub-api", lines: 100 })).toEqual(["A", false]);
    expect(await cls("nginx.test", {})).toEqual(["A", false]);
    expect(await cls("package.inspect", { name: "nginx" })).toEqual(["A", false]);
    expect(await cls("filesystem.inspect", { path: root })).toEqual(["A", false]);
    expect(await cls("service.restart", { unit: "redis-server.service" })).toEqual(["B", false]);
    expect(await cls("pm2.restart", { app: "ideahub-api" })).toEqual(["B", false]);
    expect(await cls("nginx.reload", {})).toEqual(["B", false]);
    expect(await cls("service.restart", { unit: "ssh.service" })).toEqual(["C", true]);
    expect(await cls("service.restart", { unit: "nginx.service" })).toEqual(["C", true]);
    expect(await cls("service.restart", { unit: "systemd-journald.service" })).toEqual(["C", true]);
    expect(await cls("filesystem.chown", { path: root, owner: "ubuntu", group: "ubuntu", recursive: false })).toEqual(["C", false]);
  });

  it("marks the approved protected paths", () => {
    const ctx = { beastPaths: ["/home/ubuntu/apps/beast-api"] };
    for (const p of ["/", "/etc", "/etc/sudoers.d/x", "/boot", "/usr/bin", "/bin", "/sbin", "/lib/x", "/lib64", "/var/lib/dpkg", "/root",
      "/home/ubuntu/.ssh", "/home/ubuntu/.ssh/authorized_keys", "/srv/app/.env", "/srv/app/.env.local", "/home/ubuntu/.config/beast-api/production.env",
      "/srv/tls/site.pem", "/srv/tls/site.key", "/home/ubuntu/id_ed25519", "/home/ubuntu/.codex", "/home/ubuntu/.claude/x",
      "/home/ubuntu/apps/beast-api", "/home/ubuntu/apps/beast-api/data/state.json"]) {
      expect(isProtectedPath(p, ctx), p).toBe(true);
    }
    for (const p of ["/srv/app/uploads", "/home/ubuntu/projects/app", "/var/www/html", "/etcetera", "/usrlocal"]) {
      expect(isProtectedPath(p, ctx), p).toBe(false);
    }
  });

  it("treats a recursive change that covers protected locations or a whole home directory as protected", () => {
    const ctx = { beastPaths: ["/home/ubuntu/apps/beast-api"] };
    expect(isProtectedPath("/home/ubuntu", ctx, true)).toBe(true);
    expect(isProtectedPath("/home", ctx, true)).toBe(true);
    expect(isProtectedPath("/home/ubuntu/apps", ctx, true)).toBe(true);
    expect(isProtectedPath("/var/lib", ctx, true)).toBe(true);
    expect(isProtectedPath("/home/ubuntu/projects/app", ctx, true)).toBe(false);
    expect(isProtectedPath("/var/www", ctx, true)).toBe(false);
  });
});

describe("directive parsing", () => {
  it("requires exactly one operation line and at most one single-line JSON params line", () => {
    expect(parseAdminDirective("Beast admin operation: nginx.test")).toEqual({ ok: true, request: { op: "nginx.test", params: {} } });
    expect(parseAdminDirective("no directive").ok).toBe(false);
    // Linear autolinks ids ending in a TLD; only the exact self-link is unwrapped.
    expect(parseAdminDirective("Beast admin operation: [deploy.run](<http://deploy.run>)")).toEqual({ ok: true, request: { op: "deploy.run", params: {} } });
    expect(parseAdminDirective("Beast admin operation: [deploy.run](http://deploy.run)")).toEqual({ ok: true, request: { op: "deploy.run", params: {} } });
    expect(parseAdminDirective("Beast admin operation: [deploy.run](<http://evil.run>)")).toMatchObject({ ok: true, request: { op: "[deploy.run](<http://evil.run>)" } });
    expect(parseAdminDirective("Beast admin operation: [deploy.run](<http://deploy.run/x>)")).toMatchObject({ ok: true, request: { op: "[deploy.run](<http://deploy.run/x>)" } });
    expect(parseAdminDirective("Beast admin operation: a\nBeast admin operation: b").ok).toBe(false);
    expect(parseAdminDirective("Beast admin operation: a\nBeast admin params: {}\nBeast admin params: {}").ok).toBe(false);
    expect(parseAdminDirective("Beast admin operation: a\nBeast admin params: [1]").ok).toBe(false);
    expect(parseAdminDirective("Beast admin operation: a\nBeast admin params: {not json").ok).toBe(false);
    expect(parseAdminDirective(`Beast admin operation: a\nBeast admin params: {"x":"${"a".repeat(3000)}"}`).ok).toBe(false);
    expect(parseAdminDirective("Mentioning Beast admin operation: in prose does not count").ok).toBe(false);
  });
});

describe("admin policy", () => {
  it("rejects unknown operations, unknown keys and bad protected entries", () => {
    expect(() => parsePolicy({ version: 1, enabledOperations: ["shell.exec"] })).toThrow(/unknown operation/);
    expect(() => parsePolicy({ version: 1, enabledOperations: [], allowShell: true })).toThrow(/unknown policy keys/);
    expect(() => parsePolicy({ version: 2, enabledOperations: [] })).toThrow(/version/);
    expect(() => parsePolicy({ version: 1, enabledOperations: [], additionalProtectedPaths: ["../x"] })).toThrow();
    expect(() => parsePolicy({ version: 1, enabledOperations: ["nginx.test", "nginx.test"] })).toThrow(/duplicates/);
  });
});
