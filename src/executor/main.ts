import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createLogger } from "../logger.js";
import { Broker } from "./broker.js";
import { loadBrokerConfig } from "./config.js";
import { BrokerHost } from "./host.js";

/**
 * beast-executor entry point. Runs as root under systemd and serves the socket systemd
 * passes in (socket activation, fd 3), whose owner, group and mode systemd controls.
 */
const logger = createLogger({ service: "beast-executor" });

if (process.getuid?.() !== 0) {
  logger.error("beast-executor must run as root");
  process.exit(1);
}
if (process.env.LISTEN_FDS !== "1" || process.env.LISTEN_PID !== String(process.pid)) {
  logger.error("beast-executor must be started by its systemd socket unit");
  process.exit(1);
}

const cfg = loadBrokerConfig();
fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(cfg.stateDir, "capture"), { recursive: true, mode: 0o711 });

const broker = new Broker({ host: new BrokerHost(cfg), logger });
const server = net.createServer((socket) => broker.handle(socket));
server.listen({ fd: 3 }, () => logger.info("listening", { agentUser: cfg.agentUser, pm2User: cfg.pm2User, policy: cfg.policyFile }));

const shutdown = (signal: string) => {
  logger.info("shutting down", { signal });
  broker.stopAll();
  server.close();
  setTimeout(() => process.exit(0), 12_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
