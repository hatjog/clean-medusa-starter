/**
 * cc-4 F-05 regression tests for vendor voucher lookup + redeem routes.
 *
 * Coverage:
 *   - L1  — GET /vendor/vouchers/:code/lookup → 200 with vendor-allowed view
 *   - L2  — GET /vendor/vouchers/:code/lookup → 404 for unknown code
 *   - L3  — GET /vendor/vouchers/:code/lookup → 404 for cross-vendor lookup
 *   - L4  — POST /vendor/vouchers/:code/redeem → 200 + 8-key audit envelope
 *   - L5  — POST /vendor/vouchers/:code/redeem → 404 for cross-vendor
 *   - L6  — POST /vendor/vouchers/:code/redeem → idempotent on second call
 *   - L7  — POST /vendor/vouchers/:code/redeem → 410 on expired voucher
 *
 * Strategy: bypass the withVendorAuth HMAC by stubbing process.env to a
 * known shared secret. The handler signs/verifies via the production
 * helpers; no Mercur DB is touched. VoucherService is mocked at the
 * container resolve seam.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals"
import { buildVendorSignatureHeader } from "../../../lib/vendor-hmac"
import { GET as lookupGET } from "../../../api/vendor/vouchers/[code]/lookup/route"
import { POST as redeemPOST } from "../../../api/vendor/vouchers/[code]/redeem/route"

const HMAC_SECRET = "vendor-redeem-test-secret"
const SELLER_ID = "seller_test_001"
const OTHER_SELLER_ID = "seller_test_other"
const VOUCHER_CODE = "VOUCHER-ABC123"

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv.VENDOR_HMAC_SECRET = process.env.VENDOR_HMAC_SECRET
  savedEnv.VENDOR_HMAC_ENFORCED = process.env.VENDOR_HMAC_ENFORCED
  process.env.VENDOR_HMAC_SECRET = HMAC_SECRET
  process.env.VENDOR_HMAC_ENFORCED = "true"
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

type AppendCall = { input: Record<string, unknown> }
type VoucherMock = {
  getByCode: jest.Mock
  claim: jest.Mock
}

function makeRequest(opts: {
  voucherService: VoucherMock
  appendCalls?: AppendCall[]
  resolveVendor?: (sellerId: string) => Promise<string>
  params?: Record<string, string>
}) {
  const sigHeader = buildVendorSignatureHeader(
    SELLER_ID,
    Buffer.from(HMAC_SECRET, "utf8"),
    Math.floor(Date.now() / 1000),
  )
  return {
    params: opts.params ?? { code: VOUCHER_CODE },
    body: {},
    query: {},
    headers: { "x-vendor-signature": sigHeader },
    scope: {
      resolve: (key: string) => {
        if (key === "voucher") return opts.voucherService
        if (key === "gp_core")
          return {
            resolveVendorId: opts.resolveVendor ?? (async (s: string) => `vendor_for_${s}`),
          }
        if (key === "logger")
          return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        // PG_CONNECTION used by appendNotificationLog — return a knex-like
        // stub that fails so the route logs and continues (best-effort audit).
        return {
          insert: () => ({
            returning: async () => {
              throw new Error("audit write skipped in unit test")
            },
          }),
        }
      },
    },
  } as unknown as import("@medusajs/framework/http").MedusaRequest
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
}

function makeVoucher(overrides: Partial<{
  code: string
  seller_id: string
  status: "idle" | "consent_pending" | "claimed" | "withdrawn"
  expires_at: Date | null
  market_id: string | null
  events: Array<{ event_type: string; occurred_at: Date }>
}> = {}) {
  return {
    code: overrides.code ?? VOUCHER_CODE,
    seller_id: overrides.seller_id ?? SELLER_ID,
    seller_name: "Salon Test",
    seller_handle: "salon-test",
    product_title: "Haircut",
    value_minor: 12_000,
    currency_code: "PLN",
    status: overrides.status ?? "idle",
    market_id: overrides.market_id ?? "mkt_bonbeauty",
    expires_at: overrides.expires_at ?? null,
    created_at: new Date(),
    updated_at: new Date(),
    events: overrides.events ?? [],
  }
}

describe("cc-4 F-05 — GET /vendor/vouchers/:code/lookup", () => {
  it("L1 — returns 200 + vendor view for owner seller", async () => {
    const voucher = makeVoucher()
    const mock: VoucherMock = {
      getByCode: jest.fn(async () => voucher),
      claim: jest.fn(),
    }
    const req = makeRequest({ voucherService: mock })
    const res = makeRes()
    await lookupGET(req as never, res as never, jest.fn() as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { voucher: { code: string; market_id: string | null } }
    expect(body.voucher.code).toBe(VOUCHER_CODE)
    expect(body.voucher.market_id).toBe("mkt_bonbeauty")
  })

  it("L2 — returns 404 for unknown code", async () => {
    const mock: VoucherMock = {
      getByCode: jest.fn(async () => null),
      claim: jest.fn(),
    }
    const req = makeRequest({ voucherService: mock })
    const res = makeRes()
    await lookupGET(req as never, res as never, jest.fn() as never)
    expect(res.statusCode).toBe(404)
  })

  it("L3 — returns 404 for cross-vendor lookup (no existence leak)", async () => {
    const voucher = makeVoucher({ seller_id: OTHER_SELLER_ID })
    const mock: VoucherMock = {
      getByCode: jest.fn(async () => voucher),
      claim: jest.fn(),
    }
    const req = makeRequest({ voucherService: mock })
    const res = makeRes()
    await lookupGET(req as never, res as never, jest.fn() as never)
    expect(res.statusCode).toBe(404)
  })
})

describe("cc-4 F-05 — POST /vendor/vouchers/:code/redeem", () => {
  it("L4 — returns 200 + 8-key audit envelope", async () => {
    const claimEvent = { event_type: "claimed", occurred_at: new Date("2026-05-24T10:00:00Z") }
    const voucher = makeVoucher()
    const mock: VoucherMock = {
      getByCode: jest.fn(async () => voucher),
      claim: jest.fn(async () => ({
        status: "claimed",
        voucher: makeVoucher({ status: "claimed", events: [claimEvent] }),
      })),
    }
    const req = makeRequest({ voucherService: mock })
    const res = makeRes()
    await redeemPOST(req as never, res as never, jest.fn() as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as {
      ok: boolean
      idempotent: boolean
      status: string
      envelope: Record<string, unknown>
    }
    expect(body.ok).toBe(true)
    expect(body.idempotent).toBe(false)
    expect(body.status).toBe("claimed")
    // Story 8.4 AC5 — envelope MUST carry these 8 keys.
    const required = [
      "audit_log_id",
      "vendor_id",
      "seller_id",
      "market_id",
      "code",
      "prior_status",
      "new_status",
      "claimed_at",
    ]
    for (const key of required) {
      expect(body.envelope).toHaveProperty(key)
    }
    expect(body.envelope.seller_id).toBe(SELLER_ID)
    expect(body.envelope.code).toBe(VOUCHER_CODE)
    expect(body.envelope.prior_status).toBe("idle")
    expect(body.envelope.new_status).toBe("claimed")
  })

  it("L5 — returns 404 for cross-vendor redeem attempt (no state mutation)", async () => {
    const voucher = makeVoucher({ seller_id: OTHER_SELLER_ID })
    const mock: VoucherMock = {
      getByCode: jest.fn(async () => voucher),
      claim: jest.fn(),
    }
    const req = makeRequest({ voucherService: mock })
    const res = makeRes()
    await redeemPOST(req as never, res as never, jest.fn() as never)
    expect(res.statusCode).toBe(404)
    expect(mock.claim).not.toHaveBeenCalled()
  })

  it("L6 — second call returns idempotent=true with already_claimed", async () => {
    const claimEvent = { event_type: "claimed", occurred_at: new Date("2026-05-24T10:00:00Z") }
    const claimedVoucher = makeVoucher({ status: "claimed", events: [claimEvent] })
    const mock: VoucherMock = {
      getByCode: jest.fn(async () => claimedVoucher),
      claim: jest.fn(async () => ({
        status: "already_claimed",
        voucher: claimedVoucher,
      })),
    }
    const req = makeRequest({ voucherService: mock })
    const res = makeRes()
    await redeemPOST(req as never, res as never, jest.fn() as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as {
      idempotent: boolean
      envelope: { new_status: string }
    }
    expect(body.idempotent).toBe(true)
    expect(body.envelope.new_status).toBe("already_claimed")
  })

  it("L7 — returns 410 on expired voucher", async () => {
    const expiredVoucher = makeVoucher({
      expires_at: new Date(Date.now() - 86_400_000),
    })
    const mock: VoucherMock = {
      getByCode: jest.fn(async () => expiredVoucher),
      claim: jest.fn(async () => ({ status: "expired", voucher: expiredVoucher })),
    }
    const req = makeRequest({ voucherService: mock })
    const res = makeRes()
    await redeemPOST(req as never, res as never, jest.fn() as never)
    expect(res.statusCode).toBe(410)
  })
})
