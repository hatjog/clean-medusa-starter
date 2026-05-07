/**
 * vendor-hmac — Pure HMAC-SHA256 verification for vendor authentication.
 *
 * Header format (x-vendor-signature):
 *   Compact: <seller_id>:<ts>:<nonce>:<base64-hmac-sha256>
 *   Example: seller-uuid-123:1715000000:abc-nonce-uuid:base64sighere==
 *
 * Signed payload: `${seller_id}.${ts}.${nonce}` (dot-joined, UTF-8)
 *
 * Design decisions (v1.6.0):
 *   - Single shared secret (VENDOR_HMAC_SECRET) — simplest viable for single-instance topology.
 *   - v1.7.0 follow-up: per-vendor secret store (ADR to be filed).
 *   - Nonce dedup via in-process LRU bounded at 10k — sufficient for v1.6.0 single-API-instance.
 *   - v1.7.0 follow-up: Redis-backed distributed nonce cache.
 *
 * Error codes (stable identifiers — referenced by storefront/vendor-panel in v1.7.0):
 *   VENDOR_AUTH_SIGNATURE_MISSING    — x-vendor-signature header absent
 *   VENDOR_AUTH_SIGNATURE_INVALID    — HMAC mismatch or malformed header
 *   VENDOR_AUTH_TIMESTAMP_EXPIRED    — |now - ts| > driftSeconds
 *   VENDOR_AUTH_REPLAY_DETECTED      — duplicate (seller_id, nonce) within 2*drift window
 *
 * @module vendor-hmac
 */
import { createHmac, timingSafeEqual } from "crypto"

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

export type VendorHmacResult =
  | { ok: true; sellerId: string }
  | { ok: false; code: VendorAuthErrorCode }

// ---------------------------------------------------------------------------
// Minimal LRU for nonce dedup (no external deps)
// ---------------------------------------------------------------------------
export class NonceLru {
  private readonly maxSize: number
  /** Maps `${sellerId}:${nonce}` → expiry unix-seconds */
  private readonly store = new Map<string, number>()

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize
  }

  /**
   * Returns true if the nonce+sellerId pair is already known (replay detected).
   * Inserts and returns false if new.
   */
  check(sellerId: string, nonce: string, nowSec: number, ttlSec: number): boolean {
    const key = `${sellerId}:${nonce}`
    const expiry = this.store.get(key)

    if (expiry !== undefined && nowSec < expiry) {
      return true // replay
    }

    // Evict expired entries if over capacity (simple scan — acceptable for bounded map)
    if (this.store.size >= this.maxSize) {
      for (const [k, exp] of this.store) {
        if (nowSec >= exp) {
          this.store.delete(k)
        }
        if (this.store.size < this.maxSize) break
      }
    }

    this.store.set(key, nowSec + ttlSec)
    return false
  }

  /** Visible for testing. */
  get size(): number {
    return this.store.size
  }
}

// ---------------------------------------------------------------------------
// Singleton LRU shared across requests
// ---------------------------------------------------------------------------
let _sharedLru: NonceLru | null = null
export function getSharedLru(): NonceLru {
  if (!_sharedLru) {
    _sharedLru = new NonceLru(10_000)
  }
  return _sharedLru
}

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
function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
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
 * @param headerValue  Raw value of the `x-vendor-signature` header (or undefined).
 * @param secret       Shared HMAC secret (Buffer).
 * @param nowSec       Current unix time in seconds (injectable for tests).
 * @param driftSeconds Max allowed timestamp drift.
 * @param lru          Nonce dedup LRU cache.
 * @returns VendorHmacResult — ok:true with sellerId on success, ok:false with error code.
 */
export function verifyVendorSignature(
  headerValue: string | undefined,
  secret: Buffer,
  nowSec: number,
  driftSeconds: number,
  lru: NonceLru
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

  if (
    expectedSig.length !== providedSig.length ||
    !timingSafeEqual(expectedSig, providedSig)
  ) {
    return { ok: false, code: VENDOR_AUTH_SIGNATURE_INVALID }
  }

  // --- Replay check (after signature verification to avoid oracle timing) ---
  const ttlSec = driftSeconds * 2
  if (lru.check(sellerId, nonce, nowSec, ttlSec)) {
    return { ok: false, code: VENDOR_AUTH_REPLAY_DETECTED }
  }

  return { ok: true, sellerId }
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
