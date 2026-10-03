import path from "node:path";
import { AuditLog } from "../src/admin/audit.js";
import type { AuthorizationGrant } from "../src/admin/authorize.js";
import { GuardedExecutor } from "../src/admin/executor.js";
import { parsePolicy, type PolicyLoad } from "../src/admin/policy.js";
import { lstatPath, type HostProbe, type LstatResult, type Pm2App, type UnitInfo } from "../src/admin/probe.js";
import { operationIds } from "../src/admin/registry.js";
import { AdminService } from "../src/admin/service.js";
import type { ValidatedOperation } from "../src/admin/validate.js";
import { silentLogger } from "../src/logger.js";
import { createApp } from "../src/app.js";
import { LinearReporter } from "../src/linear/reporter.js";
import { makeHarness, makeIssue, READY, type Harness } from "./helpers.js";
import type { LinearIssue } from "../src/linear/types.js";

export const ADMIN = "Beast Admin";
export const REQUESTER = "user-kofi";
export const APPROVER = "user-kofi";
export const BEAST_USER = "beast-bot";

/** Host lookups without touching systemd, PM2 or NSS. Paths use the real filesystem unless overridden. */
export class FakeProbe implements HostProbe {
  units: Record<string, UnitInfo | null> = {
    "nginx.service": { loadState: "loaded", fragmentPath: "/usr/lib/systemd/system/nginx.service" },
    "ssh.service": { loadState: "loaded", fragmentPath: "/usr/lib/systemd/system/ssh.service" },
    "redis-server.service": { loadState: "loaded", fragmentPath: "/usr/lib/systemd/system/redis-server.service" },
    "systemd-journald.service": { loadState: "loaded", fragmentPath: "/usr/lib/systemd/system/systemd-journald.service" },
    "beast-api.service": { loadState: "loaded", fragmentPath: "/etc/systemd/system/beast-api.service" },
    "ghost.service": { loadState: "not-found", fragmentPath: "" },
  };
  apps: Pm2App[] | null = [
    { name: "ideahub-api", execPath: "/home/ubuntu/apps/ideahub-api/server.js" },
    { name: "beast-api", execPath: "/usr/bin/env" },
  ];
  users: Record<string, number> = { ubuntu: 1000, "www-data": 33, root: 0 };
  groups: Record<string, number> = { ubuntu: 1000, "www-data": 33, root: 0 };
  pathOverrides: Record<string, LstatResult> = {};
  calls = 0;

  async unit(name: string) {
    this.calls++;
    return name in this.units ? this.units[name]! : { loadState: "not-found", fragmentPath: "" };
  }
  async pm2Apps() {
    this.calls++;
    return this.apps;
  }
  async userId(name: string) {
    return this.users[name] ?? null;
  }
  async groupId(name: string) {
    return this.groups[name] ?? null;
  }
  async lstat(p: string) {
    return this.pathOverrides[p] ?? lstatPath(p);
  }
}

/** Records what it was asked to do; never touches the host. */
export class FakeExecutor extends GuardedExecutor {
  readonly kind = "fake";
  executed: { op: ValidatedOperation; grant: AuthorizationGrant }[] = [];
  behaviour: (op: ValidatedOperation) => unknown = (op) => ({ status: "succeeded", fields: { action: op.summary } });
  protected async perform(op: ValidatedOperation, grant: AuthorizationGrant) {
    this.executed.push({ op, grant });
    return this.behaviour(op);
  }
}

export function policyWith(enabled: string[] = operationIds(), extra: Partial<Record<string, string[]>> = {}): PolicyLoad {
  return { ok: true, policy: parsePolicy({ version: 1, enabledOperations: enabled, ...extra }) };
}

export interface AdminHarness extends Harness {
  probe: FakeProbe;
  executor: FakeExecutor;
  admin: AdminService;
  audit: AuditLog;
  clock: { now: number };
}

export function makeAdminHarness(opts: { policy?: PolicyLoad; requesters?: string[]; approvers?: string[]; sharedIdentity?: boolean } = {}): AdminHarness {
  const h = makeHarness({ autoKick: false });
  const probe = new FakeProbe();
  const executor = new FakeExecutor();
  const audit = new AuditLog(path.join(h.dataDir, "admin-audit.jsonl"));
  const clock = { now: Date.now() };
  h.linear.viewerId = BEAST_USER;
  const admin = new AdminService({
    label: ADMIN,
    readyLabel: READY,
    auth: { requesters: opts.requesters ?? [REQUESTER], approvers: opts.approvers ?? [APPROVER], sharedIdentity: opts.sharedIdentity },
    policy: opts.policy ?? policyWith(),
    probe,
    executor,
    audit,
    store: h.store,
    linear: h.linear,
    logger: silentLogger,
    beastPaths: [path.join(h.root, "beast-code"), h.dataDir],
    now: () => clock.now,
  });
  const app = createApp({
    store: h.store,
    registry: h.registry,
    linear: h.linear,
    reporter: new LinearReporter(h.linear, silentLogger),
    logger: silentLogger,
    webhookSecret: "test-webhook-secret",
    webhookToleranceMs: 60_000,
    readyLabel: READY,
    agent: "fake",
    onQueued: () => undefined,
    adminLabel: ADMIN,
    admin,
  });
  return { ...h, app, probe, executor, admin, audit, clock };
}

export function adminIssue(op: string, params?: Record<string, unknown>, overrides: Partial<LinearIssue> = {}): LinearIssue {
  const lines = [`Beast admin operation: ${op}`, ...(params ? [`Beast admin params: ${JSON.stringify(params)}`] : [])];
  return makeIssue({
    id: "admin-issue-1",
    identifier: "IDE-900",
    title: "Admin request",
    description: `Please do this.\n\n${lines.join("\n")}\n`,
    labels: [{ id: "label-admin", name: ADMIN }],
    ...overrides,
  });
}

export function commentBody(payload: { id: string; body: string; issueId: string; action?: string }): string {
  return JSON.stringify({
    action: payload.action ?? "create",
    type: "Comment",
    webhookTimestamp: Date.now(),
    data: { id: payload.id, body: payload.body, issueId: payload.issueId },
  });
}
