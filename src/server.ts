import path from "node:path";
import { createAgentAdapter } from "./agents/index.js";
import { createApp } from "./app.js";
import { HOST, loadConfig } from "./config.js";
import { LinearGraphQLClient, UnconfiguredLinearClient, type LinearClient } from "./linear/client.js";
import { LinearReporter } from "./linear/reporter.js";
import { createLogger } from "./logger.js";
import { JobStore } from "./queue/store.js";
import { Worker } from "./queue/worker.js";
import { loadRegistry } from "./registry/registry.js";
import { killActiveProcessGroups } from "./util/exec.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ service: "beast-api" });

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
  });

  const server = app.listen(config.port, HOST, () => {
    logger.info("beast-api listening", {
      host: HOST,
      port: config.port,
      agent: adapter.name,
      projects: registry.list().map((p) => p.name),
    });
    // Resume jobs that were queued before a restart.
    worker.kick();
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
    void worker.shutdown().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 15_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  process.stderr.write(`beast-api failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
