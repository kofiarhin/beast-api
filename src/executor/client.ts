import net from "node:net";
import { encode, LineDecoder, type BrokerRequest, type SpawnEvent, type SpawnRequest } from "../admin/protocol.js";

/**
 * Beast API's side of the broker socket. One request per connection. Any transport
 * problem is an error for the caller to turn into a denial or a failed run; there is no
 * retry and no fallback to running anything locally.
 */
export class BrokerClient {
  private readonly open = new Set<net.Socket>();

  constructor(
    readonly socketPath: string,
    private readonly timeoutMs = 120_000,
  ) {}

  /** Single request, single reply (admin, probe). */
  request<T = unknown>(msg: BrokerRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const decoder = new LineDecoder();
      let done = false;
      const settle = (fn: () => void) => {
        if (done) return;
        done = true;
        socket.destroy();
        fn();
      };
      socket.setEncoding("utf8");
      socket.setTimeout(this.timeoutMs, () => settle(() => reject(new Error("executor request timed out"))));
      socket.on("connect", () => socket.write(encode(msg)));
      socket.on("error", (err) => settle(() => reject(new Error(`executor unavailable: ${err.message}`))));
      socket.on("close", () => settle(() => reject(new Error("executor closed the connection without a reply"))));
      socket.on("data", (chunk: string) => {
        let messages: unknown[];
        try {
          messages = decoder.push(chunk);
        } catch (err) {
          settle(() => reject(err as Error));
          return;
        }
        const m = messages[0] as { type?: string; reason?: string } | undefined;
        if (!m) return;
        if (m.type === "error") settle(() => reject(new Error(m.reason ?? "executor error")));
        else settle(() => resolve(m as T));
      });
    });
  }

  /**
   * Run a process through the broker, streaming its output. Aborting `signal` (or this
   * process exiting) closes the connection, and the broker stops the process group.
   */
  spawn(req: SpawnRequest, onEvent: (e: SpawnEvent) => void, signal?: AbortSignal): Promise<Extract<SpawnEvent, { type: "exit" }>> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      this.open.add(socket);
      const decoder = new LineDecoder();
      let exit: Extract<SpawnEvent, { type: "exit" }> | undefined;
      let done = false;
      const settle = (fn: () => void) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", onAbort);
        this.open.delete(socket);
        socket.destroy();
        fn();
      };
      const onAbort = () => {
        if (socket.writable) socket.write(encode({ type: "kill" }));
      };
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(encode(req));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
      socket.on("error", (err) => settle(() => reject(new Error(`executor unavailable: ${err.message}`))));
      socket.on("close", () => settle(() => (exit ? resolve(exit) : reject(new Error("executor closed the connection before the process exited")))));
      socket.on("data", (chunk: string) => {
        let messages: unknown[];
        try {
          messages = decoder.push(chunk);
        } catch (err) {
          settle(() => reject(err as Error));
          return;
        }
        for (const raw of messages) {
          const m = raw as SpawnEvent | { type: "error"; reason: string } | { type: "end" };
          if (m.type === "out") onEvent(m);
          else if (m.type === "exit") exit = m;
          else if (m.type === "end") settle(() => (exit ? resolve(exit) : reject(new Error("executor ended without an exit status"))));
          else if (m.type === "error") settle(() => reject(new Error(m.reason)));
        }
      });
    });
  }

  /** Drop every open spawn connection; the broker then stops those process groups. */
  closeAll(): number {
    const n = this.open.size;
    for (const s of this.open) s.destroy();
    this.open.clear();
    return n;
  }
}
