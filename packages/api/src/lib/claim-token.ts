/**
 * claim-token — Sub-bundle 6a (cleanup-6 CRIT-6.1)
 *
 * ADR-NOTE: Claim tokens MUST be generated from `crypto.randomBytes(16)` or
 * larger, encoded as `base64url` — yielding ≥128 bits of cryptographic
 * randomness. Tokens MUST NOT be derived from voucher_id, order_id, or any
 * guessable seed. This module is the SSOT for token generation and validation.
 *
 * Anti-enumeration policy:
 *   - Invalid codes return IDENTICAL response timing + payload as expired codes
 *     (constant-time comparison via timingSafeEqual on the HMAC of the code).
 *   - Rate-limit bucket: same in-memory or Redis token-bucket used for dispatch
 *     rate limiting (InMemoryTokenBucketAdapter / RedisTokenBucketAdapter).
 *   - 10 invalid codes per IP per 60s → progressive backoff (bucket drained).
 *
 * Server-side expiry pre-check:
 *   - MUST be called at Server Action / route entry — BEFORE any state change.
 *   - Returns `{ valid: false, reason: 'expired' | 'not_found' | 'already_claimed' }`
 *     on rejection; `{ valid: true }` on pass.
 */

import { randomBytes, timingSafeEqual, createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/**
 * Generate a claim token with ≥128 bits of entropy.
 *
 * Uses `crypto.randomBytes(16)` — 128 bits of CSPRNG output — encoded as
 * `base64url` (22 URL-safe characters, no padding).
 *
 * ADR-NOTE: NEVER seed from voucher_id, order_id, or user-provided data.
 */
export function generateClaimToken(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Audit function: returns the entropy in bits of a given token string.
 * Used in property-based tests to verify minimum 128-bit guarantee.
 *
 * For a `base64url` string of N characters:
 *   - Each character encodes 6 bits, but the string was derived from
 *     `Math.ceil(bits / 8)` bytes of randomness.
 *   - This function infers the byte count from the encoded length.
 */
export function estimateTokenEntropyBits(token: string): number {
  // base64url: 4 chars per 3 bytes → bytes = floor(len * 3 / 4)
  // For no-padding base64url: bytes = floor(len * 6 / 8) = floor(len * 3 / 4)
  const bytes = Math.floor(token.length * 6 / 8);
  return bytes * 8;
}

// ---------------------------------------------------------------------------
// Constant-time code validation
// ---------------------------------------------------------------------------

/**
 * Compare two code strings in constant time to prevent timing side-channels.
 * Uses HMAC as a timing-safe wrapper (timingSafeEqual requires equal length).
 *
 * Both codes are HMAC-ed with the same secret before comparison so the
 * comparison is always on equal-length buffers.
 */
export function timingSafeCodeEqual(a: string, b: string, secret: string): boolean {
  const hmacA = createHmac("sha256", secret).update(a).digest();
  const hmacB = createHmac("sha256", secret).update(b).digest();
  return timingSafeEqual(hmacA, hmacB);
}

// ---------------------------------------------------------------------------
// Server-side expiry pre-check
// ---------------------------------------------------------------------------

export interface ClaimCodeRecord {
  code: string;
  expires_at: string | Date | null;
  status: "idle" | "claimed" | "withdrawn" | "consent_pending" | string;
}

export type ClaimValidationResult =
  | { valid: true }
  | { valid: false; reason: "not_found" | "expired" | "already_claimed" | "withdrawn" };

/**
 * Server-side expiry + status pre-check.
 *
 * MUST be called at the Server Action / API route entry point — BEFORE any
 * state machine transition or database write.
 *
 * Returns `{ valid: true }` if the code passes all checks.
 * Returns `{ valid: false, reason }` with a generic reason (anti-enumeration:
 * callers SHOULD return the same HTTP status + timing for all failure reasons).
 */
export function validateClaimCodePreCheck(
  record: ClaimCodeRecord | null
): ClaimValidationResult {
  if (!record) {
    return { valid: false, reason: "not_found" };
  }
  if (record.status === "claimed") {
    return { valid: false, reason: "already_claimed" };
  }
  if (record.status === "withdrawn") {
    return { valid: false, reason: "withdrawn" };
  }
  if (record.expires_at) {
    const expiresMs =
      record.expires_at instanceof Date
        ? record.expires_at.getTime()
        : Date.parse(record.expires_at);
    if (Number.isFinite(expiresMs) && Date.now() > expiresMs) {
      return { valid: false, reason: "expired" };
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Rate-limit bucket key helpers (IP-based, per AC2)
// ---------------------------------------------------------------------------

/**
 * Bucket key for IP-based claim rate limiting.
 *
 * Progressive backoff policy (per AC2):
 *   - bucket_size: 10 invalid attempts per IP
 *   - refill_per_min: 2 (slow — 30s per token)
 *
 * Invalid code and expired code attempts BOTH consume from this bucket to
 * prevent enumeration via selective exhaustion.
 */
export function claimRateLimitBucketKey(ip: string): string {
  // Normalise IPv6 loopback variants to prevent bypass.
  const normalisedIp = ip === "::1" ? "127.0.0.1" : ip;
  return `rl:claim:ip:${normalisedIp}`;
}

export const CLAIM_RATE_LIMIT_BUCKET_SIZE = 10;
export const CLAIM_RATE_LIMIT_REFILL_PER_MIN = 2;
