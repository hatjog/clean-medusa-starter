/**
 * vendor-hmac — Pure HMAC-SHA256 verification for vendor authentication.
 *
 * Header format (x-vendor-signature):
 *   Compact: <seller_id>:<ts>:<nonce>:<base64-hmac-sha256>
 *   Example: seller-uuid-123:1715000000:abc-nonce-uuid:base64sighere==
 *
 * Signed payload: `${seller_id}.${ts}.${nonce}` (dot-joined, UTF-8)
 *
 * Design decisions (v1.6.0, superseded where noted):
 *   - Single shared secret (VENDOR_HMAC_SECRET) — SUPERSEDED by v1.15.0 Story 5.2:
 *     the secret is resolved PER SELLER by `lib/vendor-secret/crypto-core.ts`.
 *   - Nonce dedup via in-process LRU bounded at 10k — SUPERSEDED by v1.15.0
 *     Story 5.3 (FR-11, AD-20, AD-23, ADR-185). `NonceLru`/`getSharedLru` are
 *     GONE, not merely unused: the in-process map could not see a replay aimed
 *     at a second API instance, and its `get` → check → `set` sequence was the
 *     exact shape AD-23 rejects. The barrier now lives in
 *     `lib/vendor-replay-guard/` as ONE atomic statement on a shared table.
 *     Consequently this function NO LONGER performs the replay check — it stays
 *     synchronous and the (already async) callers in `vendor-auth.ts` own the
 *     barrier. See `vendor-auth.ts` for the enforced ordering.
 *
 * Error codes (stable identifiers — referenced by storefront/vendor-panel in v1.7.0):
 *   VENDOR_AUTH_SIGNATURE_MISSING    — x-vendor-signature header absent
 *   VENDOR_AUTH_SIGNATURE_INVALID    — HMAC mismatch or malformed header
 *   VENDOR_AUTH_TIMESTAMP_EXPIRED    — |now - ts| > driftSeconds
 *   VENDOR_AUTH_REPLAY_DETECTED      — duplicate anti-replay key still inside the
 *                                      validity window (raised by vendor-auth.ts
 *                                      via lib/vendor-replay-guard, not here)
 *
 * @module vendor-hmac
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto"

import { VENDOR_AUTH_SECRET_NOT_PROVISIONED } from "./vendor-secret/crypto-core"

// ---------------------------------------------------------------------------
// Error codes (exported constants — DO NOT rename without v1.7.0 migration note)
// ---------------------------------------------------------------------------
export const VENDOR_AUTH_SIGNATURE_MISSING = "VENDOR_AUTH_SIGNATURE_MISSING" as const
export const VENDOR_AUTH_SIGNATURE_INVALID = "VENDOR_AUTH_SIGNATURE_INVALID" as const
export const VENDOR_AUTH_TIMESTAMP_EXPIRED = "VENDOR_AUTH_TIMESTAMP_EXPIRED" as const
export const VENDOR_AUTH_REPLAY_DETECTED = "VENDOR_AUTH_REPLAY_DETECTED" as const

export type VendorAuthErrorCode =
  | typeof VENDOR_AUTH_SIGNATURE_MISSING
  | typeof VENDOR_AUTH_SIGNATURE_INVALID
  | typeof VENDOR_AUTH_TIMESTAMP_EXPIRED
  | typeof VENDOR_AUTH_REPLAY_DETECTED
  // v1.15.0 Story 5.2 (AD-20 / ADR-181): the crypto-core is healthy but the
  // seller named in the header has no per-vendor secret. Server-side (log)
  // discriminator only — the HTTP body stays indistinguishable from a plain
  // signature mismatch (AC5 non-disclosure), see vendor-auth.ts.
  | typeof VENDOR_AUTH_SECRET_NOT_PROVISIONED

export { VENDOR_AUTH_SECRET_NOT_PROVISIONED }

/**
 * Resolves the HMAC secret for the seller named in the signature header.
 * Returns `null` when that seller has no per-vendor secret.
 *
 * AD-20: an implementation MUST NOT fall back to a shared secret. `null` means
 * `401`, never "try the shared value".
 */
export type VendorSecretResolver = (sellerId: string) => Buffer | null

/**
 * Per-process decoy secret used to keep the "seller not provisioned" branch
 * doing the SAME work as the "bad signature" branch (AC2): without it, an
 * unknown seller would answer measurably faster than a wrong signature, which
 * is a seller-enumeration oracle.
 */
const DECOY_SECRET = randomBytes(32)

export type VendorHmacResult =
  // v1.15.0 Story 5.3: `ts` and `nonce` are surfaced ADDITIVELY so the caller
  // can build the anti-replay key without re-parsing the header. This does not
  // touch the frozen 5.2 shape (header layout, field count, `payload`,
  // algorithm, encoding, comparison) — it only stops the barrier from having to
  // parse the header a second time and drift from what was actually verified.
  | { ok: true; sellerId: string; ts: string; nonce: string }
  | { ok: false; code: VendorAuthErrorCode }

// ---------------------------------------------------------------------------
// (v1.15.0 Story 5.3) `NonceLru` and `getSharedLru` were DELETED here.
//
// They are not left as a dead export on purpose: "the mechanism exists but is
// never called" is precisely the end state AC1 forbids, because the next reader
// cannot tell a retired barrier from a live one. The replacement is
// `lib/vendor-replay-guard/` — one atomic statement against a shared table.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------
type ParsedSignatureHeader = {
  sellerId: string
  ts: string
  nonce: string
  sig: string
}

/**
 * Parses the x-vendor-signature header.
 *
 * Accepted format (compact): `<seller_id>:<ts>:<nonce>:<base64-sig>`
 * Field count: exactly 4 parts (seller_id may not contain `:`)
 */
export function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  // Split into exactly 4 parts (seller_id, ts, nonce, sig)
  const firstColon = header.indexOf(":")
  if (firstColon === -1) return null
  const sellerId = header.slice(0, firstColon)
  const rest1 = header.slice(firstColon + 1)

  const secondColon = rest1.indexOf(":")
  if (secondColon === -1) return null
  const ts = rest1.slice(0, secondColon)
  const rest2 = rest1.slice(secondColon + 1)

  const thirdColon = rest2.indexOf(":")
  if (thirdColon === -1) return null
  const nonce = rest2.slice(0, thirdColon)
  const sig = rest2.slice(thirdColon + 1)

  if (!sellerId || !ts || !nonce || !sig) return null

  return { sellerId, ts, nonce, sig }
}

// ---------------------------------------------------------------------------
// Core verifier
// ---------------------------------------------------------------------------

/**
 * Verifies a vendor HMAC signature.
 *
 * The signature SHAPE is frozen (v1.15.0 Story 5.2 / AC2): header format, field
 * count, `payload` construction, algorithm, base64 encoding and the constant-time
 * comparison are unchanged. The only thing Story 5.2 changed is WHERE the secret
 * comes from — hence `secretSource` accepts either a Buffer (legacy/self-contained
 * callers and the shape regression suite) or a per-seller resolver.
 *
 * Step order is also frozen: parse → timestamp → **secret resolution** → HMAC
 * reconstruction. Resolution deliberately sits AFTER the timestamp check
 * and BEFORE the HMAC so an unknown seller is not distinguishable by ordering.
 *
 * v1.15.0 Story 5.3: the replay step is NO LONGER part of this function. The
 * shared barrier is asynchronous by nature, and this function is deliberately
 * kept synchronous so the frozen 5.2 shape suite keeps exercising it directly.
 * The barrier therefore runs in `vendor-auth.ts`, STRICTLY AFTER a `ok: true`
 * result from here — the "replay only after a verified signature" ordering that
 * prevents an unauthenticated sender from poisoning the table is preserved by
 * that call order, and is covered by a test asserting a bad signature writes
 * no row.
 *
 * @param headerValue  Raw value of the `x-vendor-signature` header (or undefined).
 * @param secretSource HMAC secret (Buffer) or a per-seller {@link VendorSecretResolver}.
 * @param nowSec       Current unix time in seconds (injectable for tests).
 * @param driftSeconds Max allowed timestamp drift.
 * @returns VendorHmacResult — ok:true with sellerId on success, ok:false with error code.
 */
export function verifyVendorSignature(
  headerValue: string | undefined,
  secretSource: Buffer | VendorSecretResolver,
  nowSec: number,
  driftSeconds: number
): VendorHmacResult {
  if (!headerValue) {
    return { ok: false, code: VENDOR_AUTH_SIGNATURE_MISSING }
  }

  const parsed = parseSignatureHeader(headerValue)
  if (!parsed) {
    return { ok: false, code: VENDOR_AUTH_SIGNATURE_INVALID }
  }

  const { sellerId, ts, nonce, sig } = parsed

  // --- Timestamp check ---
  const tsNum = parseInt(ts, 10)
  if (isNaN(tsNum) || Math.abs(nowSec - tsNum) > driftSeconds) {
    return { ok: false, code: VENDOR_AUTH_TIMESTAMP_EXPIRED }
  }

  // --- Per-seller secret resolution (v1.15.0 Story 5.2, AD-20/ADR-181) ---
  // AFTER the timestamp check, BEFORE the HMAC. A `null` resolution is NEVER a
  // reason to reach for a shared secret; there is no such branch here.
  let secret: Buffer
  let notProvisioned = false
  if (Buffer.isBuffer(secretSource)) {
    secret = secretSource
  } else {
    const resolved = secretSource(sellerId)
    if (resolved === null) {
      // Do NOT return yet: run the full HMAC + comparison against a decoy so
      // "unknown seller" costs the same as "wrong signature" (AC2 — no
      // enumeration oracle). The verdict is decided after the comparison.
      notProvisioned = true
      secret = DECOY_SECRET
    } else {
      secret = resolved
    }
  }

  // --- HMAC recomputation (timing-safe) ---
  const payload = `${sellerId}.${ts}.${nonce}`
  let expectedSig: Buffer
  try {
    expectedSig = Buffer.from(
      createHmac("sha256", secret).update(payload, "utf8").digest("base64")
    )
  } catch {
    return { ok: false, code: VENDOR_AUTH_SIGNATURE_INVALID }
  }

  let providedSig: Buffer
  try {
    providedSig = Buffer.from(sig)
  } catch {
    return { ok: false, code: VENDOR_AUTH_SIGNATURE_INVALID }
  }

  const sigMatches =
    expectedSig.length === providedSig.length &&
    timingSafeEqual(expectedSig, providedSig)

  // The decoy comparison above is discarded here: a non-provisioned seller can
  // never produce a match, and the outcome must not depend on it.
  if (notProvisioned) {
    return { ok: false, code: VENDOR_AUTH_SECRET_NOT_PROVISIONED }
  }

  if (!sigMatches) {
    return { ok: false, code: VENDOR_AUTH_SIGNATURE_INVALID }
  }

  // The replay barrier used to sit HERE. It now runs in `vendor-auth.ts`, on
  // this exact result — still after signature verification, for the same reason
  // the comment gave in v1.6.0: an earlier check would be a timing oracle and
  // would let an unauthenticated sender write rows.
  return { ok: true, sellerId, ts, nonce }
}

/**
 * Builds a signed x-vendor-signature header value for a given seller.
 *
 * Utility for tests and internal service-to-service calls.
 * NEVER log the secret or the returned signature.
 */
export function buildVendorSignatureHeader(
  sellerId: string,
  secret: Buffer | string,
  tsOverrideSec?: number,
  nonceOverride?: string
): string {
  const secretBuf = typeof secret === "string" ? Buffer.from(secret, "utf8") : secret
  const ts = String(tsOverrideSec ?? Math.floor(Date.now() / 1000))
  const nonce = nonceOverride ?? crypto.randomUUID()
  const payload = `${sellerId}.${ts}.${nonce}`
  const sig = createHmac("sha256", secretBuf).update(payload, "utf8").digest("base64")
  return `${sellerId}:${ts}:${nonce}:${sig}`
}
