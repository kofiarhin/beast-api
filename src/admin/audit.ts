import fs from "node:fs";
import path from "node:path";
import { redact } from "../logger.js";
import { redactSecrets } from "../util/redact.js";
import { canonicalJSON, sha256 } from "./digest.js";

/**
 * Append-only, hash-chained audit log of every admin decision. Each line carries the
 * previous line's hash, so edits or deletions are detectable. Data is redacted before
 * it is written. If the log cannot be written (or is already broken), callers must not
 * execute: auditing failures fail closed.
 */
export interface AuditEntry {
  seq: number;
  time: string;
  event: string;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function entryHash(e: Omit<AuditEntry, "hash">): string {
  return sha256(canonicalJSON({ seq: e.seq, time: e.time, event: e.event, data: e.data, prevHash: e.prevHash }));
}

export type ChainCheck = { ok: true; entries: number; lastHash: string } | { ok: false; line: number; reason: string };

export function verifyAuditChain(file: string): ChainCheck {
  if (!fs.existsSync(file)) return { ok: true, entries: 0, lastHash: GENESIS };
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  let prev = GENESIS;
  for (const [i, line] of lines.entries()) {
    let e: AuditEntry;
    try {
      e = JSON.parse(line) as AuditEntry;
    } catch {
      return { ok: false, line: i + 1, reason: "unparseable entry" };
    }
    if (e.seq !== i + 1) return { ok: false, line: i + 1, reason: "sequence gap" };
    if (e.prevHash !== prev) return { ok: false, line: i + 1, reason: "previous-hash mismatch" };
    if (entryHash(e) !== e.hash) return { ok: false, line: i + 1, reason: "entry hash mismatch" };
    prev = e.hash;
  }
  return { ok: true, entries: lines.length, lastHash: prev };
}

function scrub(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return redact(value as Record<string, unknown>);
  return value;
}

export class AuditLog {
  private seq = 0;
  private lastHash = GENESIS;
  /** Set when the existing chain failed verification; every append then throws. */
  readonly broken: string | undefined;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const check = verifyAuditChain(file);
    if (check.ok) {
      this.seq = check.entries;
      this.lastHash = check.lastHash;
    } else {
      this.broken = `audit log ${file} failed verification at line ${check.line}: ${check.reason}`;
    }
  }

  /** Append one entry. Throws if the entry cannot be durably written. */
  append(event: string, data: Record<string, unknown>): AuditEntry {
    if (this.broken) throw new Error(this.broken);
    const body = {
      seq: this.seq + 1,
      time: new Date().toISOString(),
      event,
      data: scrub(data) as Record<string, unknown>,
      prevHash: this.lastHash,
    };
    const entry: AuditEntry = { ...body, hash: entryHash(body) };
    const fd = fs.openSync(this.file, "a", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(entry) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.seq = entry.seq;
    this.lastHash = entry.hash;
    return entry;
  }
}
