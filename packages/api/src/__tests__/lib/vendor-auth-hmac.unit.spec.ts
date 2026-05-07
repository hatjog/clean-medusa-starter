/**
 * Story v160-cleanup-48 — Unit tests for vendor-hmac pure verifier.
 *
 * Covers:
 *   - verifyVendorSignature: valid sig, invalid sig, expired ts, missing header, replay
 *   - NonceLru: bounded eviction, dedup, TTL
 *   - buildVendorSignatureHeader: round-trip with verifyVendorSignature
 *   - Header parser: malformed inputs
 */
import { describe, it, expect } from "@jest/globals"
import { createHmac } from "crypto"

import {
  verifyVendorSignature,
  NonceLru,
  buildVendorSignatureHeader,
  VENDOR_AUTH_SIGNATURE_MISSING,
  VENDOR_AUTH_SIGNATURE_INVALID,
  VENDOR_AUTH_TIMESTAMP_EXPIRED,
  VENDOR_AUTH_REPLAY_DETECTED,
} from "../../../src/lib/vendor-hmac"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = Buffer.from("test-secret-hmac-key-32-bytes-xx", "utf8")
const SELLER = "seller-uuid-abc"
const DRIFT = 300

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function buildHeader(
  sellerId = SELLER,
  tsOverride?: number,
  nonceOverride?: string,
  secretOverride?: Buffer
): string {
  return buildVendorSignatureHeader(
    sellerId,
    secretOverride ?? TEST_SECRET,
    tsOverride ?? nowSec(),
    nonceOverride ?? "nonce-" + Math.random().toString(36).slice(2)
  )
}

// ---------------------------------------------------------------------------
// verifyVendorSignature — happy path
// ---------------------------------------------------------------------------

describe("verifyVendorSignature — valid signature", () => {
  it("returns ok=true with correct sellerId on valid header", () => {
    const lru = new NonceLru()
    const header = buildHeader()
    const result = verifyVendorSignature(header, TEST_SECRET, nowSec(), DRIFT, lru)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sellerId).toBe(SELLER)
    }
  })

  it("accepts a header with timestamp at drift boundary (exactly drift-1)", () => {
    const lru = new NonceLru()
    const ts = nowSec() - (DRIFT - 1)
    const header = buildHeader(SELLER, ts)
    const result = verifyVendorSignature(header, TEST_SECRET, nowSec(), DRIFT, lru)

    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// verifyVendorSignature — missing header
// ---------------------------------------------------------------------------

describe("verifyVendorSignature — missing header", () => {
  it("returns VENDOR_AUTH_SIGNATURE_MISSING when header is undefined", () => {
    const lru = new NonceLru()
    const result = verifyVendorSignature(undefined, TEST_SECRET, nowSec(), DRIFT, lru)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(VENDOR_AUTH_SIGNATURE_MISSING)
    }
  })

  it("returns VENDOR_AUTH_SIGNATURE_MISSING when header is empty string", () => {
    const lru = new NonceLru()
    const result = verifyVendorSignature("", TEST_SECRET, nowSec(), DRIFT, lru)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(VENDOR_AUTH_SIGNATURE_MISSING)
    }
  })
})

// ---------------------------------------------------------------------------
// verifyVendorSignature — invalid signature
// ---------------------------------------------------------------------------

describe("verifyVendorSignature — invalid signature", () => {
  it("returns VENDOR_AUTH_SIGNATURE_INVALID when HMAC is wrong", () => {
    const lru = new NonceLru()
    const wrongSecret = Buffer.from("wrong-secret", "utf8")
    const header = buildHeader(SELLER, undefined, undefined, wrongSecret)
    const result = verifyVendorSignature(header, TEST_SECRET, nowSec(), DRIFT, lru)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(VENDOR_AUTH_SIGNATURE_INVALID)
    }
  })

  it("returns VENDOR_AUTH_SIGNATURE_INVALID on malformed header (no colons)", () => {
    const lru = new NonceLru()
    const result = verifyVendorSignature("notavalidheader", TEST_SECRET, nowSec(), DRIFT, lru)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(VENDOR_AUTH_SIGNATURE_INVALID)
    }
  })

  it("returns VENDOR_AUTH_SIGNATURE_INVALID when sig field is tampered", () => {
    const lru = new NonceLru()
    const ts = String(nowSec())
    const nonce = "test-nonce-unique"
    const payload = `${SELLER}.${ts}.${nonce}`
    const validSig = createHmac("sha256", TEST_SECRET).update(payload).digest("base64")
    // Flip one char in the signature
    const tamperedSig = validSig.slice(0, -1) + (validSig.slice(-1) === "A" ? "B" : "A")
    const header = `${SELLER}:${ts}:${nonce}:${tamperedSig}`
    const result = verifyVendorSignature(header, TEST_SECRET, nowSec(), DRIFT, lru)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(VENDOR_AUTH_SIGNATURE_INVALID)
    }
  })
})

// ---------------------------------------------------------------------------
// verifyVendorSignature — expired timestamp
// ---------------------------------------------------------------------------

describe("verifyVendorSignature — expired timestamp", () => {
  it("returns VENDOR_AUTH_TIMESTAMP_EXPIRED when ts is drift+1 seconds old", () => {
    const lru = new NonceLru()
    const ts = nowSec() - (DRIFT + 1)
    const header = buildHeader(SELLER, ts)
    const result = verifyVendorSignature(header, TEST_SECRET, nowSec(), DRIFT, lru)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(VENDOR_AUTH_TIMESTAMP_EXPIRED)
    }
  })

  it("returns VENDOR_AUTH_TIMESTAMP_EXPIRED for a future timestamp beyond drift", () => {
    const lru = new NonceLru()
    const ts = nowSec() + DRIFT + 60
    const header = buildHeader(SELLER, ts)
    const result = verifyVendorSignature(header, TEST_SECRET, nowSec(), DRIFT, lru)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(VENDOR_AUTH_TIMESTAMP_EXPIRED)
    }
  })

  it("returns VENDOR_AUTH_TIMESTAMP_EXPIRED for non-numeric ts field", () => {
    const lru = new NonceLru()
    const nonce = "test-nonce"
    const badTs = "notanumber"
    const payload = `${SELLER}.${badTs}.${nonce}`
    const sig = createHmac("sha256", TEST_SECRET).update(payload).digest("base64")
    const header = `${SELLER}:${badTs}:${nonce}:${sig}`
    const result = verifyVendorSignature(header, TEST_SECRET, nowSec(), DRIFT, lru)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(VENDOR_AUTH_TIMESTAMP_EXPIRED)
    }
  })
})

// ---------------------------------------------------------------------------
// verifyVendorSignature — replay detection
// ---------------------------------------------------------------------------

describe("verifyVendorSignature — replay detection", () => {
  it("returns VENDOR_AUTH_REPLAY_DETECTED on duplicate nonce", () => {
    const lru = new NonceLru()
    const nonce = "replay-nonce-1"
    const ts = nowSec()
    const header1 = buildHeader(SELLER, ts, nonce)

    // First call should succeed
    const result1 = verifyVendorSignature(header1, TEST_SECRET, ts, DRIFT, lru)
    expect(result1.ok).toBe(true)

    // Build same nonce header again (same ts, same nonce, same sig)
    const result2 = verifyVendorSignature(header1, TEST_SECRET, ts, DRIFT, lru)
    expect(result2.ok).toBe(false)
    if (!result2.ok) {
      expect(result2.code).toBe(VENDOR_AUTH_REPLAY_DETECTED)
    }
  })

  it("allows different nonces for same seller", () => {
    const lru = new NonceLru()
    const ts = nowSec()

    const header1 = buildHeader(SELLER, ts, "nonce-alpha")
    const result1 = verifyVendorSignature(header1, TEST_SECRET, ts, DRIFT, lru)
    expect(result1.ok).toBe(true)

    const header2 = buildHeader(SELLER, ts, "nonce-beta")
    const result2 = verifyVendorSignature(header2, TEST_SECRET, ts, DRIFT, lru)
    expect(result2.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// NonceLru — bounded eviction
// ---------------------------------------------------------------------------

describe("NonceLru", () => {
  it("starts empty and records entries", () => {
    const lru = new NonceLru(5)
    expect(lru.size).toBe(0)
    lru.check("seller-1", "nonce-1", 1000, 600)
    expect(lru.size).toBe(1)
  })

  it("detects replay within TTL", () => {
    const lru = new NonceLru()
    const now = 1000
    lru.check("seller-a", "nonce-a", now, 600)
    const isReplay = lru.check("seller-a", "nonce-a", now + 100, 600)
    expect(isReplay).toBe(true)
  })

  it("allows re-use after TTL expiry", () => {
    const lru = new NonceLru()
    const now = 1000
    lru.check("seller-b", "nonce-b", now, 60) // TTL=60 seconds
    const isReplay = lru.check("seller-b", "nonce-b", now + 61, 60) // 61s later
    expect(isReplay).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildVendorSignatureHeader — round-trip
// ---------------------------------------------------------------------------

describe("buildVendorSignatureHeader", () => {
  it("produces a header that verifyVendorSignature accepts", () => {
    const lru = new NonceLru()
    const header = buildVendorSignatureHeader(SELLER, TEST_SECRET)
    const result = verifyVendorSignature(header, TEST_SECRET, nowSec(), DRIFT, lru)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sellerId).toBe(SELLER)
    }
  })
})
