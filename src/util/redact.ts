/**
 * Secret redaction for free text that leaves Beast: Linear comments, job records,
 * structured logs and agent transcripts. Two layers:
 *
 * 1. exact values of secret-looking environment variables (whatever their format);
 * 2. well-known credential formats and `SECRET_NAME=value` style assignments.
 */
export const REDACTED = "[REDACTED]";

/** Environment variable names whose values are treated as secrets. */
const SECRET_ENV_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|COOKIE|SESSION|DSN)/i;
/** Shorter values are too likely to collide with ordinary text. */
const MIN_SECRET_LENGTH = 8;

const PATTERNS: [RegExp, string][] = [
  // PEM private keys (whole block).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, REDACTED],
  // Provider tokens.
  [/\blin_(?:api|wh|oauth)_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\b(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, REDACTED],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Authorization headers.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{16,}/g, `$1 ${REDACTED}`],
  // Credentials embedded in URLs: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, `$1:${REDACTED}@`],
  // Env-style assignments: FOO_SECRET=value, "API_KEY": "value", export TOKEN='value'
  [
    /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*)(["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s"',;]{6,}/g,
    `$1$2${REDACTED}`,
  ],
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Values of secret-looking environment variables, longest first. */
export function secretValuesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    const v = value?.trim();
    if (v && v.length >= MIN_SECRET_LENGTH && SECRET_ENV_NAME.test(name)) values.add(v);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Replace secrets in `text` with `[REDACTED]`. */
export function redactSecrets(text: string, secrets: readonly string[] = secretValuesFromEnv()): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Wrap a chunked text sink (e.g. an agent transcript stream) so secrets are
 * redacted before they are written. Output is buffered per line so a secret
 * split across chunks is still caught; PEM private key blocks are suppressed
 * from their BEGIN line to their END line. Call `end()` to flush the remainder.
 */
export function createRedactingWriter(
  write: (text: string) => void,
  secrets: readonly string[] = secretValuesFromEnv(),
): { write(chunk: string): void; end(): void } {
  let pending = "";
  let inPrivateKey = false;

  const emit = (line: string) => {
    if (!inPrivateKey && /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) {
      inPrivateKey = true;
      write(REDACTED + "\n");
    }
    if (inPrivateKey) {
      if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) inPrivateKey = false;
      return;
    }
    write(redactSecrets(line, secrets));
  };

  return {
    write(chunk: string) {
      pending += chunk;
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        emit(pending.slice(0, nl + 1));
        pending = pending.slice(nl + 1);
      }
      // Never hold an unbounded line in memory.
      if (pending.length > 64_000) {
        emit(pending);
        pending = "";
      }
    },
    end() {
      if (pending) emit(pending);
      pending = "";
    },
  };
}
