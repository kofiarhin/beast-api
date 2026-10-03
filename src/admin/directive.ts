/**
 * Admin requests are explicit ticket directives, never inferred from prose:
 *
 *   Beast admin operation: pm2.restart
 *   Beast admin params: {"app":"ideahub-api"}
 *
 * Exactly one operation line and at most one params line (a single-line JSON object).
 */
const OP_LINE = /^Beast admin operation:/i;
const PARAMS_LINE = /^Beast admin params:/i;
const MAX_PARAMS_JSON = 2048;

/**
 * Linear stores a bare operation id whose suffix is a top-level domain (for example
 * `deploy.run`) as a markdown autolink: `[deploy.run](<http://deploy.run>)`. Only that exact
 * self-link is unwrapped; any other markdown stays as it is and fails validation.
 */
const AUTOLINK = /^\[([^\]\s]+)\]\(<?https?:\/\/([^\s()<>]+?)\/?>?\)$/;

function unwrapAutolink(text: string): string {
  const m = AUTOLINK.exec(text);
  return m && m[1] === m[2] ? m[1]! : text;
}

export type DirectiveParse =
  | { ok: true; request: { op: string; params: Record<string, unknown> } }
  | { ok: false; reason: string };

export function parseAdminDirective(description: string): DirectiveParse {
  const lines = description.split(/\r?\n/).map((l) => l.trim());
  const ops = lines.filter((l) => OP_LINE.test(l));
  const params = lines.filter((l) => PARAMS_LINE.test(l));
  if (ops.length !== 1) return { ok: false, reason: "Provide exactly one `Beast admin operation:` line" };
  if (params.length > 1) return { ok: false, reason: "Provide at most one `Beast admin params:` line" };

  const op = unwrapAutolink(ops[0]!.replace(OP_LINE, "").trim());
  if (!op) return { ok: false, reason: "The `Beast admin operation:` line is empty" };

  let parsed: unknown = {};
  if (params.length) {
    const json = params[0]!.replace(PARAMS_LINE, "").trim();
    if (json.length > MAX_PARAMS_JSON) return { ok: false, reason: "`Beast admin params:` is too long" };
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, reason: "`Beast admin params:` must be a single-line JSON object" };
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "`Beast admin params:` must be a JSON object" };
  }
  return { ok: true, request: { op, params: parsed as Record<string, unknown> } };
}
