/**
 * Story v160-cleanup-48 — Integration tests for withVendorAuth HOF with HMAC.
 *
 * These tests invoke withVendorAuth(handler as any) with a real signed payload,
 * exercising the full middleware chain (signature verify → resolveVendorId → inject).
 *
 * Environment: VENDOR_HMAC_SECRET and VENDOR_HMAC_ENFORCED are controlled via
 * jest beforeEach / afterEach to avoid polluting other test suites.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals"

import { buildVendorSignatureHeader } from "../../../src/lib/vendor-hmac"
import { withVendorAuth, type VendorAuthContext } from "../../../src/lib/vendor-auth"
import { NotImplementedError } from "../../../src/modules/gp-core/service"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "integration-test-hmac-secret-abc"
const SELLER_ID = "seller-integration-test-uuid"
const VENDOR_ID = "vendor-resolved-uuid-xyz"

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function makeSignedHeader(
  sellerId = SELLER_ID,
  tsOffset = 0,
  nonce?: string
): string {
  return buildVendorSignatureHeader(
    sellerId,
    TEST_SECRET,
    nowSec() + tsOffset,
    nonce
  )
}

function buildMockScope(opts?: {
  gpCoreResolveFn?: (id: string) => Promise<string>
  gpCoreAvailable?: boolean
}) {
  const resolveFn = opts?.gpCoreResolveFn ?? (() => Promise.resolve(VENDOR_ID))
  const gpCoreAvailable = opts?.gpCoreAvailable ?? true

  return {
    resolve: jest.fn((key: string) => {
      if (key === "logger") {
        return {
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
        }
      }
      if (key === "gp_core" && gpCoreAvailable) {
        return {
          resolveVendorId: jest.fn<(id: string) => Promise<string>>().mockImplementation(resolveFn),
        }
      }
      return null
    }),
  }
}

function buildMockReq(
  headers: Record<string, string | undefined> = {},
  scopeOpts?: Parameters<typeof buildMockScope>[0]
) {
  return {
    headers,
    scope: buildMockScope(scopeOpts),
  } as any
}

function buildMockRes() {
  const res: any = { statusCode: 200, body: null }
  res.status = jest.fn((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = jest.fn((data: unknown) => {
    res.body = data
    return res
  })
  return res
}

// ---------------------------------------------------------------------------
// Setup / teardown: control env vars
// ---------------------------------------------------------------------------

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv.VENDOR_HMAC_SECRET = process.env.VENDOR_HMAC_SECRET
  savedEnv.VENDOR_HMAC_ENFORCED = process.env.VENDOR_HMAC_ENFORCED
  savedEnv.VENDOR_HMAC_DRIFT_SECONDS = process.env.VENDOR_HMAC_DRIFT_SECONDS

  process.env.VENDOR_HMAC_SECRET = TEST_SECRET
  process.env.VENDOR_HMAC_ENFORCED = "true"
  delete process.env.VENDOR_HMAC_DRIFT_SECONDS
})

afterEach(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = val
    }
  }
  jest.resetModules()
})

// ---------------------------------------------------------------------------
// Case 1: Valid signature → handler invoked, vendorAuth injected
// ---------------------------------------------------------------------------

describe("withVendorAuth HOF — HMAC enforced", () => {
  it("case-1: valid signature → handler invoked, req.vendorAuth populated", async () => {
    let capturedAuth: VendorAuthContext | undefined
    const handler = jest.fn(async (req: any) => {
      capturedAuth = req.vendorAuth
    })

    const wrapped = withVendorAuth(handler as any)
    const req = buildMockReq({ "x-vendor-signature": makeSignedHeader() })
    const res = buildMockRes()

    await wrapped(req, res, jest.fn())

    expect(handler).toHaveBeenCalled()
    expect(capturedAuth).toBeDefined()
    expect(capturedAuth?.seller_id).toBe(SELLER_ID)
    expect(capturedAuth?.vendor_id).toBe(VENDOR_ID)
    expect(res.statusCode).toBe(200)
  })

  // Case 2: Invalid signature → 401 VENDOR_AUTH_SIGNATURE_INVALID
  it("case-2: invalid signature → 401 VENDOR_AUTH_SIGNATURE_INVALID", async () => {
    const handler = jest.fn()
    const wrapped = withVendorAuth(handler as any)

    // Build header with wrong secret
    const wrongHeader = buildVendorSignatureHeader(SELLER_ID, "wrong-secret")
    const req = buildMockReq({ "x-vendor-signature": wrongHeader })
    const res = buildMockRes()

    await wrapped(req, res, jest.fn())

    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ code: "VENDOR_AUTH_SIGNATURE_INVALID" })
    expect(handler).not.toHaveBeenCalled()
  })

  // Case 3: Expired timestamp (drift+1) → 401 VENDOR_AUTH_TIMESTAMP_EXPIRED
  it("case-3: expired timestamp → 401 VENDOR_AUTH_TIMESTAMP_EXPIRED", async () => {
    const handler = jest.fn()
    const wrapped = withVendorAuth(handler as any)

    const expiredHeader = makeSignedHeader(SELLER_ID, -(300 + 1))
    const req = buildMockReq({ "x-vendor-signature": expiredHeader })
    const res = buildMockRes()

    await wrapped(req, res, jest.fn())

    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ code: "VENDOR_AUTH_TIMESTAMP_EXPIRED" })
    expect(handler).not.toHaveBeenCalled()
  })

  // Case 4: Missing signature header → 401 VENDOR_AUTH_SIGNATURE_MISSING
  it("case-4: missing signature header → 401 VENDOR_AUTH_SIGNATURE_MISSING", async () => {
    const handler = jest.fn()
    const wrapped = withVendorAuth(handler as any)

    const req = buildMockReq({}) // no x-vendor-signature
    const res = buildMockRes()

    await wrapped(req, res, jest.fn())

    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ code: "VENDOR_AUTH_SIGNATURE_MISSING" })
    expect(handler).not.toHaveBeenCalled()
  })

  // Case 5: Replay (same nonce twice) → first 200, second 401 VENDOR_AUTH_REPLAY_DETECTED
  it("case-5: replay (same nonce) → first pass, second 401 VENDOR_AUTH_REPLAY_DETECTED", async () => {
    // Use a fresh isolated LRU by constructing a new nonce unique to this test
    const uniqueNonce = "replay-integration-test-" + Date.now()
    const ts = nowSec()
    const header = buildVendorSignatureHeader(SELLER_ID, TEST_SECRET, ts, uniqueNonce)

    const handler = jest.fn()
    const wrapped = withVendorAuth(handler as any)

    // First call
    const req1 = buildMockReq({ "x-vendor-signature": header })
    const res1 = buildMockRes()
    await wrapped(req1, res1, jest.fn())
    expect(res1.statusCode).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)

    // Second call — replay
    handler.mockReset()
    const req2 = buildMockReq({ "x-vendor-signature": header })
    const res2 = buildMockRes()
    await wrapped(req2, res2, jest.fn())
    expect(res2.statusCode).toBe(401)
    expect(res2.body).toMatchObject({ code: "VENDOR_AUTH_REPLAY_DETECTED" })
    expect(handler).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Case 6: Flag off (VENDOR_HMAC_ENFORCED=false) + legacy x-vendor-token → 200 + warn log
// ---------------------------------------------------------------------------

describe("withVendorAuth HOF — legacy transition window", () => {
  it("case-6: flag off + legacy x-vendor-token → 200 + structured warn log", async () => {
    process.env.VENDOR_HMAC_ENFORCED = "false"

    let capturedAuth: VendorAuthContext | undefined
    const handler = jest.fn(async (req: any) => {
      capturedAuth = req.vendorAuth
    })

    const wrapped = withVendorAuth(handler as any)
    const warnMock = jest.fn()
    const req = buildMockReq(
      { "x-vendor-token": SELLER_ID },
      {
        gpCoreResolveFn: () => Promise.resolve(VENDOR_ID),
      }
    )
    // Inject a logger with spy
    req.scope.resolve = jest.fn((key: string) => {
      if (key === "logger") return { info: jest.fn(), warn: warnMock, error: jest.fn() }
      if (key === "gp_core") return { resolveVendorId: () => Promise.resolve(VENDOR_ID) }
      return null
    })

    const res = buildMockRes()
    await wrapped(req, res, jest.fn())

    expect(res.statusCode).toBe(200)
    expect(handler).toHaveBeenCalled()
    expect(capturedAuth?.seller_id).toBe(SELLER_ID)

    // Check structured warn log
    const warnCalls = warnMock.mock.calls.map((c) => c[0])
    const legacyWarn = warnCalls.find((msg) => {
      try {
        const parsed = JSON.parse(msg as string)
        return parsed.event === "vendor-auth.legacy-accept"
      } catch {
        return false
      }
    })
    expect(legacyWarn).toBeDefined()
    const parsedWarn = JSON.parse(legacyWarn as string)
    expect(parsedWarn.seller_id).toBe(SELLER_ID)
    expect(parsedWarn.transition_window).toBe(true)
  })

  // Case 7: Flag off + missing both headers → 401
  it("case-7: flag off + missing both headers → 401", async () => {
    process.env.VENDOR_HMAC_ENFORCED = "false"

    const handler = jest.fn()
    const wrapped = withVendorAuth(handler as any)

    const req = buildMockReq({}) // no headers
    const res = buildMockRes()

    await wrapped(req, res, jest.fn())

    expect(res.statusCode).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Case 8: VENDOR_HMAC_SECRET unset with enforced=true → 503
// ---------------------------------------------------------------------------

describe("withVendorAuth HOF — missing config", () => {
  it("case-8: VENDOR_HMAC_SECRET unset + enforced=true → 503", async () => {
    delete process.env.VENDOR_HMAC_SECRET
    process.env.VENDOR_HMAC_ENFORCED = "true"

    const handler = jest.fn()
    const wrapped = withVendorAuth(handler as any)

    const req = buildMockReq({ "x-vendor-signature": makeSignedHeader() })
    const res = buildMockRes()

    await wrapped(req, res, jest.fn())

    expect(res.statusCode).toBe(503)
    expect(handler).not.toHaveBeenCalled()
  })
})
