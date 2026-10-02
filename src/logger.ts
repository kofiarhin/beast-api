/**
 * Minimal structured JSON logger.
 *
 * Any field whose key looks sensitive is redacted, so accidental
 * `logger.info("x", { apiKey })` calls cannot leak secrets. String values and
 * messages are also scrubbed of secret values and known credential formats.
 */
import { redactSecrets } from "./util/redact.js";

export type LogFields = Record<string, unknown>;
type Level = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const SENSITIVE_KEY = /(key|secret|token|authorization|password|cookie|signature|credential|env)/i;

export function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "string") {
      out[k] = redactSecrets(v);
    } else if (v instanceof Error) {
      out[k] = redactSecrets(v.message);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) => (typeof item === "string" ? redactSecrets(item) : item));
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redact(v as LogFields);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createLogger(
  base: LogFields = {},
  sink: (line: string) => void = (line) => process.stdout.write(line + "\n"),
): Logger {
  const write = (level: Level, msg: string, fields: LogFields = {}) => {
    sink(JSON.stringify({ time: new Date().toISOString(), level, msg: redactSecrets(msg), ...redact({ ...base, ...fields }) }));
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) => createLogger({ ...base, ...fields }, sink),
  };
}

export const silentLogger: Logger = createLogger({}, () => {});
