/**
 * claim-idempotency-binding — Story v160-cleanup-15c.
 *
 * HMAC-SHA256 binding of idempotency key to the tuple
 * (code, recipient_session, claimed_at).
 *
 * Protocol:
 *   1. Client generates `idempotency_key` (UUID) before first POST.
 *   2. Client sends `{ code, recipient_session, claimed_at, idempotency_key }`.
 *   3. Server computes expected binding = HMAC(secret, code|session|claimed_at)
 *      and compares in constant time against `idempotency_key` (which doubles
 *      as the binding token in this v1.6.0 design).
 *
 * Security invariants:
 *   - Comparison is constant-time via `crypto.timingSafeEqual`.
 *   - If JWT_SECRET is absent the function throws (fail-closed policy).
 *   - Separator `|` is forbidden in code / session values for collision
 *     resistance. Callers must validate this before invoking.
 */

import { createHmac, timingSafeEqual } from "node:crypto"

function getSecret(): Buffer {
  const s = process.env.JWT_SECRET ?? ""
  if (!s) {
    throw new Error(
      "claim-idempotency-binding: JWT_SECRET env var is required but not set"
    )
  }
  return Buffer.from(s, "utf8")
}

/**
 * Compute HMAC-SHA256 binding for the given tuple.
 * Returns a hex digest string.
 */
export function computeBinding(
  code: string,
  recipientSession: string,
  claimedAt: string
): string {
  // Separator validation — prevent injection via embedded `|`
  if (code.includes("|") || recipientSession.includes("|")) {
    throw new Error(
      "claim-idempotency-binding: code or recipientSession contains reserved separator '|'"
    )
  }
  const payload = `${code}|${recipientSession}|${claimedAt}`
  return createHmac("sha256", getSecret()).update(payload, "utf8").digest("hex")
}

/**
 * Constant-time comparison of two hex-digest binding strings.
 * Returns true if they match; false otherwise.
 *
 * Uses crypto.timingSafeEqual to prevent timing side-channel attacks.
 */
export function verifyBinding(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a.padEnd(64, "0"), "hex")
    const bufB = Buffer.from(b.padEnd(64, "0"), "hex")
    if (bufA.length !== bufB.length) return false
    return timingSafeEqual(bufA, bufB)
  } catch {
    return false
  }
}
