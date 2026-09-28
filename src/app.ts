import express, { type Request, type Response } from "express";
import { createHash } from "node:crypto";
import type { LinearReporter } from "./linear/reporter.js";
import type { LinearClient } from "./linear/client.js";
import type { Logger } from "./logger.js";
import type { JobStore } from "./queue/store.js";
import type { ProjectRegistry } from "./registry/registry.js";
import { handleLinearEvent, type LinearWebhookPayload } from "./webhook/intake.js";
import { isFreshTimestamp, verifySignature } from "./webhook/signature.js";

export interface AppDeps {
  store: JobStore;
  registry: ProjectRegistry;
  linear: LinearClient;
  reporter: LinearReporter;
  logger: Logger;
  webhookSecret: string | undefined;
  webhookToleranceMs: number;
  readyLabel: string;
  agent: string;
  onQueued: () => void;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  const inFlight = new Set<string>();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", agent: deps.agent, jobs: deps.store.countByState() });
  });

  app.get("/jobs/:id", (req: Request<{ id: string }>, res) => {
    const job = deps.store.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    res.json(job);
  });

  app.post("/webhooks/linear", express.raw({ type: () => true, limit: "1mb" }), async (req: Request, res: Response) => {
    const log = deps.logger.child({ route: "webhook" });

    if (!deps.webhookSecret) {
      log.warn("webhook rejected: LINEAR_WEBHOOK_SECRET not configured");
      res.status(503).json({ error: "webhook secret not configured" });
      return;
    }

    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifySignature(raw, req.get("linear-signature"), deps.webhookSecret)) {
      log.warn("webhook rejected: invalid signature");
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    let payload: LinearWebhookPayload;
    try {
      payload = JSON.parse(raw.toString("utf8")) as LinearWebhookPayload;
    } catch {
      res.status(400).json({ error: "invalid JSON" });
      return;
    }

    if (!isFreshTimestamp(payload.webhookTimestamp, deps.webhookToleranceMs)) {
      log.warn("webhook rejected: stale or missing timestamp");
      res.status(401).json({ error: "stale webhook" });
      return;
    }

    const deliveryId = req.get("linear-delivery") || `body-${createHash("sha256").update(raw).digest("hex")}`;
    if (deps.store.hasDelivery(deliveryId) || inFlight.has(deliveryId)) {
      log.info("duplicate delivery ignored", { deliveryId });
      res.status(200).json({ status: "duplicate" });
      return;
    }

    inFlight.add(deliveryId);
    try {
      const result = await handleLinearEvent(deps, deliveryId, payload);
      deps.store.recordDelivery(deliveryId, {
        receivedAt: new Date().toISOString(),
        outcome: result.outcome,
        jobId: "jobId" in result ? result.jobId : undefined,
      });
      res.status(result.outcome === "queued" ? 202 : 200).json(result);
    } catch (err) {
      // Not recorded as delivered, so Linear's retry can be processed.
      log.error("webhook processing failed", { deliveryId, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "processing failed" });
    } finally {
      inFlight.delete(deliveryId);
    }
  });

  return app;
}
