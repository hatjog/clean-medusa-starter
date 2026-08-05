/**
 * Story v160-cleanup-48 — Unit tests for vendor-hmac pure verifier.
 *
 * Covers:
 *   - verifyVendorSignature: valid sig, invalid sig, expired ts, missing header, replay
 *   - (replay + NonceLru moved out in v1.15.0 Story 5.3 — see note below)
 *   - buildVendorSignatureHeader: round-trip with verifyVendorSignature
 *   - Header parser: malformed inputs
 */
import { describe, it, expect } from "@jest/globals"
import { createHmac } from "crypto"

import {
  verifyVendorSignature,
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
    const header = buildHeader()
    const result = verifyVendorSignature(header, TEST_SECRET, nowSec(), DRIFT)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sellerId).toBe(SELLER)
    }
  })

  it("accepts a header with timestamp at drift boundary (exactly drift-1)", () => {
    const ts = nowSec() - (DRIFT - 1)
    const header = buildHeader(SELLER, ts)
    const result = verifyVendorSignature(header, TEST_SECRET, nowSec(), DRIFT)

    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// verifyVendorSignature — missing header
// ---------------------------------------------------------------------------

describe("verifyVendorSignature — missing header", () => {
  it("returns VENDOR_AUTH_SIGNATURE_MISSING when header is undefined", () => {
    const result = verifyVendorSignature(undefined, TEST_SECRET, nowSec(), DRIFT)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(VENDOR_AUTH_SIGNATURE_MISSING)
    }
  })

  it("returns VENDOR_AUTH_SIGNATURE_MISSING when header is empty string", () => {
    const result = verifyVendorSignature("", TEST_SECRET, nowSec(), DRIFT)

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
    const wrongSecret = Buffer.from("wrong-secret", "utf8")
    const header = buildHeader(SELLER, undefined, undefined, wrongSecret)
    const result = verifyVendorSignature(header, TEST_SECRET, nowSec(), DRIFT)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(VENDOR_AUTH_SIGNATURE_INVALID)
    }
  })

  it("returns VENDOR_AUTH_SIGNATURE_INVALID on malformed header (no colons)", () => {
    const result = verifyVendorSignature("notavalidheader", TEST_SECRET, nowSec(), DRIFT)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(VENDOR_AUTH_SIGNATURE_INVALID)
    }
  })

  it("returns VENDOR_AUTH_SIGNATURE_INVALID when sig field is tampered", () => {
    const ts = String(nowSec())
    const nonce = "test-nonce-unique"
    const payload = `${SELLER}.${ts}.${nonce}`
    const validSig = createHmac("sha256", TEST_SECRET).update(payload).digest("base64")
    // Flip one char in the signature
    const tamperedSig = validSig.slice(0, -1) + (validSig.slice(-1) === "A" ? "B" : "A")
    const header = `${SELLER}:${ts}:${nonce}:${tamperedSig}`
    const result = verifyVendorSignature(header, TEST_SECRET, nowSec(), DRIFT)

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
    const ts = nowSec() - (DRIFT + 1)
    const header = buildHeader(SELLER, ts)
    const result = verifyVendorSignature(header, TEST_SECRET, nowSec(), DRIFT)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(VENDOR_AUTH_TIMESTAMP_EXPIRED)
    }
  })

  it("returns VENDOR_AUTH_TIMESTAMP_EXPIRED for a future timestamp beyond drift", () => {
    const ts = nowSec() + DRIFT + 60
    const header = buildHeader(SELLER, ts)
    const result = verifyVendorSignature(header, TEST_SECRET, nowSec(), DRIFT)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(VENDOR_AUTH_TIMESTAMP_EXPIRED)
    }
  })

  it("returns VENDOR_AUTH_TIMESTAMP_EXPIRED for non-numeric ts field", () => {
    const nonce = "test-nonce"
    const badTs = "notanumber"
    const payload = `${SELLER}.${badTs}.${nonce}`
    const sig = createHmac("sha256", TEST_SECRET).update(payload).digest("base64")
    const header = `${SELLER}:${badTs}:${nonce}:${sig}`
    const result = verifyVendorSignature(header, TEST_SECRET, nowSec(), DRIFT)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(VENDOR_AUTH_TIMESTAMP_EXPIRED)
    }
  })
})

// ---------------------------------------------------------------------------
// verifyVendorSignature — replay detection MOVED OUT (v1.15.0 Story 5.3)
// ---------------------------------------------------------------------------
//
// Do v1.14.0 stały tutaj dwa testy replay oraz cały `describe("NonceLru")`.
// Zostały USUNIĘTE, nie przepisane, bo mierzony przedmiot przestał istnieć:
// `verifyVendorSignature` nie wykonuje już kroku replay, a `NonceLru` nie ma
// w kodzie (AD-23 — mapa w pamięci procesu nie widzi drugiej instancji, a jej
// `get` → warunek → `set` to sekwencja, nie operacja atomowa).
//
// Ochrona przed powtórzeniem jest teraz mierzona TAM, GDZIE DZIAŁA:
//   - `__tests__/lib/vendor-replay-guard.unit.spec.ts` — jedna wysyłka do bazy,
//     okno w predykacie, kształt i niezależność klucza od sekretu,
//   - `__tests__/api/vendor-auth-replay-cross-instance.unit.spec.ts` — kontrola
//     dodatnia i negatywna CROSS-INSTANCE na realnej trasie, przez oba wejścia.
//
// Ta suita pozostaje suitą KSZTAŁTU podpisu (5.2 AC2) i jej asercje kształtu są
// nietknięte — zniknął wyłącznie argument `lru`, którego funkcja już nie bierze.

// ---------------------------------------------------------------------------
// buildVendorSignatureHeader — round-trip
// ---------------------------------------------------------------------------

describe("buildVendorSignatureHeader", () => {
  it("produces a header that verifyVendorSignature accepts", () => {
    const header = buildVendorSignatureHeader(SELLER, TEST_SECRET)
    const result = verifyVendorSignature(header, TEST_SECRET, nowSec(), DRIFT)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sellerId).toBe(SELLER)
    }
  })
})
