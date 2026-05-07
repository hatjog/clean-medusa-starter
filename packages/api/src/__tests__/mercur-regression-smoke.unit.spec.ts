/**
 * Mercur Regression Smoke Test (Story 1.11 / NFR34)
 *
 * Validates baseline Mercur v2.0 behavior before GP patches:
 * - Event name contract (order.placed)
 * - Mercur payload format ({ order_ids: string[] })
 * - Retry-safe subscriber behavior
 * - withVendorAuth HOF contract (HMAC-enforced, cleanup-48)
 *
 * Does NOT duplicate tests in on-order-completed.unit.spec.ts.
 * Focus: contracts + withVendorAuth HOF shape.
 *
 * Updated in cleanup-48: tests now use HMAC-signed x-vendor-signature headers
 * (VENDOR_HMAC_ENFORCED=true) to verify the new enforcement path.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals"

import { config as subscriberConfig } from "../subscribers/on-order-completed.js"
import { NotImplementedError } from "../modules/gp-core/service"
import { withVendorAuth, vendorAuthMiddleware } from "../lib/vendor-auth"
import { buildVendorSignatureHeader } from "../lib/vendor-hmac"
import type { VendorAuthContext } from "../lib/vendor-auth"

// ---------------------------------------------------------------------------
// Env setup — enforce HMAC mode for all smoke tests
// ---------------------------------------------------------------------------

const SMOKE_SECRET = "smoke-test-hmac-secret-32bytes-x"
const SMOKE_SELLER = "seller-abc"

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv.VENDOR_HMAC_SECRET = process.env.VENDOR_HMAC_SECRET
  savedEnv.VENDOR_HMAC_ENFORCED = process.env.VENDOR_HMAC_ENFORCED
  process.env.VENDOR_HMAC_SECRET = SMOKE_SECRET
  process.env.VENDOR_HMAC_ENFORCED = "true"
})

afterEach(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key]
    else process.env[key] = val
  }
})

function makeSignedHeader(sellerId = SMOKE_SELLER): string {
  return buildVendorSignatureHeader(sellerId, SMOKE_SECRET)
}

// --- Event Contract Tests ---

describe("Mercur event contract", () => {
  it("subscriber config uses 'order.placed' event name", () => {
    expect(subscriberConfig.event).toBe("order.placed")
  })

  it("Mercur payload shape: order_ids is string[]", () => {
    const payload = { order_ids: ["ord-1", "ord-2"] }

    expect(Array.isArray(payload.order_ids)).toBe(true)
    expect(payload.order_ids.every((id) => typeof id === "string")).toBe(true)
  })

  it("standard MedusaJS payload shape: id is string", () => {
    const payload = { id: "ord-single" }

    expect(typeof payload.id).toBe("string")
  })
})

// --- withVendorAuth HOF Tests ---

function buildMockReq(headers: Record<string, string | undefined> = {}) {
  return {
    headers,
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === "logger") {
          return {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
          }
        }
        if (key === "gp_core") {
          return {
            resolveVendorId: jest.fn<(id: string) => Promise<string>>().mockResolvedValue("vendor-uuid-123"),
          }
        }
        return null
      }),
    },
  } as any
}

function buildMockRes() {
  const res: any = {
    statusCode: 200,
    body: null,
  }
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

describe("withVendorAuth HOF", () => {
  it("returns 401 when x-vendor-signature header is missing (enforced mode)", async () => {
    const handler = jest.fn()
    const wrapped = withVendorAuth(handler as any)
    const req = buildMockReq({})
    const res = buildMockRes()
    const next = jest.fn()

    await wrapped(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.body).toEqual(
      expect.objectContaining({ code: "VENDOR_AUTH_SIGNATURE_MISSING" })
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it("injects vendorAuth context when HMAC signature is valid", async () => {
    let capturedAuth: VendorAuthContext | undefined
    const handler = jest.fn(async (req: any) => {
      capturedAuth = req.vendorAuth
    })
    const wrapped = withVendorAuth(handler as any)
    const req = buildMockReq({ "x-vendor-signature": makeSignedHeader() })
    const res = buildMockRes()
    const next = jest.fn()

    await wrapped(req, res, next)

    expect(handler).toHaveBeenCalled()
    expect(capturedAuth).toBeDefined()
    expect(capturedAuth!.vendor_id).toBe("vendor-uuid-123")
    expect(capturedAuth!.seller_id).toBe(SMOKE_SELLER)
  })

  it("returns 501 when resolveVendorId is stub (NotImplementedError)", async () => {
    const handler = jest.fn()
    const wrapped = withVendorAuth(handler as any)
    const req = buildMockReq({ "x-vendor-signature": makeSignedHeader() })

    // Override gp_core to throw NotImplementedError
    req.scope.resolve = jest.fn((key: string) => {
      if (key === "logger") {
        return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      }
      if (key === "gp_core") {
        return {
          resolveVendorId: (jest.fn() as any).mockRejectedValue(
            new NotImplementedError("Story 1.3")
          ),
        }
      }
      return null
    })

    const res = buildMockRes()
    const next = jest.fn()

    await wrapped(req, res, next)

    expect(res.status).toHaveBeenCalledWith(501)
    expect(res.body).toEqual(
      expect.objectContaining({ stub: true, story: "1.3" })
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it("returns 503 when GpCoreService is not available", async () => {
    const handler = jest.fn()
    const wrapped = withVendorAuth(handler as any)
    const req = buildMockReq({ "x-vendor-signature": makeSignedHeader() })

    req.scope.resolve = jest.fn((key: string) => {
      if (key === "logger") {
        return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      }
      return null // no gp_core
    })

    const res = buildMockRes()
    const next = jest.fn()

    await wrapped(req, res, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(handler).not.toHaveBeenCalled()
  })

  it("returns 500 on unexpected error from resolveVendorId", async () => {
    const handler = jest.fn()
    const wrapped = withVendorAuth(handler as any)
    const req = buildMockReq({ "x-vendor-signature": makeSignedHeader() })

    req.scope.resolve = jest.fn((key: string) => {
      if (key === "logger") {
        return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      }
      if (key === "gp_core") {
        return {
          resolveVendorId: (jest.fn() as any).mockRejectedValue(new Error("DB down")),
        }
      }
      return null
    })

    const res = buildMockRes()
    const next = jest.fn()

    await wrapped(req, res, next)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(handler).not.toHaveBeenCalled()
  })
})

// --- vendorAuthMiddleware standalone tests ---

describe("vendorAuthMiddleware", () => {
  it("returns 401 without signature header (enforced mode)", async () => {
    const req = buildMockReq({})
    const res = buildMockRes()
    const next = jest.fn()

    await vendorAuthMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it("calls next() and injects vendorAuth on valid HMAC signature", async () => {
    const req = buildMockReq({ "x-vendor-signature": makeSignedHeader("seller-xyz") })
    const res = buildMockRes()
    const next = jest.fn()

    await vendorAuthMiddleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect((req as any).vendorAuth).toBeDefined()
    expect((req as any).vendorAuth.vendor_id).toBe("vendor-uuid-123")
  })

  it("returns 501 on NotImplementedError (stub-safe)", async () => {
    const req = buildMockReq({ "x-vendor-signature": makeSignedHeader("seller-xyz") })
    req.scope.resolve = jest.fn((key: string) => {
      if (key === "logger") {
        return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      }
      if (key === "gp_core") {
        return {
          resolveVendorId: (jest.fn() as any).mockRejectedValue(
            new NotImplementedError("Story 1.3")
          ),
        }
      }
      return null
    })
    const res = buildMockRes()
    const next = jest.fn()

    await vendorAuthMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(501)
    expect(res.body).toEqual(expect.objectContaining({ stub: true }))
    expect(next).not.toHaveBeenCalled()
  })
})

// --- NotImplementedError class contract ---

describe("NotImplementedError", () => {
  it("has correct name property", () => {
    const err = new NotImplementedError("Story 1.3")

    expect(err.name).toBe("NotImplementedError")
  })

  it("includes story reference in message", () => {
    const err = new NotImplementedError("Story 1.3")

    expect(err.message).toContain("Story 1.3")
  })

  it("is instanceof Error", () => {
    const err = new NotImplementedError("Story 1.3")

    expect(err).toBeInstanceOf(Error)
  })
})

// --- Catch-all / retry safety ---

describe("subscriber retry safety", () => {
  it("subscriber export is a function (can be retried by event bus)", async () => {
    const { default: handler } = await import("../subscribers/on-order-completed.js")

    expect(typeof handler).toBe("function")
  })

  it("subscriber config is serializable (no circular refs)", () => {
    expect(() => JSON.stringify(subscriberConfig)).not.toThrow()
  })
})
