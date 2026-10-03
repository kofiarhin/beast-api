import fs from "node:fs";
import type net from "node:net";
import path from "node:path";
import { loadPolicy } from "../admin/policy.js";
import {
  brokerRequestProblem,
  encode,
  LineDecoder,
  type ExecutorWireRequest,
  type ProbeRequest,
  type SpawnRequest,
} from "../admin/protocol.js";
import { sanitizeResult } from "../admin/result.js";
import type { OperationResult } from "../admin/types.js";
import { validateOperation, type ValidatedOperation } from "../admin/validate.js";
import type { Logger } from "../logger.js";
import type { BrokerHost } from "./host.js";
import { performOperation, type RawResult } from "./operations.js";
import { startSpawn, type SpawnHandle } from "./spawn.js";

/**
 * The privileged broker. Only root and the `beast` group can open its socket (enforced
 * by the socket's mode, set by systemd). It trusts nothing in a request: every admin
 * operation is re-validated against the broker's own root-owned policy, its targets are
 * re-probed and must match the facts Beast API validated (and a class C approval was
 * bound to), and a class C approval digest can be used only once.
 */
export interface BrokerDeps {
  host: BrokerHost;
  logger: Logger;
  /** Test seam; production always uses `performOperation`. */
  perform?: (op: ValidatedOperation, host: BrokerHost) => Promise<RawResult>;
}

type Reply = (msg: unknown) => void;

export class Broker {
  /** Admin operations run one at a time. */
  private lane: Promise<unknown> = Promise.resolve();
  private readonly spawns = new Set<SpawnHandle>();

  constructor(private readonly deps: BrokerDeps) {}

  private get cfg() {
    return this.deps.host.cfg;
  }

  handle(socket: net.Socket): void {
    const decoder = new LineDecoder();
    let request: unknown;
    let spawn: SpawnHandle | undefined;
    let closed = false;
    const reply: Reply = (msg) => {
      if (!closed && socket.writable) socket.write(encode(msg));
    };
    const finish = (msg: unknown) => {
      reply(msg);
      socket.end();
    };

    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("close", () => {
      closed = true;
      // Beast API went away: never leave its process running.
      spawn?.stop();
    });
    socket.on("data", (chunk: string) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        finish({ type: "error", reason: `bad message: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      for (const msg of messages) {
        if (request === undefined) {
          request = msg;
          void this.dispatch(msg, reply, finish, (h) => (spawn = h)).catch((err) =>
            finish({ type: "error", reason: `internal error: ${err instanceof Error ? err.message : String(err)}` }),
          );
        } else if (spawn && typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "kill") {
          spawn.stop();
        } else {
          finish({ type: "error", reason: "one request per connection" });
        }
      }
    });
  }

  private async dispatch(raw: unknown, reply: Reply, finish: Reply, onSpawn: (h: SpawnHandle) => void): Promise<void> {
    const problem = brokerRequestProblem(raw, this.cfg.workspaceRoot);
    if (problem) {
      this.deps.logger.warn("request refused", { problem, type: (raw as { type?: unknown })?.type });
      finish({ type: "error", reason: `request refused: ${problem}` });
      return;
    }
    const req = raw as ExecutorWireRequest | ProbeRequest | SpawnRequest;
    if (req.type === "probe") {
      finish({ type: "probe", value: await this.probe(req) });
      return;
    }
    if (req.type === "admin") {
      const run = this.lane.then(() => this.admin(req));
      this.lane = run.catch(() => undefined);
      finish({ type: "result", result: await run });
      return;
    }
    this.deps.logger.info("spawn", { program: req.program, cwd: req.cwd, user: this.cfg.agentUser });
    const handle = await startSpawn(req, this.deps.host, reply);
    this.spawns.add(handle);
    onSpawn(handle);
    await handle.done;
    this.spawns.delete(handle);
    finish({ type: "end" });
  }

  private async probe(req: ProbeRequest): Promise<unknown> {
    const p = this.deps.host.probe();
    switch (req.what) {
      case "unit":
        return p.unit(req.name);
      case "pm2Apps":
        return p.pm2Apps();
      case "userId":
        return p.userId(req.name);
      case "groupId":
        return p.groupId(req.name);
      case "lstat":
        return p.lstat(req.path);
      case "deployment":
        return p.deployment({ op: req.op, target: req.target, ...(req.commit !== undefined ? { commit: req.commit } : {}) });
    }
  }

  private consumedFile(): string {
    return path.join(this.cfg.stateDir, "consumed-approvals.json");
  }

  /** Record a class C digest as used before execution. Returns false if it was already used. */
  private consume(digest: string, requestId: string): boolean {
    const file = this.consumedFile();
    let used: Record<string, { requestId: string; at: string }> = {};
    if (fs.existsSync(file)) used = JSON.parse(fs.readFileSync(file, "utf8")) as typeof used;
    if (used[digest]) return false;
    used[digest] = { requestId, at: new Date().toISOString() };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(used), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  }

  private async admin(req: ExecutorWireRequest): Promise<OperationResult> {
    const started = Date.now();
    const log = this.deps.logger.child({ requestId: req.requestId, op: req.op, class: req.grant.class, issueId: req.grant.issueId });
    const deny = (reason: string): OperationResult => {
      log.warn("admin denied", { reason });
      return { status: "denied", op: req.op, requestId: req.requestId, riskClass: req.grant.class, fields: {}, durationMs: Date.now() - started, reason };
    };

    const v = await validateOperation(
      { op: req.op, params: req.params },
      { requestId: req.requestId, policy: loadPolicy(this.cfg.policyFile), probe: this.deps.host.probe(), beastPaths: this.cfg.beastPaths },
    );
    if (!v.ok) return deny(`broker validation: ${v.code}: ${v.reason}`);
    const op = v.operation;
    if (op.opVersion !== req.opVersion) return deny("operation version mismatch");
    if (op.riskClass !== req.grant.class) return deny(`risk class mismatch: broker classifies this as class ${op.riskClass}`);
    const keys = Object.keys(op.facts).sort();
    if (keys.join("\0") !== Object.keys(req.facts).sort().join("\0") || keys.some((k) => op.facts[k] !== req.facts[k])) {
      return deny("target changed since Beast validated it");
    }
    if (op.riskClass === "C" && !this.consume(req.grant.digest!, req.requestId)) return deny("this approval has already been used");

    log.info("admin executing", { params: op.params, requester: req.grant.requester, approver: req.grant.approver, protected: op.protected });
    let raw: RawResult;
    try {
      raw = await (this.deps.perform ?? performOperation)(op, this.deps.host);
    } catch (err) {
      raw = { status: "failed", reason: `executor error: ${err instanceof Error ? err.message : String(err)}` };
    }
    const result = sanitizeResult(raw, op, started);
    log.info("admin finished", { status: result.status, reason: result.reason });
    return result;
  }

  /** Stop every running spawn (broker shutdown). */
  stopAll(): void {
    for (const s of this.spawns) s.stop();
  }
}
