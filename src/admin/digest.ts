import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted at every level. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Everything a class C approval binds. Changing any field produces a different digest. */
export interface PlanBinding {
  op: string;
  opVersion: number;
  params: Readonly<Record<string, unknown>>;
  facts: Readonly<Record<string, string>>;
  riskClass: string;
  protected: boolean;
  issueId: string;
  descriptionHash: string;
  requesterId: string;
  nonce: string;
  expiresAt: string;
}

export function planDigest(binding: PlanBinding): string {
  return sha256(canonicalJSON({ v: 1, ...binding }));
}
