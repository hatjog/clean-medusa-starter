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
 * Strategy: run the route through the REAL `/vendor/*` gate (Story 5.4) with a
 * signature made from the seller's own provisioned secret. The handler
 * signs/verifies via the production helpers; no Mercur DB is touched.
 * VoucherService is mocked at the container resolve seam.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals"
import { buildVendorSignatureHeader } from "../../../lib/vendor-hmac"
import { createReplayGuardTestDb } from "../../helpers/replay-guard-test-db"
import {
  configureVendorSecretCryptoCore,
  resetVendorSecretCryptoCore,
} from "../../../lib/vendor-secret/crypto-core"
import { GET as lookupHandler } from "../../../api/vendor/vouchers/[code]/lookup/route"
import { POST as redeemHandler } from "../../../api/vendor/vouchers/[code]/redeem/route"
import { withVendorGate } from "../../helpers/vendor-auth-chain"

// Story 5.4: the route handlers are bare; authentication is the /vendor/*
// matcher. Calling them directly would measure the route with NO auth at all,
// so every case below goes through the production gate first.
const lookupGET = withVendorGate(lookupHandler)
const redeemPOST = withVendorGate(redeemHandler)

const HMAC_SECRET = "vendor-redeem-test-secret"
const SELLER_ID = "seller_test_001"
const OTHER_SELLER_ID = "seller_test_other"
const VOUCHER_CODE = "VOUCHER-ABC123"

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv.VENDOR_HMAC_SECRET = process.env.VENDOR_HMAC_SECRET
  savedEnv.VENDOR_HMAC_ENFORCED = process.env.VENDOR_HMAC_ENFORCED
  // Story 5.4 (AC1): the shared secret is UNSET, not set-to-something. The
  // suite passes because the signature is verified against the SELLER'S OWN
  // secret from the crypto-core below — before 5.4 this same line produced
  // 503 VENDOR_AUTH_CONFIG_ERROR on every case.
  delete process.env.VENDOR_HMAC_SECRET
  process.env.VENDOR_HMAC_ENFORCED = "true"
  // v1.15.0 Story 5.2: the route resolves the HMAC secret PER SELLER, so this
  // suite provisions `SELLER_ID` in the crypto-core. Only the way the secret is
  // supplied changed — the signature shape and every assertion below are the same.
  configureVendorSecretCryptoCore({
    secretSetPath: "/test/vouchers-redeem.enc.json",
    decryptor: () =>
      JSON.stringify({
        version: 1,
        entries: [
          {
            seller_id: SELLER_ID,
            config_ref: `sops://test#${SELLER_ID}`,
            secret_b64: Buffer.from(HMAC_SECRET, "utf8").toString("base64"),
          },
        ],
      }),
  })
})

afterEach(() => {
  resetVendorSecretCryptoCore()
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

const ENTITLEMENT_ID = "ent_unit_redeem_1"
const ENTITLEMENT_GROSS = 12_000

/**
 * v1.15.0 Story 5.7 — atrapa połączenia dla ŚCIEŻKI KANONICZNEJ.
 *
 * ── Czego ta atrapa NIE dowodzi (nazwane wprost) ────────────────────────────
 * Nie dowodzi NICZEGO o schemacie, CHECK-ach, grantach, RLS ani o typach
 * zwracanych przez `node-pg` — a więc nie jest i nie może być dowodem dla AC1.
 * Honoruje `ON CONFLICT DO NOTHING` po stronie JS, więc pokazuje wyłącznie, jak
 * TRASA reaguje na wynik producenta: kody HTTP, kształt koperty i kolejność
 * fakt → projekcja. Dowód z wykonania na realnym Postgresie leży w
 * `packages/api/src/__tests__/rls/voucher-redemption.integration.spec.ts`
 * (profil `TEST_TYPE=voucher-redemption-pg`); ADR-166 jest precedensem tego,
 * co się dzieje, gdy atrapa zostaje uznana za dowód.
 */
function createRedemptionFakeDb(opts: {
  entitlementState?: string
  entitlementRows?: number
} = {}) {
  const redemptions = new Map<string, Record<string, unknown>>()
  let state = opts.entitlementState ?? "ACTIVE"
  let remaining = ENTITLEMENT_GROSS
  const entitlementCount = opts.entitlementRows ?? 1

  const entitlementRow = (index: number) => ({
    id: index === 0 ? ENTITLEMENT_ID : `${ENTITLEMENT_ID}_${index}`,
    entitlement_type: "VOUCHER_AMOUNT",
    state,
    remaining_amount: remaining,
    policy_snapshot: {
      voucher_code: VOUCHER_CODE,
      market_id: "bonbeauty",
      amount_minor: ENTITLEMENT_GROSS,
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
    if (/FROM entitlement_instance/i.test(text)) {
      const rows = Array.from({ length: entitlementCount }, (_, i) =>
        entitlementRow(i),
      )
      return { rows, rowCount: rows.length }
    }
    if (/^SELECT[\s\S]*FROM voucher_redemption/i.test(text)) {
      if (/commission_base_minor/i.test(text)) {
        let base = 0
        for (const row of redemptions.values()) {
          base +=
            row.kind === "REVERSAL"
              ? -Number(row.amount_minor)
              : Number(row.amount_minor)
        }
        return { rows: [{ commission_base_minor: String(base) }], rowCount: 1 }
      }
      const key = JSON.stringify([params[0], params[1], params[2] ?? "REDEMPTION"])
      const found = redemptions.get(key)
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 }
    }
    if (/^INSERT INTO voucher_redemption/i.test(text)) {
      const key = JSON.stringify([params[0], params[1], params[8]])
      if (redemptions.has(key)) return { rows: [], rowCount: 0 }
      redemptions.set(key, {
        entitlement_id: params[0],
        idempotency_key: params[1],
        redemption_id: params[2],
        // `node-pg` zwraca `bigint` jako STRING — atrapa musi to odwzorować,
        // inaczej maskowałaby dokładnie ten defekt, o który chodzi w ADR-166.
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
      })
      return { rows: [], rowCount: 1 }
    }
    if (/^UPDATE entitlement_instance/i.test(text)) {
      const from = params[1]
      if (from !== state) return { rows: [], rowCount: 0 }
      state = params[2] as string
      if (params.length >= 5 && typeof params[3] === "number") {
        remaining = params[3] as number
      }
      return { rows: [], rowCount: 1 }
    }
    if (/^INSERT INTO voucher_event/i.test(text)) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }

  const connection = { query }
  return {
    redemptions,
    client: {
      acquireConnection: async () => connection,
      releaseConnection: async () => {},
    },
  }
}

function makeRequest(opts: {
  voucherService: VoucherMock
  appendCalls?: AppendCall[]
  resolveVendor?: (sellerId: string) => Promise<string>
  params?: Record<string, string>
  /** `null` = sprzedawca BEZ zadeklarowanego rynku (kontrola negatywna 2.6). */
  sellerMarketId?: string | null
  /**
   * v1.15.0 Story 5.7: nagłówek `Idempotency-Key`. `null` = ŚWIADOMY brak
   * (kontrola negatywna M4 pkt 2). Domyślnie obecny, bo bez niego trasa odmawia
   * i żaden z pozostałych przypadków nie zmierzyłby tego, po co powstał.
   */
  idempotencyKey?: string | null
  /** Współdzielona atrapa kanonicznej — dla przypadków wielo-żądaniowych. */
  redemptionDb?: ReturnType<typeof createRedemptionFakeDb>
}) {
  const sigHeader = buildVendorSignatureHeader(
    SELLER_ID,
    Buffer.from(HMAC_SECRET, "utf8"),
    Math.floor(Date.now() / 1000),
  )
  // Fresh barrier per request builder: these cases are about the route, not
  // about replay, so each built request must carry a nonce that is still free.
  const replayGuardDb = createReplayGuardTestDb()
  const redemptionDb = opts.redemptionDb ?? createRedemptionFakeDb()
  const idempotencyKey =
    "idempotencyKey" in opts ? opts.idempotencyKey : "panel-unit-key-0001"
  return {
    params: opts.params ?? { code: VOUCHER_CODE },
    body: {},
    query: {},
    headers: {
      "x-vendor-signature": sigHeader,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
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
        //
        // v1.15.0 Story 5.3: the SAME connection now also carries the anti-replay
        // barrier, which fails CLOSED (503) when it cannot be consulted. Hence
        // `raw` is wired to the shared guard stub — without it every case here
        // would measure 503 instead of the route behaviour it was written for.
        //
        // v1.15.0 Story 2.6 cykl 1: trasa vendora zakłada teraz KONTEKST RYNKU
        // (pod FORCE RLS połączenie bez `app.gp_market_id` widzi zero wierszy),
        // a rynek bierze z uwierzytelnionego SPRZEDAWCY. Stub musi więc być
        // WYWOŁYWALNY jak knex (`db("seller")`) — bez tego trasa nie ma skąd
        // wziąć rynku i odmawia.
        const knexStub = ((table: string) => {
          if (table !== "seller") {
            throw new Error(`unexpected table in unit stub: ${table}`)
          }
          return {
            select: () => ({
              where: () => ({
                first: async () => ({
                  market_id:
                    "sellerMarketId" in opts ? opts.sellerMarketId : "bonbeauty",
                }),
              }),
            }),
          }
        }) as unknown as Record<string, unknown> & ((t: string) => unknown)
        ;(knexStub as any).raw = replayGuardDb.raw
        // v1.15.0 Story 5.7: producent kanonicznej jedzie TĄ SAMĄ pulą, którą
        // łata hook RLS — czyli `PG_CONNECTION.client` (`resolveRlsConnectionSource`).
        // Bez tego pola trasa odmawiałaby `GP_RLS_CONNECTION_SOURCE_UNAVAILABLE`,
        // i słusznie: własna pula byłaby drugim nośnikiem kontekstu (AD-21 §4).
        ;(knexStub as any).client = redemptionDb.client
        ;(knexStub as any).insert = () => ({
          returning: async () => {
            throw new Error("audit write skipped in unit test")
          },
        })
        return knexStub
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
    // v1.15.0 Story 5.7: koperta niesie teraz także identyfikator wiersza
    // KANONICZNEGO i kwotę — bez nich trasa opisywała zdarzenie finansowe
    // bez ani jednej liczby.
    expect(body.envelope.redemption_id).toMatch(/^RDM-[0-9A-F]{12}$/)
    expect(body.envelope.amount_minor).toBe(ENTITLEMENT_GROSS)
    expect(body.envelope.remaining_after_minor).toBe(0)
  })

  // v1.15.0 Story 5.7 (ADR-178 §2.2 M4 pkt 2) — kontrola, która PĘKA po zepsuciu
  // mechanizmu: gdyby serwer podstawiał klucz „na wszelki wypadek", ten przypadek
  // zwróciłby 200 i każdy retry tworzyłby drugi wiersz kanoniczny.
  it("L9 — brak nagłówka Idempotency-Key ⇒ 400, PRZED dotknięciem vouchera", async () => {
    const mock: VoucherMock = {
      getByCode: jest.fn(async () => makeVoucher()),
      claim: jest.fn(),
    }
    const req = makeRequest({ voucherService: mock, idempotencyKey: null })
    const res = makeRes()
    await redeemPOST(req as never, res as never, jest.fn() as never)
    expect(res.statusCode).toBe(400)
    expect((res.body as { code: string }).code).toBe("IDEMPOTENCY_KEY_REQUIRED")
    expect(mock.getByCode).not.toHaveBeenCalled()
    expect(mock.claim).not.toHaveBeenCalled()
  })

  // v1.15.0 Story 5.7 (ADR-178 §2.2 M3) — wiele uprawnień na jeden kod jest
  // ODMOWĄ, nie cichym wyborem „pierwszego lepszego" wiersza.
  it("L10 — dwa uprawnienia na jeden kod ⇒ 409 ENTITLEMENT_AMBIGUOUS", async () => {
    const mock: VoucherMock = {
      getByCode: jest.fn(async () => makeVoucher()),
      claim: jest.fn(),
    }
    const req = makeRequest({
      voucherService: mock,
      redemptionDb: createRedemptionFakeDb({ entitlementRows: 2 }),
    })
    const res = makeRes()
    await redeemPOST(req as never, res as never, jest.fn() as never)
    expect(res.statusCode).toBe(409)
    expect((res.body as { code: string }).code).toBe("ENTITLEMENT_AMBIGUOUS")
    expect(mock.claim).not.toHaveBeenCalled()
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

  // v1.15.0 Story 5.7 (ADR-178 §2.2 M5): źródłem `already_claimed` jest teraz
  // `ON CONFLICT DO NOTHING` na kanonicznej — zero wstawionych wierszy ⇒ replay —
  // a nie sam `voucher.status`. Ten przypadek robi więc DWA żądania z TYM SAMYM
  // nagłówkiem przeciw TEJ SAMEJ atrapie kanonicznej, zamiast opisywać drugie
  // żądanie mockiem serwisu.
  it("L6 — drugie żądanie z tym samym Idempotency-Key ⇒ idempotent=true, already_claimed", async () => {
    const claimEvent = { event_type: "claimed", occurred_at: new Date("2026-05-24T10:00:00Z") }
    const claimedVoucher = makeVoucher({ status: "claimed", events: [claimEvent] })
    const mock: VoucherMock = {
      getByCode: jest.fn(async () => makeVoucher()),
      claim: jest.fn(async () => ({ status: "claimed", voucher: claimedVoucher })),
    }
    const redemptionDb = createRedemptionFakeDb()

    const first = makeRes()
    await redeemPOST(
      makeRequest({ voucherService: mock, redemptionDb }) as never,
      first as never,
      jest.fn() as never,
    )
    expect(first.statusCode).toBe(200)
    expect((first.body as { idempotent: boolean }).idempotent).toBe(false)

    const second = makeRes()
    await redeemPOST(
      makeRequest({ voucherService: mock, redemptionDb }) as never,
      second as never,
      jest.fn() as never,
    )
    expect(second.statusCode).toBe(200)
    const body = second.body as {
      idempotent: boolean
      envelope: { new_status: string; audit_log_id: string }
    }
    expect(body.idempotent).toBe(true)
    expect(body.envelope.new_status).toBe("already_claimed")
    // Powtórzenie NIE tworzy drugiego wiersza kanonicznego.
    expect(redemptionDb.redemptions.size).toBe(1)
    // …a koperta audytowa jest TA SAMA (M4 pkt 4: `audit_log_id` jest POCHODNĄ
    // klucza idempotencji, nie losową wartością per żądanie).
    expect(body.envelope.audit_log_id).toBe(
      (first.body as { envelope: { audit_log_id: string } }).envelope.audit_log_id,
    )
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

  // v1.15.0 Story 2.6 cykl 1 (finding HIGH #1) — kontrola, która PĘKA po zepsuciu
  // nowego mechanizmu: bez rynku sprzedawcy trasa MUSI odmówić głośno. Cichy
  // przebieg dałby pod FORCE RLS `getByCode → null`, czyli komunikat „voucher nie
  // istnieje" przy voucherze, który istnieje — najgorszy możliwy wariant na
  // ścieżce realizacji.
  it("L8 — sprzedawca BEZ zadeklarowanego rynku dostaje 409, nie ciche 404", async () => {
    const voucher = makeVoucher()
    const mock: VoucherMock = {
      getByCode: jest.fn(async () => voucher),
      claim: jest.fn(async () => ({ status: "claimed", voucher })),
    }
    const req = makeRequest({ voucherService: mock, sellerMarketId: null })
    const res = makeRes()
    await redeemPOST(req as never, res as never, jest.fn() as never)
    expect(res.statusCode).toBe(409)
    expect((res.body as { code: string }).code).toBe("MARKET_CONTEXT_REQUIRED")
    // Odmowa jest PRZED dotknięciem vouchera — żadnego odczytu ani mutacji.
    expect(mock.getByCode).not.toHaveBeenCalled()
    expect(mock.claim).not.toHaveBeenCalled()
  })
})
