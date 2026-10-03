import path from "node:path";
import { AuditLog } from "./admin/audit.js";
import { BrokerExecutor, DryRunExecutor, type PrivilegedExecutor } from "./admin/executor.js";
import { loadPolicy } from "./admin/policy.js";
import { BrokerHostProbe, SystemHostProbe, type HostProbe } from "./admin/probe.js";
import { AdminService } from "./admin/service.js";
import { createAgentAdapter } from "./agents/index.js";
import { createApp } from "./app.js";
import { HOST, loadConfig } from "./config.js";
import { LinearGraphQLClient, UnconfiguredLinearClient, type LinearClient } from "./linear/client.js";
import { LinearReporter } from "./linear/reporter.js";
import { createLogger } from "./logger.js";
import { JobStore } from "./queue/store.js";
import { Worker } from "./queue/worker.js";
import { loadRegistry } from "./registry/registry.js";
import { BrokerClient } from "./executor/client.js";
import { BrokerCommandRunner } from "./executor/runner.js";
import { killActiveProcessGroups, setCommandRunner } from "./util/exec.js";

/** Upper bound for one admin operation over the executor socket (deployments included). */
const ADMIN_EXECUTION_TIMEOUT_MS = 90 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ service: "beast-api" });

  // In production every child process (agent, verification, Git) runs as beast-agent
  // through beast-executor; Beast API itself starts no processes.
  const broker = config.runner === "broker" ? new BrokerClient(config.executorSocket) : undefined;
  if (broker) {
    if (process.getuid?.() === 0) throw new Error("Beast API must not run as root");
    setCommandRunner(new BrokerCommandRunner(broker, { [config.claudeBin]: "claude", [config.codexBin]: "codex", npm: "npm", git: "git" }));
  }

  const registry = loadRegistry(config.projectsFile, config.workspaceRoot);
  if (registry.outsideRoot.length) {
    logger.warn("registry entries outside the workspace root will always be blocked", {
      workspaceRoot: config.workspaceRoot,
      projects: registry.outsideRoot,
    });
  }
  const adapter = createAgentAdapter(config);
  const store = new JobStore(config.dataDir);
  const linear: LinearClient = config.linearApiKey
    ? new LinearGraphQLClient(config.linearApiKey, config.linearApiUrl)
    : new UnconfiguredLinearClient(logger);
  const reporter = new LinearReporter(linear, logger);

  if (!config.linearApiKey) logger.warn("LINEAR_API_KEY not set; Linear reads/comments disabled");
  if (!config.linearWebhookSecret) logger.warn("LINEAR_WEBHOOK_SECRET not set; all webhooks will be rejected");

  for (const job of store.recoverInterrupted()) {
    logger.warn("interrupted job marked failed", { jobId: job.id, issueId: job.issue.identifier, jobState: job.state });
    await reporter.failed(job, job.reason ?? "interrupted");
  }

  const worker = new Worker({
    store,
    registry,
    adapter,
    reporter,
    logger,
    logDir: path.join(config.dataDir, "logs"),
    agentTimeoutMs: config.agentTimeoutMs,
    verifyTimeoutMs: config.verifyTimeoutMs,
    verifyScripts: config.verifyScripts,
  });

  // Controlled admin (IDE-69): off by default. `dry-run` executes nothing; `enforce`
  // (which requires the broker runner) executes through beast-executor.
  let admin: AdminService | undefined;
  if (config.adminMode !== "off") {
    const policy = loadPolicy(config.adminPolicyFile);
    if (!policy.ok) logger.error("admin policy invalid; every admin request will be denied", { error: policy.error });
    const audit = new AuditLog(path.join(config.dataDir, "admin-audit.jsonl"));
    if (audit.broken) logger.error("admin audit log failed verification; admin operations cannot run", { error: audit.broken });
    if (!config.linearApiKey) logger.warn("admin mode enabled without LINEAR_API_KEY; every admin request will be denied");
    const probe: HostProbe = broker ? new BrokerHostProbe(broker) : new SystemHostProbe();
    // Admin operations get their own connection timeout: a production deployment (IDE-82)
    // verifies, installs, builds and health-checks, which can take far longer than a probe.
    const executor: PrivilegedExecutor =
      config.adminMode === "enforce" && broker ? new BrokerExecutor(new BrokerClient(config.executorSocket, ADMIN_EXECUTION_TIMEOUT_MS)) : new DryRunExecutor();
    admin = new AdminService({
      label: config.adminLabel,
      readyLabel: config.readyLabel,
      auth: { requesters: config.adminRequesters, approvers: config.adminApprovers, sharedIdentity: config.adminSharedLinearIdentity },
      policy,
      probe,
      executor,
      audit,
      store,
      linear,
      logger: logger.child({ component: "admin" }),
      beastPaths: [path.resolve(import.meta.dirname, ".."), config.dataDir, config.adminPolicyFile],
    });
    for (const job of store.recoverInterruptedAdmin()) {
      logger.warn("interrupted admin job marked failed", { adminJobId: job.id, issueId: job.issueIdentifier });
    }
    setInterval(() => void admin?.sweepExpired().catch(() => undefined), 60_000).unref();
  }

  const app = createApp({
    store,
    registry,
    linear,
    reporter,
    logger,
    webhookSecret: config.linearWebhookSecret,
    webhookToleranceMs: config.webhookToleranceMs,
    readyLabel: config.readyLabel,
    agent: adapter.name,
    onQueued: () => worker.kick(),
    adminLabel: config.adminLabel,
    admin,
  });

  const server = app.listen(config.port, HOST, () => {
    logger.info("beast-api listening", {
      host: HOST,
      port: config.port,
      agent: adapter.name,
      adminMode: config.adminMode,
      runner: config.runner,
      projects: registry.list().map((p) => p.name),
    });
    // Resume jobs that were queued before a restart.
    worker.kick();
    admin?.kick();
  });

  // Last resort: whatever path Beast exits by, no agent process group may outlive it.
  process.on("exit", () => killActiveProcessGroups("SIGKILL"));

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    server.close();
    // Stop the running agent (its whole process group), record the job as failed, then exit.
    void Promise.all([worker.shutdown(), admin?.shutdown()]).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 15_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  process.stderr.write(`beast-api failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
