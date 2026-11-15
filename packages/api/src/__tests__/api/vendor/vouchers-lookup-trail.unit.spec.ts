/**
 * v1.16.0 Story 5.7 AC1 (FR-19a, AD-34) — ślad realizacji odnajdywalny po kodzie
 * vouchera w `GET /vendor/vouchers/:code/lookup`.
 *
 * Dwie warstwy:
 *   - TRASA: zrealizowany voucher zwraca `redemption_trail` z momentem, aktorem
 *     (poziom salonu) i `market_id`; cudzy kod ⇒ 404 bez śladu (zakres najemcy);
 *   - SERWIS: `getRedemptionTrailForSeller` mapuje wiersze kanonicznej
 *     (`bigint` jako STRING z node-pg, klucz panelowy, korekta, zwrot) i NIE
 *     czyta śladu dla cudzego kodu.
 * Atomowość śladu z aktem na realnym Postgresie: profil
 * `test:integration:story-5-7-redemption-trail-pg`.
 */
import { describe, expect, it, jest } from "@jest/globals"
import { createReplayGuardTestDb } from "../../helpers/replay-guard-test-db"
import { GET as lookupGET } from "../../../api/vendor/vouchers/[code]/lookup/route"
import { VoucherService } from "../../../modules/voucher/service"

const SELLER_ID = "seller_trail_001"
const OTHER_SELLER_ID = "seller_trail_other"
const CODE = "VOUCHER-TRAIL-1"

function makeVoucher() {
  return {
    code: CODE,
    seller_id: SELLER_ID,
    seller_name: "Salon",
    seller_handle: "salon",
    product_title: "Masaż",
    value_minor: 24_900,
    currency_code: "PLN",
    status: "claimed",
    market_id: "bonbeauty",
    expires_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    events: [],
  }
}

const TRAIL = [
  {
    kind: "redemption",
    at: "2026-11-15T10:00:00.000Z",
    actor: "own_seller",
    market_id: "bonbeauty",
    redemption_market_id: "bonbeauty",
  },
]

function makeReq(sellerId: string | null, service: Record<string, unknown>) {
  const knexStub = ((table: string) => {
    if (table !== "seller") throw new Error(`unexpected table ${table}`)
    return {
      select: () => ({ where: () => ({ first: async () => ({ market_id: "bonbeauty" }) }) }),
    }
  }) as unknown as Record<string, unknown>
  knexStub.raw = createReplayGuardTestDb().raw
  return {
    params: { code: CODE },
    headers: {},
    seller_context: sellerId ? { seller_id: sellerId } : undefined,
    scope: {
      resolve: (key: string) => {
        if (key === "voucher") return service
        if (key === "gp_core") return { resolveVendorId: async (s: string) => `vendor_${s}` }
        if (key === "logger") return { info() {}, warn() {}, error() {} }
        return knexStub
      },
    },
  } as never
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

function serviceMock() {
  const voucher = makeVoucher()
  return {
    getForSeller: jest.fn(async (s: string) => (s === SELLER_ID ? voucher : null)),
    getRedemptionTrailForSeller: jest.fn(async (s: string) => (s === SELLER_ID ? TRAIL : null)),
  }
}

describe("Story 5.7 AC1 — GET /vendor/vouchers/:code/lookup niesie ślad realizacji", () => {
  it("zrealizowany voucher: ślad z momentem, aktorem i market_id", async () => {
    const service = serviceMock()
    const res = makeRes()
    await lookupGET(makeReq(SELLER_ID, service), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { voucher: { code: string }; redemption_trail: typeof TRAIL }
    expect(body.voucher.code).toBe(CODE)
    expect(body.redemption_trail).toEqual(TRAIL)
    expect(body.redemption_trail[0]).toEqual(
      expect.objectContaining({ at: expect.any(String), actor: "own_seller", market_id: "bonbeauty" }),
    )
    expect(service.getRedemptionTrailForSeller).toHaveBeenCalledWith(SELLER_ID, CODE)
  })

  it("voucher innego sprzedawcy: 404 bez śladu (zakres najemcy)", async () => {
    const service = serviceMock()
    const res = makeRes()
    await lookupGET(makeReq(OTHER_SELLER_ID, service), res as never)
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ code: "VOUCHER_NOT_FOUND", message: "Voucher not found" })
    expect(service.getRedemptionTrailForSeller).not.toHaveBeenCalled()
  })
})

describe("Story 5.7 AC1 — VoucherService.getRedemptionTrailForSeller", () => {
  function serviceWithRows(owner: string, rows: Array<Record<string, unknown>>) {
    const queries: string[] = []
    const service = new VoucherService()
    service._testPool = {
      query: async (sql: string) => {
        queries.push(sql)
        if (/SELECT seller_id FROM voucher/.test(sql)) {
          return { rows: [{ seller_id: owner }], rowCount: 1 }
        }
        return { rows, rowCount: rows.length }
      },
    } as never
    return { service, queries }
  }

  it("mapuje realizację panelu, korektę i zwrot; bigint jako string", async () => {
    const at1 = Date.parse("2026-11-15T10:00:00Z")
    const at2 = Date.parse("2026-11-15T10:05:00Z")
    const { service, queries } = serviceWithRows(SELLER_ID, [
      { kind: "REDEMPTION", resulting_state: "REDEEMED_FULL", idempotency_key: "PANEL-ABC", created_at: String(at1), market_id: "bonbeauty", redemption_market_id: "bonbeauty" },
      { kind: "REVERSAL", resulting_state: "REDEMPTION_REVERSED", idempotency_key: "PANEL-ABC", created_at: String(at2), market_id: "bonbeauty", redemption_market_id: "bonbeauty" },
      { kind: "REDEMPTION", resulting_state: "REDEEMED_FULL", idempotency_key: "wf-key", created_at: String(at2 + 1), market_id: "bonbeauty", redemption_market_id: "bonbeauty" },
      { kind: "REVERSAL", resulting_state: "REDEEMED_FULL", idempotency_key: "wf-key", created_at: String(at2 + 2), market_id: "bonbeauty", redemption_market_id: "bonbeauty" },
    ])
    const trail = await service.getRedemptionTrailForSeller(SELLER_ID, CODE)
    expect(trail).toEqual([
      { kind: "redemption", at: "2026-11-15T10:00:00.000Z", actor: "own_seller", market_id: "bonbeauty", redemption_market_id: "bonbeauty" },
      { kind: "correction", at: "2026-11-15T10:05:00.000Z", actor: "own_seller", market_id: "bonbeauty", redemption_market_id: "bonbeauty" },
      { kind: "redemption", at: new Date(at2 + 1).toISOString(), actor: null, market_id: "bonbeauty", redemption_market_id: "bonbeauty" },
      { kind: "refund_reversal", at: new Date(at2 + 2).toISOString(), actor: null, market_id: "bonbeauty", redemption_market_id: "bonbeauty" },
    ])
    expect(queries[1]).toMatch(/FROM voucher_redemption/)
    expect(queries[1]).toMatch(/policy_snapshot->>'voucher_code' = \$1/)
  })

  it("cudzy kod: null i ZERO odczytu kanonicznej", async () => {
    const { service, queries } = serviceWithRows(OTHER_SELLER_ID, [])
    expect(await service.getRedemptionTrailForSeller(SELLER_ID, CODE)).toBeNull()
    expect(queries).toHaveLength(1)
  })
})
