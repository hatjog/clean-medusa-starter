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
 * Strategy (ZMIENIONA w v1.15.0 Story 5.8, AC2): obie trasy są ZWOLNIONE
 * z bramki HMAC wpisami w `VENDOR_HMAC_EXEMPT_ROUTES` — uwierzytelnia je łańcuch
 * Mercura (`authenticate("member", …)` + `ensureSellerMiddleware`), który
 * wypełnia `req.seller_context.seller_id`. Przepuszczanie ich tutaj przez
 * `withVendorGate` mierzyłoby ścieżkę, którą produkcja już nie chodzi, i to
 * właśnie ta ścieżka dawała panelowi `401`.
 *
 * Ten łańcuch (upstream Mercura) NIE JEST wykonywalny w teście jednostkowym,
 * więc suita buduje jego SKUTEK — `seller_context` — i wywołuje handler wprost.
 * Bezpiecznik fail-closed („brak kontekstu ⇒ 401") ma tu WŁASNY przypadek (L11),
 * a dowodem uwierzytelnienia na realnej ścieżce jest kontrola wykonaniem na
 * prod-buildzie (AC2/AC3), nie ta suita. VoucherService jest atrapą na szwie
 * `container.resolve`.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals"
import { randomUUID } from "node:crypto"
import { buildVendorSignatureHeader } from "../../../lib/vendor-hmac"
import { createReplayGuardTestDb } from "../../helpers/replay-guard-test-db"
import {
  configureVendorSecretCryptoCore,
  resetVendorSecretCryptoCore,
} from "../../../lib/vendor-secret/crypto-core"
import { GET as lookupHandler } from "../../../api/vendor/vouchers/[code]/lookup/route"
import {
  HOT_PATH_UNHANDLED_REFUSAL_CODE,
  POST as redeemHandler,
  __resetHotPathWarnStateForTests,
} from "../../../api/vendor/vouchers/[code]/redeem/route"
import {
  POSTHOG_CONTAINER_KEY,
  type PosthogCaptureClient,
} from "../../../lib/instrumentation/posthog-metrics-client"
import {
  REDEMPTION_ATTEMPT_EVENT,
  REDEMPTION_DURATION_EVENT,
  REDEMPTION_SUCCESS_EVENT,
} from "../../../lib/instrumentation/redemption-hot-path"
import { withVendorGate } from "../../helpers/vendor-auth-chain"

// v1.15.0 Story 5.8: trasy są ZWOLNIONE z bramki HMAC, więc `withVendorGate`
// nie jest już ich ścieżką produkcyjną. Handler jest wołany wprost, a tożsamość
// przychodzi tak, jak przychodzi w produkcji — w `req.seller_context`.
const lookupGET = lookupHandler
const redeemPOST = redeemHandler

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
/**
 * Atrapa serwisu na szwie kontenera. Od 5.8 trasa woła DWIE operacje
 * przyjmujące najemcę zamiast pary `getByCode` + `claim`:
 *   - `getForSeller(sellerId, code)` — tani early-out, `null` dla nieznanego
 *     I dla cudzego (UX-DR9),
 *   - `redeemForSeller(sellerId, code, opts)` — WIĄŻĄCY predykat pod blokadą.
 */
type VoucherMock = {
  getForSeller: jest.Mock
  redeemForSeller: jest.Mock
}

/**
 * Buduje atrapę z jednego vouchera: `getForSeller` sam odwzorowuje regułę
 * zakresu (cudzy ⇒ `null`), więc przypadek cross-vendor nie musi jej udawać
 * ręcznie — a gdyby ktoś ją z trasy usunął, przypadek L5 nadal by ją zmierzył
 * przez `redeemForSeller`.
 */
function voucherMock(
  voucher: ReturnType<typeof makeVoucher> | null,
  redeemResult?: unknown,
): VoucherMock {
  return {
    getForSeller: jest.fn(async (sellerId: string) =>
      voucher && voucher.seller_id === sellerId ? voucher : null,
    ),
    redeemForSeller: jest.fn(async (sellerId: string) => {
      if (!voucher || voucher.seller_id !== sellerId) {
        return { status: "not_found", voucher: null }
      }
      return (
        redeemResult ?? {
          status: "redeemed",
          prior_status: voucher.status,
          voucher,
        }
      )
    }),
  }
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
  /**
   * Typ uprawnienia SPOZA obsługiwanych — jedyny tani sposób, żeby wywołać
   * `RedeemNotRedeemableError`, które NIE wynika ze stanu (review-fix cyklu 1).
   */
  entitlementType?: string
} = {}) {
  const redemptions = new Map<string, Record<string, unknown>>()
  let state = opts.entitlementState ?? "ACTIVE"
  let remaining = ENTITLEMENT_GROSS
  const entitlementCount = opts.entitlementRows ?? 1

  const entitlementRow = (index: number) => ({
    id: index === 0 ? ENTITLEMENT_ID : `${ENTITLEMENT_ID}_${index}`,
    entitlement_type: opts.entitlementType ?? "VOUCHER_AMOUNT",
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
  /**
   * `null` = ŚWIADOMY brak kontekstu sprzedawcy (kontrola negatywna L11).
   * Domyślnie obecny, bo w produkcji wypełnia go łańcuch Mercura PRZED
   * handlerem.
   */
  sellerContext?: { seller_id: string } | null
  /**
   * v1.15.0 Story 6.2 review cyklu 1 (F-4): atrapa nosnika metryk o ksztalcie
   * KLIENTA Z KONTENERA (`PosthogCaptureClient`), nie o ksztalcie portu.
   * `undefined` = klucz `posthog` nieznany (zastane zachowanie tej suity).
   */
  posthogClient?: PosthogCaptureClient | null
  /** Atrapa loggera — do pomiaru `warn` przy braku nosnika. */
  logger?: { info: unknown; warn: unknown; error: unknown }
  /** Naglowek trace'a warstwy transportowej (F-10). */
  requestId?: string
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
    seller_context:
      "sellerContext" in opts
        ? (opts.sellerContext ?? undefined)
        : { seller_id: SELLER_ID },
    headers: {
      "x-vendor-signature": sigHeader,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      ...(opts.requestId ? { "x-request-id": opts.requestId } : {}),
    },
    // KSZTALT PRODUKCYJNY, nie wygodny (review fali B5 cyklu 2, `[B5-c2][HIGH]`).
    // Medusa 2.14.2 ustawia to pole w PIERWSZYM middleware kazdego zadania:
    // `req.requestId = req.headers["x-request-id"] ?? uuid()`
    // (`@medusajs/medusa/dist/loaders/index.js:62`). Atrapa bez tego pola
    // zielenila `H2b` z powodu, ktorego produkcja nie ma — dokladnie ta sama
    // klasa co F-4 z cyklu 1 („suita, ktora nie zna klucza `posthog`, mierzy
    // trase z martwym nosnikiem"), przeniesiona na `req.requestId`.
    requestId: opts.requestId ?? randomUUID(),
    scope: {
      resolve: (key: string) => {
        if (key === "voucher") return opts.voucherService
        if (key === "gp_core")
          return {
            resolveVendorId: opts.resolveVendor ?? (async (s: string) => `vendor_for_${s}`),
          }
        // v1.15.0 Story 6.2 review cyklu 1 (F-4): klucz `posthog` istnieje w
        // kontenerze produkcyjnym (rejestruje go `loaders/posthog.ts`). Suita,
        // ktora go NIE zna, mierzy trase z martwym nosnikiem — i dokladnie
        // dlatego 9/9 zielonych nie wykrylo niezgodnosci ksztaltu sterownika.
        if (key === POSTHOG_CONTAINER_KEY) {
          if (!("posthogClient" in opts)) throw new Error("unknown key: posthog")
          return opts.posthogClient
        }
        if (key === "logger")
          return (
            opts.logger ?? { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
          )
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
    const mock = voucherMock(voucher)
    const req = makeRequest({ voucherService: mock })
    const res = makeRes()
    await lookupGET(req as never, res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { voucher: { code: string; market_id: string | null } }
    expect(body.voucher.code).toBe(VOUCHER_CODE)
    expect(body.voucher.market_id).toBe("mkt_bonbeauty")
  })

  it("L2 — returns 404 for unknown code", async () => {
    const mock = voucherMock(null)
    const req = makeRequest({ voucherService: mock })
    const res = makeRes()
    await lookupGET(req as never, res as never)
    expect(res.statusCode).toBe(404)
  })

  it("L3 — returns 404 for cross-vendor lookup (no existence leak)", async () => {
    const voucher = makeVoucher({ seller_id: OTHER_SELLER_ID })
    const mock = voucherMock(voucher)
    const req = makeRequest({ voucherService: mock })
    const res = makeRes()
    await lookupGET(req as never, res as never)
    expect(res.statusCode).toBe(404)
  })

  // v1.15.0 Story 5.8 (AC2) — bezpiecznik fail-closed. Łańcuch Mercura odrzuca
  // takie żądanie wcześniej, ale gdyby ktoś go rozmontował, handler MUSI
  // odmówić, a nie czytać `undefined` jako tożsamość.
  it("L11 — brak kontekstu sprzedawcy ⇒ 401, handler nie dotyka vouchera", async () => {
    const mock = voucherMock(makeVoucher())
    const req = makeRequest({ voucherService: mock, sellerContext: null })
    const res = makeRes()
    await lookupGET(req as never, res as never)
    expect(res.statusCode).toBe(401)
    expect(mock.getForSeller).not.toHaveBeenCalled()
  })
})

describe("cc-4 F-05 — POST /vendor/vouchers/:code/redeem", () => {
  it("L4 — returns 200 + 8-key audit envelope", async () => {
    const claimEvent = { event_type: "claimed", occurred_at: new Date("2026-05-24T10:00:00Z") }
    const voucher = makeVoucher()
    const mock = voucherMock(voucher, {
      status: "redeemed",
      prior_status: "idle",
      voucher: makeVoucher({ status: "claimed", events: [claimEvent] }),
    })
    const req = makeRequest({ voucherService: mock })
    const res = makeRes()
    await redeemPOST(req as never, res as never)
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
    const mock = voucherMock(makeVoucher())
    const req = makeRequest({ voucherService: mock, idempotencyKey: null })
    const res = makeRes()
    await redeemPOST(req as never, res as never)
    expect(res.statusCode).toBe(400)
    expect((res.body as { code: string }).code).toBe("IDEMPOTENCY_KEY_REQUIRED")
    expect(mock.getForSeller).not.toHaveBeenCalled()
    expect(mock.redeemForSeller).not.toHaveBeenCalled()
  })

  // v1.15.0 Story 5.7 (ADR-178 §2.2 M3) — wiele uprawnień na jeden kod jest
  // ODMOWĄ, nie cichym wyborem „pierwszego lepszego" wiersza.
  it("L10 — dwa uprawnienia na jeden kod ⇒ 409 ENTITLEMENT_AMBIGUOUS", async () => {
    const mock = voucherMock(makeVoucher())
    const req = makeRequest({
      voucherService: mock,
      redemptionDb: createRedemptionFakeDb({ entitlementRows: 2 }),
    })
    const res = makeRes()
    await redeemPOST(req as never, res as never)
    expect(res.statusCode).toBe(409)
    expect((res.body as { code: string }).code).toBe("ENTITLEMENT_AMBIGUOUS")
    expect(mock.redeemForSeller).not.toHaveBeenCalled()
  })

  it("L5 — returns 404 for cross-vendor redeem attempt (no state mutation)", async () => {
    const voucher = makeVoucher({ seller_id: OTHER_SELLER_ID })
    const mock = voucherMock(voucher)
    const req = makeRequest({ voucherService: mock })
    const res = makeRes()
    await redeemPOST(req as never, res as never)
    expect(res.statusCode).toBe(404)
    expect(mock.redeemForSeller).not.toHaveBeenCalled()
  })

  // v1.15.0 Story 5.7 (ADR-178 §2.2 M5): źródłem `already_claimed` jest teraz
  // `ON CONFLICT DO NOTHING` na kanonicznej — zero wstawionych wierszy ⇒ replay —
  // a nie sam `voucher.status`. Ten przypadek robi więc DWA żądania z TYM SAMYM
  // nagłówkiem przeciw TEJ SAMEJ atrapie kanonicznej, zamiast opisywać drugie
  // żądanie mockiem serwisu.
  it("L6 — drugie żądanie z tym samym Idempotency-Key ⇒ idempotent=true, already_claimed", async () => {
    const claimEvent = { event_type: "claimed", occurred_at: new Date("2026-05-24T10:00:00Z") }
    const claimedVoucher = makeVoucher({ status: "claimed", events: [claimEvent] })
    const mock = voucherMock(makeVoucher(), {
      status: "redeemed",
      prior_status: "idle",
      voucher: claimedVoucher,
    })
    const redemptionDb = createRedemptionFakeDb()

    const first = makeRes()
    await redeemPOST(
      makeRequest({ voucherService: mock, redemptionDb }) as never,
      first as never,
    )
    expect(first.statusCode).toBe(200)
    expect((first.body as { idempotent: boolean }).idempotent).toBe(false)
    expect((first.body as { outcome: string }).outcome).toBe("redeemed_now")

    const second = makeRes()
    await redeemPOST(
      makeRequest({ voucherService: mock, redemptionDb }) as never,
      second as never,
    )
    expect(second.statusCode).toBe(200)
    const body = second.body as {
      idempotent: boolean
      outcome: string
      status: string
      envelope: { new_status: string; audit_log_id: string }
    }
    expect(body.idempotent).toBe(true)
    // v1.15.0 Story 5.8 (AC6): odpowiedź niesie `already_claimed`, a KOPERTA —
    // skutek ZDARZENIA (`claimed`). Gdyby `already_claimed` siedziało w kopercie,
    // retry produkowałby INNĄ kopertę tego samego zdarzenia.
    expect(body.outcome).toBe("replayed_same_request")
    expect(body.status).toBe("already_claimed")
    expect(body.envelope.new_status).toBe("claimed")
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
    const mock = voucherMock(expiredVoucher, {
      status: "refused",
      reason: "expired",
      voucher: expiredVoucher,
    })
    const req = makeRequest({ voucherService: mock })
    const res = makeRes()
    await redeemPOST(req as never, res as never)
    expect(res.statusCode).toBe(410)
    // v1.15.0 Story 5.8 (AC7): odmowa niesie ROZRÓŻNIALNY powód, nie tylko kod.
    expect((res.body as { reason: string }).reason).toBe("expired")
  })

  // ── review-fix cyklu 1 (findings LOW) ──────────────────────────────────────

  // Odmowa warstwy uprawnienia, która ze STANEM VOUCHERA nie ma nic wspólnego
  // (tu: nieobsługiwany `entitlement_type`), NIE MOŻE dostać etykiety stanu.
  // Przed poprawką trasa łapała całą klasę `RedeemNotRedeemableError` i przy
  // voucherze `withdrawn` odpowiadała `409 VOUCHER_WITHDRAWN` — odmowa
  // poprawna, powód ZMYŚLONY, wbrew UX-DR9.
  it("L12 — odmowa nie-stanowa uprawnienia ⇒ 422 REDEMPTION_REFUSED, bez zmyślonego powodu", async () => {
    const withdrawn = makeVoucher({ status: "withdrawn" })
    const mock = voucherMock(withdrawn)
    const req = makeRequest({
      voucherService: mock,
      redemptionDb: createRedemptionFakeDb({ entitlementType: "MYSTERY_TYPE" }),
    })
    const res = makeRes()
    await redeemPOST(req as never, res as never)

    expect(res.statusCode).toBe(422)
    const body = res.body as { code: string; reason?: string }
    expect(body.code).toBe("REDEMPTION_REFUSED")
    expect(body.reason).toBeUndefined()
  })

  // Kontrola DODATNIA do L12: zawężenie nie mogło zabrać tłumaczenia tam, gdzie
  // odmowa NAPRAWDĘ wynika ze stanu uprawnienia.
  it("L13 — odmowa STANOWA uprawnienia nadal daje rozróżnialny powód stanu vouchera", async () => {
    const withdrawn = makeVoucher({ status: "withdrawn" })
    const mock = voucherMock(withdrawn)
    const req = makeRequest({
      voucherService: mock,
      redemptionDb: createRedemptionFakeDb({ entitlementState: "REDEEMED_FULL" }),
    })
    const res = makeRes()
    await redeemPOST(req as never, res as never)

    expect(res.statusCode).toBe(409)
    const body = res.body as { code: string; reason: string }
    expect(body.reason).toBe("withdrawn")
  })

  // Powtórka realizacji sprzed 5.8: zdarzenie `claimed` NIE MA
  // `payload.prior_status`, bo zapisywał je stary `claim()`. Koperta replayu
  // musi wtedy powiedzieć „nie wiem" (`null`), a nie podstawić stan BIEŻĄCY —
  // podstawienie produkowało kopertę INNĄ niż przy pierwszym żądaniu, czyli
  // dokładnie defekt, przed którym to pole miało chronić.
  it("L14 — replay danych sprzed 5.8 zwraca prior_status=null, nie stan bieżący", async () => {
    const legacyClaimEvent = {
      event_type: "claimed",
      occurred_at: new Date("2026-05-24T10:00:00Z"),
    }
    const claimedVoucher = makeVoucher({
      status: "claimed",
      events: [legacyClaimEvent],
    })
    const mock = voucherMock(claimedVoucher, {
      status: "redeemed",
      prior_status: null,
      voucher: claimedVoucher,
    })
    const redemptionDb = createRedemptionFakeDb()

    const first = makeRes()
    await redeemPOST(
      makeRequest({ voucherService: mock, redemptionDb }) as never,
      first as never,
    )
    expect(first.statusCode).toBe(200)

    const second = makeRes()
    await redeemPOST(
      makeRequest({ voucherService: mock, redemptionDb }) as never,
      second as never,
    )
    expect(second.statusCode).toBe(200)
    const body = second.body as {
      idempotent: boolean
      envelope: { prior_status: string | null }
    }
    expect(body.idempotent).toBe(true)
    expect(body.envelope.prior_status).toBeNull()
  })

  // v1.15.0 Story 2.6 cykl 1 (finding HIGH #1) — kontrola, która PĘKA po zepsuciu
  // nowego mechanizmu: bez rynku sprzedawcy trasa MUSI odmówić głośno. Cichy
  // przebieg dałby pod FORCE RLS `getByCode → null`, czyli komunikat „voucher nie
  // istnieje" przy voucherze, który istnieje — najgorszy możliwy wariant na
  // ścieżce realizacji.
  it("L8 — sprzedawca BEZ zadeklarowanego rynku dostaje 409, nie ciche 404", async () => {
    const voucher = makeVoucher()
    const mock = voucherMock(voucher)
    const req = makeRequest({ voucherService: mock, sellerMarketId: null })
    const res = makeRes()
    await redeemPOST(req as never, res as never)
    expect(res.statusCode).toBe(409)
    expect((res.body as { code: string }).code).toBe("MARKET_CONTEXT_REQUIRED")
    // Odmowa jest PRZED dotknięciem vouchera — żadnego odczytu ani mutacji.
    expect(mock.getForSeller).not.toHaveBeenCalled()
    expect(mock.redeemForSeller).not.toHaveBeenCalled()
  })
})

/**
 * v1.15.0 Story 6.2 — WPIECIE nosnika NFR-11 w trase (review cyklu 1, F-1..F-5).
 *
 * Dlaczego ta suita musiala powstac: pakiet nosnika byl zielony, bo podawal
 * atrape o ksztalcie PORTU wymyslonego w tej story. Kontener rejestruje klienta
 * o INNYM ksztalcie (`PosthogCaptureClient`, jeden obiekt z `distinctId`), wiec
 * na realnej trasie nie powstawala ani jedna seria. Kazdy przypadek nizej pyta
 * „czy nosnik ODPALA", a nie „czy nosnik ISTNIEJE".
 */
describe("Story 6.2 — wpiecie nosnika NFR-11 w POST /vendor/vouchers/:code/redeem", () => {
  const savedMeasurementEnv: Record<string, string | undefined> = {}

  /** Atrapa o ksztalcie KLIENTA Z KONTENERA, nie o ksztalcie portu. */
  function makePosthogClient() {
    const calls: Array<{
      distinctId: string
      event: string
      properties?: Record<string, unknown>
    }> = []
    const client: PosthogCaptureClient = {
      capture: (args) => calls.push(args),
    }
    return { client, calls }
  }

  beforeEach(() => {
    savedMeasurementEnv.GP_ENV = process.env.GP_ENV
    savedMeasurementEnv.GP_INSTANCE_ID = process.env.GP_INSTANCE_ID
    process.env.GP_ENV = "dev"
    process.env.GP_INSTANCE_ID = "gp-dev-unit"
    __resetHotPathWarnStateForTests()
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedMeasurementEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  function successMock() {
    const claimEvent = {
      event_type: "claimed",
      occurred_at: new Date("2026-05-24T10:00:00Z"),
    }
    return voucherMock(makeVoucher(), {
      status: "redeemed",
      prior_status: "idle",
      voucher: makeVoucher({ status: "claimed", events: [claimEvent] }),
    })
  }

  // KONTROLA MUTANTA F-1: usuniecie adaptera `createRedemptionPosthogSink`
  // z trasy sprawia, ze klient dostaje `capture("gp.voucher_redemption.attempt",
  // {...})`, czyli string zamiast obiektu komunikatu — `event` jest wtedy
  // `undefined`, a `distinctId` nie istnieje. Ten przypadek czerwieni sie
  // na obu asercjach.
  it("H1 — udana realizacja emituje TRZY serie do klienta z kontenera", async () => {
    const { client, calls } = makePosthogClient()
    const req = makeRequest({
      voucherService: successMock(),
      posthogClient: client,
      requestId: "trace-abc-123",
    })
    const res = makeRes()

    await redeemPOST(req as never, res as never)

    expect(res.statusCode).toBe(200)
    expect(calls.map((c) => c.event)).toEqual([
      REDEMPTION_ATTEMPT_EVENT,
      REDEMPTION_SUCCESS_EVENT,
      REDEMPTION_DURATION_EVENT,
    ])
    for (const call of calls) {
      expect(call.distinctId).toEqual(expect.any(String))
      expect(call.distinctId.length).toBeGreaterThan(0)
      // Komplet etykiet AD-25 na KAZDEJ serii.
      expect(call.properties).toEqual(
        expect.objectContaining({
          env: "dev",
          instance_id: "gp-dev-unit",
          market_id: expect.any(String),
          actor_id: expect.any(String),
          // F-10: `request_id` pochodzi z warstwy TRANSPORTOWEJ, a klucz
          // idempotencji jedzie jako OSOBNA etykieta.
          request_id: "trace-abc-123",
          idempotency_key: "panel-unit-key-0001",
          http_status: 200,
          outcome: "pass",
        }),
      )
    }
    expect(calls[2]?.properties?.duration_ms).toEqual(expect.any(Number))
  })

  // F-10: brak naglowka trace'a NIE degraduje etykiety do stalej „unknown" —
  // identyfikator losowy przynajmniej rozdziela zadania.
  it("H2 — bez naglowka trace'a request_id jest wygenerowany, nie „unknown\"", async () => {
    const { client, calls } = makePosthogClient()
    const req = makeRequest({ voucherService: successMock(), posthogClient: client })
    const res = makeRes()

    await redeemPOST(req as never, res as never)

    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]?.distinctId).toEqual(expect.any(String))
    expect(calls[0]?.properties?.request_id).not.toBe("unknown")
    expect(String(calls[0]?.properties?.request_id).length).toBeGreaterThan(8)
  })

  // TEST-THE-TEST fali B5 (`[B5][security][MEDIUM]`): naglowek `x-request-id`
  // jest wejsciem KLIENTA, a bramka PII nosnika skanuje klucze, nie wartosci.
  // Przed poprawka ten przypadek byl ZIELONY z adresem e-mail na telemetrii —
  // czyli fix bylby nieodrozninalny od jego braku.
  it("H2b — `x-request-id` z adresem e-mail NIE trafia na telemetrie", async () => {
    const { client, calls } = makePosthogClient()
    const req = makeRequest({
      voucherService: successMock(),
      posthogClient: client,
      requestId: "jan.kowalski@example.com",
    })
    const res = makeRes()

    await redeemPOST(req as never, res as never)

    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      const requestId = String(call.properties?.request_id)
      expect(requestId).not.toBe("jan.kowalski@example.com")
      expect(requestId).not.toContain("@")
      expect(requestId).not.toContain("example.com")
      // Zejscie do zrodla SERWEROWEGO, nie przyciecie wartosci klienta.
      expect(requestId).toMatch(/^[A-Za-z0-9._:-]{8,200}$/)
    }
    // Cala emisja musi byc nienaruszona — odrzucenie naglowka nie moze
    // zabijac pomiaru (odmowa jest po stronie ETYKIETY, nie serii).
    expect(calls).toHaveLength(3)
  })

  // KONTROLA fali B5 cyklu 2 (`[B5-c2][HIGH]`): EMISJA NIE MOZE ZALEZEC OD
  // TEGO, CO KLIENT PRZYSLE W NAGLOWKU. Cykl 2 zostawil sciezke, na ktorej
  // dowolna wartosc spoza ksztaltu wracala fallbackiem przez `req.requestId`,
  // rzucala bramka wartosci na nosniku przy PIERWSZYM `capture` i kasowala
  // WSZYSTKIE TRZY serie NFR-11 — takze dla wartosci bez cienia PII
  // (zmierzone: legalny `trace/abc 123` dawal 0 serii zamiast 3).
  //
  // Ten przypadek zamiata realna trase, nie sam resolver: sterownikiem jest
  // `redeemPOST`, a atrapa ma ksztalt produkcyjny (`req.requestId` ustawione
  // tak, jak robi to loader Medusy). Mutant przywracajacy
  // `if (typeof framework === "string" && framework.length > 0) return framework`
  // czerwieni go na kazdej pozycji listy.
  it.each([
    ["adres e-mail", "jan.kowalski@example.com"],
    ["legalny trace ze spacja i ukosnikiem", "trace/abc 123"],
    ["telefon z prefiksem", "+48 600 100 200"],
    ["wartosc krotsza niz minimum ksztaltu", "abc"],
    ["pusty naglowek", ""],
    ["wartosc dluzsza niz 200 znakow", "a".repeat(201)],
    ["znaki sterujace", "trace\n\tinjected"],
  ])(
    "H2c — `x-request-id` (%s) NIE kasuje emisji NFR-11: nadal TRZY serie",
    async (_label, hostile) => {
      const { client, calls } = makePosthogClient()
      const req = makeRequest({
        voucherService: successMock(),
        posthogClient: client,
        requestId: hostile,
      })
      // Kanal, ktorym wartosc wracala: loader Medusy przepisuje naglowek na
      // `req.requestId` BEZ walidacji, wiec atrapa musi go niesc doslownie.
      ;(req as unknown as { requestId: string }).requestId = hostile
      const res = makeRes()

      await redeemPOST(req as never, res as never)

      expect(res.statusCode).toBe(200)
      expect(calls).toHaveLength(3)
      for (const call of calls) {
        const requestId = String(call.properties?.request_id)
        expect(requestId).not.toBe(hostile)
        expect(requestId).toMatch(/^[A-Za-z0-9._:-]{8,200}$/)
      }
    },
  )

  // KONTROLA PRZECIWNA do H2c — bramka nie moze byc „zawsze odrzucajaca":
  // wartosc zgodna z ksztaltem, podana WYLACZNIE przez `req.requestId`
  // (czyli kanalem loadera, bez wlasnego naglowka w atrapie), musi przejsc
  // na nosnik doslownie. Bez tego H2c bylby zielony takze dla implementacji
  // `return randomUUID()` bez zadnego czytania wejscia.
  it("H2d — zgodne z ksztaltem `req.requestId` przechodzi doslownie", async () => {
    const { client, calls } = makePosthogClient()
    const req = makeRequest({ voucherService: successMock(), posthogClient: client })
    ;(req as unknown as { requestId: string }).requestId = "medusa-trace-0007"
    const res = makeRes()

    await redeemPOST(req as never, res as never)

    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.properties?.request_id).toBe("medusa-trace-0007")
    }
  })

  // KONTROLA fali B5 cyklu 3 (`[B5-c3][correctness][LOW]`): STALA BYLA
  // CHRONIONA, UZYCIE NIE. Mutant zdejmujacy test ksztaltu w
  // `readIdempotencyKeyHeader` (`return trimmed.length > 0 ? trimmed : null`)
  // zostawial CALY pakiet story zielony — `IDEMPOTENCY_KEY_SHAPE` pilnowaly
  // wylacznie kontrole `request_id` (wspoldzielona stala), a zadna kontrola nie
  // pilnowala obu wywolan tej funkcji: bramki 400 na wejsciu trasy
  // (`route.ts:461`) ani etykiety `idempotency_key` na nosniku (`route.ts:344`).
  // Zastane przypadki dotykaly wylacznie BRAKU naglowka (L9, H4), nigdy
  // naglowka WADLIWEGO.
  //
  // Sterownikiem jest `redeemPOST`, nie sama funkcja — pytanie brzmi „czy
  // odpala na realnej trasie", nie „czy istnieje".
  it.each([
    ["adres e-mail", "jan.kowalski@example.com"],
    ["klucz ze spacjami", "panel key 0001"],
    ["telefon z prefiksem", "+48 600 100 200"],
    ["wartosc krotsza niz minimum ksztaltu", "abc"],
    ["wartosc dluzsza niz 200 znakow", "a".repeat(201)],
    ["znaki sterujace", "panel\nkey\t0001"],
  ])(
    "H2e — wadliwy `Idempotency-Key` (%s) ⇒ 400 i BRAK wartosci klienta na nosniku",
    async (_label, hostile) => {
      const { client, calls } = makePosthogClient()
      const req = makeRequest({
        voucherService: successMock(),
        posthogClient: client,
        idempotencyKey: hostile,
      })
      const res = makeRes()

      await redeemPOST(req as never, res as never)

      // Uzycie 1 — bramka wejscia: naglowek spoza ksztaltu jest ODMOWA,
      // dokladnie jak jego brak (ADR-178 §2.2 M4 pkt 2).
      expect(res.statusCode).toBe(400)
      expect((res.body as { code: string }).code).toBe("IDEMPOTENCY_KEY_REQUIRED")
      // Uzycie 2 — etykieta nosnika: emisja zyje, a wartosc klienta na nia
      // nie wchodzi (inaczej bramka wartosci wywrocilaby CALA emisje).
      const attempt = calls.find((c) => c.event === REDEMPTION_ATTEMPT_EVENT)
      expect(attempt?.properties?.idempotency_key).toBeNull()
      for (const call of calls) {
        expect(call.properties?.idempotency_key).not.toBe(hostile)
      }
      expect(calls.length).toBeGreaterThan(0)
    },
  )

  // KONTROLA PRZECIWNA do H2e — bramka nie moze byc „zawsze odrzucajaca":
  // klucz zgodny z ksztaltem musi przejsc trase i trafic na nosnik DOSLOWNIE.
  // Bez tego H2e bylby zielony takze dla implementacji `return null`.
  it("H2f — zgodny `Idempotency-Key` przechodzi trase i laduje na nosniku doslownie", async () => {
    const { client, calls } = makePosthogClient()
    const req = makeRequest({
      voucherService: successMock(),
      posthogClient: client,
      idempotencyKey: "panel-unit-key-9999",
    })
    const res = makeRes()

    await redeemPOST(req as never, res as never)

    expect(res.statusCode).toBe(200)
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.properties?.idempotency_key).toBe("panel-unit-key-9999")
    }
  })

  // KONTROLA PRZECIWNA F-2: wyjatek z handlera nie moze byc liczony jako sukces.
  // Przed poprawka `res.statusCode` mial domyslne 200 (status ustawia middleware
  // bledow Medusy PO naszym `finally`), wiec ta sciezka emitowala serie `success`.
  it("H3 — wyjatek z handlera ⇒ BRAK serii success, status 500 w metryce", async () => {
    const { client, calls } = makePosthogClient()
    const boom = new Error("awaria nizej w stosie")
    const mock = voucherMock(makeVoucher())
    mock.getForSeller = jest.fn(async () => {
      throw boom
    })
    const req = makeRequest({ voucherService: mock, posthogClient: client })
    const res = makeRes()

    await expect(redeemPOST(req as never, res as never)).rejects.toThrow(boom)

    const names = calls.map((c) => c.event)
    expect(names).toContain(REDEMPTION_ATTEMPT_EVENT)
    expect(names).toContain(REDEMPTION_DURATION_EVENT)
    expect(names).not.toContain(REDEMPTION_SUCCESS_EVENT)
    expect(calls[0]?.properties?.http_status).toBe(500)
    expect(calls[0]?.properties?.outcome).toBe("fail")
    expect(calls[0]?.properties?.refusal_code).toBe(HOT_PATH_UNHANDLED_REFUSAL_CODE)
  })

  // F-5: kod odmowy ma PRODUCENTA — pochodzi z ciala odpowiedzi, ktore trasa
  // i tak wysyla. Przed poprawka etykieta byla zawsze `null`.
  it("H4 — odmowa niesie refusal_code z ciala odpowiedzi", async () => {
    const { client, calls } = makePosthogClient()
    const req = makeRequest({
      voucherService: voucherMock(makeVoucher()),
      posthogClient: client,
      idempotencyKey: null,
    })
    const res = makeRes()

    await redeemPOST(req as never, res as never)

    expect(res.statusCode).toBe(400)
    const attempt = calls.find((c) => c.event === REDEMPTION_ATTEMPT_EVENT)
    expect(attempt?.properties?.refusal_code).toBe("IDEMPOTENCY_KEY_REQUIRED")
    expect(attempt?.properties?.http_status).toBe(400)
    expect(attempt?.properties?.idempotency_key).toBeNull()
    expect(calls.map((c) => c.event)).not.toContain(REDEMPTION_SUCCESS_EVENT)
  })

  // F-3: brak nosnika jest GLOSNY. Brak serii jest nieodrozniallny od braku
  // ruchu, wiec cisza nie jest dopuszczalnym zachowaniem.
  it("H5 — brak klienta w kontenerze zostawia warn, nie cisze", async () => {
    const warn = jest.fn()
    const req = makeRequest({
      voucherService: successMock(),
      posthogClient: null,
      logger: { info: jest.fn(), warn, error: jest.fn() },
    })
    const res = makeRes()

    await redeemPOST(req as never, res as never)

    expect(res.statusCode).toBe(200)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain("redemption-hot-path")
  })

  // F-3: porazka emisji (tu: brak kontekstu pomiaru AD-25) tez zostawia slad,
  // a realizacja vouchera przebiega bez zmian.
  it("H6 — brak kontekstu AD-25 ⇒ warn + realizacja nienaruszona", async () => {
    delete process.env.GP_INSTANCE_ID
    const warn = jest.fn()
    const { client, calls } = makePosthogClient()
    const req = makeRequest({
      voucherService: successMock(),
      posthogClient: client,
      logger: { info: jest.fn(), warn, error: jest.fn() },
    })
    const res = makeRes()

    await redeemPOST(req as never, res as never)

    expect(res.statusCode).toBe(200)
    expect(calls).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain("NFR-11")
  })
})
