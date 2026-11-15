/**
 * v1.16.0 Story 5.7 AC2 (FR-19a, AD-34; D-36; ADR-245 `Proposed`) —
 * `POST /vendor/vouchers/:code/reverse-redemption`: korekta pomyłkowej realizacji.
 *
 * Mierzy TRASĘ i operację domenową `correct()` nad atrapą połączenia (ON CONFLICT
 * i UPDATE … WHERE state = $from odwzorowane po stronie JS). Atrapa NIE dowodzi
 * CHECK-ów ani transakcyjności bazy — to robi profil
 * `test:integration:story-5-7-redemption-trail-pg` na realnym Postgresie.
 *
 * Kontrakt mierzony tutaj:
 *   - korekta z sesji `member` + `x-seller-id` ⇒ stan `REDEMPTION_REVERSED`,
 *     różny od `ACTIVE` i od `REDEEMED_FULL`;
 *   - wiersz `REVERSAL` z `reverses_redemption_id` = pierwotna realizacja,
 *     pierwotny wiersz bajt w bajt nienaruszony;
 *   - ponowna realizacja po korekcie DOZWOLONA (D-36);
 *   - druga korekta tej samej realizacji ODMÓWIONA (`already_reversed`);
 *   - cudzy kod ⇒ 404 bez efektu; odmowy mają stały `reason` i `message` bez id.
 */
import { describe, expect, it, jest } from "@jest/globals"
import { createReplayGuardTestDb } from "../../helpers/replay-guard-test-db"
import { POST as reverseHandler } from "../../../api/vendor/vouchers/[code]/reverse-redemption/route"
import { POST as redeemHandler } from "../../../api/vendor/vouchers/[code]/redeem/route"

const SELLER_ID = "seller_corr_001"
const OTHER_SELLER_ID = "seller_corr_other"
const CODE = "VOUCHER-CORR-1"
const ENTITLEMENT_ID = "ent_corr_unit_1"
const GROSS = 24_900

type Row = Record<string, unknown>

function createWorld(opts: { entitlementType?: string } = {}) {
  const redemptions = new Map<string, Row>()
  const world = {
    state: "ACTIVE",
    voucherStatus: "idle" as string,
    redemptions,
    inserts: [] as Row[],
  }
  const entRow = () => ({
    id: ENTITLEMENT_ID,
    entitlement_type: opts.entitlementType ?? "VOUCHER_SERVICE",
    state: world.state,
    remaining_amount: null,
    policy_snapshot: {
      voucher_code: CODE,
      market_id: "bonbeauty",
      amount_minor: GROSS,
      currency_code: "PLN",
      transferability: "bearer",
    },
    vat_classification: "MPV",
    market_id: "bonbeauty",
    sales_channel_id: null,
    recipient_customer_id: null,
  })
  const query = async (sql: string, params: unknown[] = []) => {
    const text = sql.trim()
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [], rowCount: 0 }
    if (/FROM entitlement_instance/i.test(text)) return { rows: [entRow()], rowCount: 1 }
    if (/^SELECT[\s\S]*FROM voucher_redemption/i.test(text)) {
      const all = [...redemptions.values()]
      if (/commission_base_minor/i.test(text)) {
        const base = all.reduce(
          (acc, r) => acc + (r.kind === "REVERSAL" ? -1 : 1) * Number(r.amount_minor),
          0,
        )
        return { rows: [{ commission_base_minor: String(base) }], rowCount: 1 }
      }
      if (/ORDER BY created_at/i.test(text)) {
        const rows = all.sort((a, b) => Number(a.created_at) - Number(b.created_at))
        return { rows, rowCount: rows.length }
      }
      if (/LIMIT 1/i.test(text)) return { rows: all.slice(0, 1), rowCount: Math.min(1, all.length) }
      const found = redemptions.get(JSON.stringify([params[0], params[1], params[2]]))
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 }
    }
    if (/^INSERT INTO voucher_redemption/i.test(text)) {
      const key = JSON.stringify([params[0], params[1], params[8]])
      if (redemptions.has(key)) return { rows: [], rowCount: 0 }
      const row = {
        entitlement_id: params[0],
        idempotency_key: params[1],
        redemption_id: params[2],
        amount_minor: String(params[3]),
        resulting_state: params[4],
        remaining_after_minor: String(params[5]),
        issued_gross_minor: String(params[6]),
        created_at: String(params[7]),
        kind: params[8],
        reverses_redemption_id: params[9],
        market_id: params[10],
        purchase_market_id: params[11],
        redemption_market_id: params[12],
      }
      redemptions.set(key, row)
      world.inserts.push({ ...row })
      return { rows: [], rowCount: 1 }
    }
    if (/^UPDATE entitlement_instance/i.test(text)) {
      if (params[1] !== world.state) return { rows: [], rowCount: 0 }
      world.state = params[2] as string
      return { rows: [], rowCount: 1 }
    }
    if (/^INSERT INTO voucher_event/i.test(text)) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }
  return { world, client: { acquireConnection: async () => ({ query }), releaseConnection: async () => {} } }
}

function serviceFor(w: ReturnType<typeof createWorld>) {
  const voucher = () => ({
    code: CODE,
    seller_id: SELLER_ID,
    seller_name: "Salon",
    seller_handle: "salon",
    product_title: "Masaż",
    value_minor: GROSS,
    currency_code: "PLN",
    status: w.world.voucherStatus,
    market_id: "bonbeauty",
    expires_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    events: [],
  })
  return {
    getForSeller: jest.fn(async (s: string) => (s === SELLER_ID ? voucher() : null)),
    redeemForSeller: jest.fn(async (s: string) => {
      if (s !== SELLER_ID) return { status: "not_found", voucher: null }
      if (w.world.voucherStatus !== "idle") {
        return { status: "refused", reason: "already_redeemed", voucher: voucher() }
      }
      const prior = w.world.voucherStatus
      w.world.voucherStatus = "claimed"
      return { status: "redeemed", prior_status: prior, voucher: voucher() }
    }),
    restoreAfterCorrectionForSeller: jest.fn(async (s: string) => {
      if (s !== SELLER_ID || w.world.voucherStatus !== "claimed") {
        throw new Error("restoreVoucherCodeAfterCorrection: kod nie jest 'claimed'")
      }
      w.world.voucherStatus = "idle"
      return "idle"
    }),
  }
}

function makeReq(
  w: ReturnType<typeof createWorld>,
  service: ReturnType<typeof serviceFor>,
  sellerId: string,
  idempotencyKey?: string,
) {
  const knexStub = ((table: string) => {
    if (table !== "seller") throw new Error(`unexpected table ${table}`)
    return { select: () => ({ where: () => ({ first: async () => ({ market_id: "bonbeauty" }) }) }) }
  }) as unknown as Record<string, unknown>
  ;(knexStub as Record<string, unknown>).raw = createReplayGuardTestDb().raw
  ;(knexStub as Record<string, unknown>).client = w.client
  ;(knexStub as Record<string, unknown>).insert = () => ({
    returning: async () => {
      throw new Error("audit write skipped in unit test")
    },
  })
  return {
    params: { code: CODE },
    body: {},
    headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
    seller_context: { seller_id: sellerId },
    scope: {
      resolve: (key: string) => {
        if (key === "voucher") return service
        if (key === "gp_core") return { resolveVendorId: async (s: string) => `vendor_${s}` }
        if (key === "logger") return { info() {}, warn() {}, error() {} }
        if (key === "posthog") throw new Error("unknown key: posthog")
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

async function redeem(w: ReturnType<typeof createWorld>, s: ReturnType<typeof serviceFor>, key: string) {
  const res = makeRes()
  await redeemHandler(makeReq(w, s, SELLER_ID, key), res as never)
  return res
}

async function correct(w: ReturnType<typeof createWorld>, s: ReturnType<typeof serviceFor>, seller = SELLER_ID) {
  const res = makeRes()
  await reverseHandler(makeReq(w, s, seller), res as never)
  return res
}

describe("Story 5.7 AC2 — POST /vendor/vouchers/:code/reverse-redemption", () => {
  it("korekta ⇒ nazwany stan REDEMPTION_REVERSED, różny od ACTIVE i REDEEMED_FULL", async () => {
    const w = createWorld()
    const s = serviceFor(w)
    expect((await redeem(w, s, "panel-corr-key-0001")).statusCode).toBe(200)
    expect(w.world.state).toBe("REDEEMED_FULL")

    const res = await correct(w, s)
    expect(res.statusCode).toBe(200)
    const body = res.body as { status: string; correction: Record<string, unknown> }
    expect(body.status).toBe("REDEMPTION_REVERSED")
    expect(body.status).not.toBe("ACTIVE")
    expect(body.status).not.toBe("REDEEMED_FULL")
    expect(body.correction).toEqual({
      corrected_at: expect.any(String),
      actor: "own_seller",
      market_id: "bonbeauty",
    })
    expect(w.world.state).toBe("REDEMPTION_REVERSED")
    expect(w.world.voucherStatus).toBe("idle")
  })

  it("ślad append-only: wiersz REVERSAL wskazuje pierwotny, pierwotny nienaruszony", async () => {
    const w = createWorld()
    const s = serviceFor(w)
    await redeem(w, s, "panel-corr-key-0002")
    const original = { ...w.world.inserts[0] }
    await correct(w, s)
    expect(w.world.inserts).toHaveLength(2)
    const [first, reversal] = [...w.world.redemptions.values()]
    expect(first).toEqual(original)
    expect(reversal).toEqual(
      expect.objectContaining({
        kind: "REVERSAL",
        reverses_redemption_id: original.redemption_id,
        resulting_state: "REDEMPTION_REVERSED",
        idempotency_key: original.idempotency_key,
      }),
    )
    expect(reversal.redemption_id).not.toBe(original.redemption_id)
  })

  it("ponowna realizacja po korekcie DOZWOLONA (D-36)", async () => {
    const w = createWorld()
    const s = serviceFor(w)
    await redeem(w, s, "panel-corr-key-0003")
    await correct(w, s)
    const again = await redeem(w, s, "panel-corr-key-0004")
    expect(again.statusCode).toBe(200)
    expect((again.body as { outcome: string }).outcome).toBe("redeemed_now")
    expect(w.world.state).toBe("REDEEMED_FULL")
    expect(w.world.inserts.filter((r) => r.kind === "REDEMPTION")).toHaveLength(2)
  })

  it("druga korekta tej samej realizacji ODMÓWIONA: 409 already_reversed, stałe zdanie", async () => {
    const w = createWorld()
    const s = serviceFor(w)
    await redeem(w, s, "panel-corr-key-0005")
    await correct(w, s)
    const second = await correct(w, s)
    expect(second.statusCode).toBe(409)
    expect(second.body).toEqual({
      code: "REDEMPTION_ALREADY_REVERSED",
      reason: "already_reversed",
      message: "ta realizacja została już skorygowana",
    })
    expect(w.world.inserts).toHaveLength(2)
  })

  it("niezrealizowany voucher: 409 not_redeemed, bez id w message, bez efektu", async () => {
    const w = createWorld()
    const s = serviceFor(w)
    const res = await correct(w, s)
    expect(res.statusCode).toBe(409)
    const body = res.body as { reason: string; message: string }
    expect(body.reason).toBe("not_redeemed")
    expect(body.message).not.toContain(ENTITLEMENT_ID)
    expect(body.message).not.toContain(CODE)
    expect(w.world.inserts).toHaveLength(0)
    expect(w.world.state).toBe("ACTIVE")
  })

  it("gałąź kwotowa: 422 not_correctable", async () => {
    const w = createWorld({ entitlementType: "VOUCHER_AMOUNT" })
    w.world.state = "REDEEMED_FULL"
    const s = serviceFor(w)
    const res = await correct(w, s)
    expect(res.statusCode).toBe(422)
    expect((res.body as { reason: string }).reason).toBe("not_correctable")
    expect(w.world.inserts).toHaveLength(0)
  })

  it("cudzy kod: 404 VOUCHER_NOT_FOUND, zero efektu", async () => {
    const w = createWorld()
    const s = serviceFor(w)
    await redeem(w, s, "panel-corr-key-0006")
    const res = await correct(w, s, OTHER_SELLER_ID)
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ code: "VOUCHER_NOT_FOUND", message: "Voucher not found" })
    expect(w.world.state).toBe("REDEEMED_FULL")
    expect(w.world.inserts).toHaveLength(1)
  })
})
