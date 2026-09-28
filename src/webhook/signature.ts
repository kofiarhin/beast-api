import { createHmac, timingSafeEqual } from "node:crypto";

/** Linear signs the raw request body with HMAC-SHA256 (hex) in the `Linear-Signature` header. */
export function computeSignature(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(computeSignature(rawBody, secret), "hex");
  const received = Buffer.from(signature, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Replay protection: `webhookTimestamp` (ms) must be close to now. */
export function isFreshTimestamp(timestamp: unknown, toleranceMs: number, now = Date.now()): boolean {
  return typeof timestamp === "number" && Number.isFinite(timestamp) && Math.abs(now - timestamp) <= toleranceMs;
}
