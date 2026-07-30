/**
 * link-resolution-chain.test.ts — Story 5.1 AC4 (v1.14.0) — regresja realnego
 * defektu z 2026-07-28: opłacony zakup bez vouchera.
 *
 * ── Co ten test faktycznie dowodzi ──────────────────────────────────────────
 * Prowadzi PEŁNY łańcuch przez PRAWDZIWY kod produkcyjny:
 *
 *   POST /webhooks/stripe/payment-intent   (route.ts, bez podmian)
 *     → resolvePaymentIntentLink            (rozwiązanie po linku, bez podmian)
 *     → buildPaymentIntentSucceededEnvelope (walidacja kontraktu 3.1, bez podmian)
 *     → reserveWebhookDelivery              (idempotencja transportu)
 *     → liveIssueEntitlementsWithinTx       (rdzeń issuance, bez podmian)
 *
 * Wejście jest DOKŁADNIE takie jak w zmierzonym incydencie: metadata
 * PaymentIntenta niesie WYŁĄCZNIE `session_id`, a powiązanie z zamówieniem
 * istnieje tylko w bazie. Przed naprawą ten sam wejściowy fakt kończył się
 * HTTP 400 i zerem entitlementów.
 *
 * ── Gdzie leży granica wiarygodności (nie udajemy, że jej nie ma) ───────────
 * Podstawiony jest WYŁĄCZNIE silnik SQL: `makeFixturePg` odwzorowuje semantykę
 * `ON CONFLICT DO NOTHING` i zwraca wiersze na podstawie fixture'ów, ale nie
 * wykonuje realnego SQL-a — więc NIE wykryje literówki w nazwie kolumny ani
 * dryfu schematu. Ta klasa jest pokryta osobno:
 *   - `stripe-payment-intent-link.integration.test.ts` — uruchamia TE SAME
 *     stałe SQL na żywej bazie (opt-in, read-only),
 *   - dowód końcowy AC4 — realny zakup + `stripe events resend` na żywym stacku.
 * Routing zapytań jest po TOŻSAMOŚCI eksportowanych stałych SQL, nie po
 * przepisanym tekście — zmiana zapytania w kodzie zrywa ten test, zamiast go
 * cicho ominąć.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals"
import { createHmac } from "node:crypto"

// Wariant A (stempel metadata w Stripe) jest best-effort i sięga do sieci —
// w teście łańcucha jest zaślepiony, żeby dowód dotyczył ścieżki GŁÓWNEJ (B).
jest.mock("../../../../../lib/payment/stripe-payment-intent-metadata-stamp", () => ({
  stampPaymentIntentOrderFacts: jest.fn(async () => true),
}))

import { LINK_UNRESOLVED_RETRY_WINDOW_SECONDS, POST } from "../route"
import { STRIPE_SIGNATURE_HEADER } from "../helpers"
import { PAYMENT_INTENT_SUCCEEDED_EVENT } from "../../../../../lib/payment/stripe-payment-intent-event"
import {
  RESOLVE_ORDER_BY_PAYMENT_LINK_SQL,
  RESOLVE_ORDER_MARKET_CONTEXT_SQL,
} from "../../../../../lib/payment/stripe-payment-intent-link"
import {
  RELEASE_WEBHOOK_DELIVERY_SQL,
  RESERVE_WEBHOOK_DELIVERY_SQL,
  STRIPE_PATH_Y_WEBHOOK_PROVIDER,
} from "../../../../../lib/payment/stripe-payment-intent-transport"
import {
  liveIssueEntitlementsWithinTx,
  type LiveIssuePgClient,
} from "../../../../../workflows/entitlements/live-issue-from-payment-intent"
import { EntitlementInstanceState } from "../../../../../modules/voucher/models/entitlement"
import { Modules } from "@medusajs/framework/utils"

const SECRET = "whsec_test_chain"

// Fakty z realnego incydentu (2026-07-28) — celowo te same identyfikatory.
const PAYMENT_INTENT_ID = "pi_3TyCqiHG9Rf5NslT0vAfkVtW"
const SESSION_ID = "payses_01KYMN5FP0FK3A2GTAH45PDM7J"
const ORDER_ID = "order_01KYMN7XQX06FKHSWFT0QV2NNY"
const EVENT_ID = "evt_3TyCqiHG9Rf5NslT0RO3zuTc"
const SALES_CHANNEL_ID = "sc_bonbeauty"
const MARKET_ID = "bonbeauty"

type OrderFixture = {
  order_id: string
  metadata: Record<string, unknown> | null
  sales_channel_id: string | null
  sales_channel_market_id: string | null
}

type FixtureOptions = {
  /** Powiązanie payment_session → order; pusta lista = brak linku. */
  linkedOrderIds?: string[]
  order?: OrderFixture | null
  orders?: OrderFixture[]
  lines?: Array<{ line_item_id: string; metadata: Record<string, unknown> | null }>
  linesByOrder?: Record<
    string,
    Array<{ line_item_id: string; metadata: Record<string, unknown> | null }>
  >
}

/**
 * Fixture PG obsługujący ZARÓWNO zapytania route'u (link + rezerwacja dostawy),
 * JAK I zapytania rdzenia issuance — jeden magazyn, żeby idempotencja obu warstw
 * była obserwowalna w jednym przebiegu.
 */
function makeFixturePg(options: FixtureOptions = {}) {
  const linkedOrderIds = options.linkedOrderIds ?? [ORDER_ID]
  const defaultOrder =
    options.order === undefined
      ? {
          order_id: ORDER_ID,
          metadata: null,
          sales_channel_id: SALES_CHANNEL_ID,
          sales_channel_market_id: MARKET_ID,
        }
      : options.order
  const orders = options.orders ?? (defaultOrder ? [defaultOrder] : [])
  const lines = options.lines ?? [
    {
      line_item_id: "li_voucher_1",
      metadata: {
        entitlement_profile_id: "voucher-rezerwacja-otwarta",
        entitlement_type: "VOUCHER_SERVICE",
        policy: { validity_months: 12, vat_rate_uniqueness: true },
      },
    },
  ]

  const webhookDeliveries = new Map<string, unknown>()
  const eventProcessed = new Set<string>()
  const entitlements = new Map<string, Record<string, unknown>>()

  const client: LiveIssuePgClient = {
    query: async <T = Record<string, unknown>>(
      sql: string,
      values: ReadonlyArray<unknown> = []
    ): Promise<{ rows: T[]; rowCount: number }> => {
      // ── route: powiązanie płatność → zamówienie ──────────────────────────
      if (sql === RESOLVE_ORDER_BY_PAYMENT_LINK_SQL) {
        const rows = linkedOrderIds.map((id) => ({ order_id: id }))
        return { rows: rows as unknown as T[], rowCount: rows.length }
      }
      if (sql === RESOLVE_ORDER_MARKET_CONTEXT_SQL) {
        const order = orders.find((candidate) => candidate.order_id === values[0])
        if (!order) return { rows: [], rowCount: 0 }
        return {
          rows: [
            {
              order_id: order.order_id,
              order_metadata: order.metadata,
              sales_channel_id: order.sales_channel_id,
              sales_channel_market_id: order.sales_channel_market_id,
            },
          ] as unknown as T[],
          rowCount: 1,
        }
      }
      // ── route: idempotencja transportu (ON CONFLICT DO NOTHING) ──────────
      if (sql === RESERVE_WEBHOOK_DELIVERY_SQL) {
        const key = `${values[0]}|${values[1]}`
        if (webhookDeliveries.has(key)) return { rows: [], rowCount: 0 }
        webhookDeliveries.set(key, values[3])
        return { rows: [], rowCount: 1 }
      }
      if (sql === RELEASE_WEBHOOK_DELIVERY_SQL) {
        const key = `${values[0]}|${values[1]}`
        const existed = webhookDeliveries.delete(key)
        return { rows: [], rowCount: existed ? 1 : 0 }
      }
      // ── rdzeń issuance ───────────────────────────────────────────────────
      if (/INSERT INTO event_processed/i.test(sql)) {
        const key = `${values[0]}|${values[1]}`
        if (eventProcessed.has(key)) return { rows: [], rowCount: 0 }
        eventProcessed.add(key)
        return { rows: [], rowCount: 1 }
      }
      if (/FROM "order"\s/i.test(sql)) {
        const order = orders.find((candidate) => candidate.order_id === values[0])
        if (!order) return { rows: [], rowCount: 0 }
        return {
          rows: [
            { sales_channel_id: order.sales_channel_id, metadata: order.metadata },
          ] as unknown as T[],
          rowCount: 1,
        }
      }
      if (/FROM order_item/i.test(sql)) {
        const orderLines = options.linesByOrder?.[String(values[0])] ?? lines
        const databaseRows = orderLines.map((line) => ({ ...line, line_unit_price: 25000 }))
        return { rows: databaseRows as unknown as T[], rowCount: databaseRows.length }
      }
      if (/INSERT INTO entitlement_instance/i.test(sql)) {
        const dedupeKey = values[11] as string
        if (entitlements.has(dedupeKey)) return { rows: [], rowCount: 0 }
        entitlements.set(dedupeKey, {
          id: values[0],
          order_id: values[3],
          line_item_id: values[4],
          state: values[5],
          market_id: values[7],
          sales_channel_id: values[8],
        })
        return { rows: [{ id: values[0] }] as unknown as T[], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  }

  return { client, webhookDeliveries, eventProcessed, entitlements }
}

type FakeRes = {
  statusCode: number
  body: Record<string, unknown>
  status: (code: number) => FakeRes
  json: (body: unknown) => void
}

function makeRes(): FakeRes {
  return {
    statusCode: 0,
    body: {},
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = (body ?? {}) as Record<string, unknown>
    },
  }
}

/** Zdarzenie Stripe DOKŁADNIE jak w incydencie: metadata tylko z `session_id`. */
function incidentEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    type: "payment_intent.succeeded",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: PAYMENT_INTENT_ID,
        amount: 25000,
        amount_received: 25000,
        currency: "pln",
        created: Math.floor(Date.now() / 1000),
        metadata: { session_id: SESSION_ID },
        ...overrides,
      },
    },
  }
}

function signedHeader(rawBody: string, secret = SECRET): string {
  const ts = Math.floor(Date.now() / 1000)
  const sig = createHmac("sha256", secret)
    .update(Buffer.from(`${ts}.${rawBody}`))
    .digest("hex")
  return `t=${ts},v1=${sig}`
}

function makeReq(
  event: unknown,
  pg: { client: LiveIssuePgClient },
  emitBehaviour: "ok" | "throw" = "ok"
) {
  const raw = JSON.stringify(event)
  const emitted: { name: string; data: unknown }[] = []
  const req = {
    rawBody: Buffer.from(raw, "utf8"),
    headers: { [STRIPE_SIGNATURE_HEADER]: signedHeader(raw) },
    scope: {
      resolve: (key: string) => {
        if (key === "logger") return { info() {}, warn() {}, error() {} }
        if (key === "__pg_pool__") {
          return { connect: async () => ({ ...pg.client, release: () => {} }) }
        }
        if (key === Modules.EVENT_BUS) {
          return {
            emit: async (e: { name: string; data: unknown }) => {
              if (emitBehaviour === "throw") throw new Error("event bus down")
              emitted.push(e)
            },
          }
        }
        throw new Error(`unresolved ${key}`)
      },
    },
  }
  return { req, emitted }
}

async function post(req: unknown): Promise<FakeRes> {
  const res = makeRes()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await POST(req as any, res as any)
  return res
}

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET
})

describe("Story 5.1 AC4 — łańcuch webhook → envelope → issuance na realnym wejściu", () => {
  it("metadata TYLKO z session_id + link w bazie ⇒ envelope zbudowany i entitlement ISSUED", async () => {
    const pg = makeFixturePg()
    const { req, emitted } = makeReq(incidentEvent(), pg)

    const res = await post(req)

    // 1. Webhook przyjęty i wyemitowany — przed naprawą było tu 400.
    expect(res.statusCode).toBe(200)
    expect(res.body.emitted).toBe(PAYMENT_INTENT_SUCCEEDED_EVENT)
    expect(emitted).toHaveLength(1)

    // 2. Koperta niesie fakty rozwiązane z linku, zgodnie z kontraktem 3.1.
    const envelope = emitted[0].data as {
      scope: { market_id: string }
      payload: { order_id: string; payment_intent_id: string; amount_minor: number }
    }
    expect(envelope.payload.order_id).toBe(ORDER_ID)
    expect(envelope.payload.payment_intent_id).toBe(PAYMENT_INTENT_ID)
    expect(envelope.payload.amount_minor).toBe(25000)
    expect(envelope.scope.market_id).toBe(MARKET_ID)

    // 3. Warstwa transportowa odnotowana (AC4: webhook_event_processed > 0).
    expect(pg.webhookDeliveries.size).toBe(1)
    expect([...pg.webhookDeliveries.keys()][0]).toBe(
      `${EVENT_ID}|${STRIPE_PATH_Y_WEBHOOK_PROVIDER}`
    )

    // 4. Rdzeń issuance konsumuje TĘ kopertę i wystawia ISSUED.
    const issued = await liveIssueEntitlementsWithinTx(
      pg.client,
      {
        event_type: PAYMENT_INTENT_SUCCEEDED_EVENT,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scope: (envelope as any).scope,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: (envelope as any).payload,
      },
      new Date("2026-07-28T12:00:00.000Z")
    )
    expect(issued.event_processed).toBe(true)
    expect(issued.issued).toHaveLength(1)
    const row = [...pg.entitlements.values()][0]
    expect(row.state).toBe(EntitlementInstanceState.ISSUED)
    expect(row.order_id).toBe(ORDER_ID)
    expect(row.market_id).toBe(MARKET_ID)
    expect(row.sales_channel_id).toBe(SALES_CHANNEL_ID)
  })

  it("metadata z order_id ale BEZ market_id ⇒ rynek dobrany z kontekstu zamówienia", async () => {
    const pg = makeFixturePg({ linkedOrderIds: [] }) // link celowo pusty
    const { req, emitted } = makeReq(
      incidentEvent({ metadata: { session_id: SESSION_ID, order_id: ORDER_ID } }),
      pg
    )

    const res = await post(req)

    // Brak linku nie przeszkadza — order_id przyszedł z metadata, brakowało
    // wyłącznie rynku, a ten pochodzi z kontekstu zamówienia.
    expect(res.statusCode).toBe(200)
    const envelope = emitted[0].data as {
      scope: { market_id: string }
      payload: { order_id: string }
    }
    expect(envelope.payload.order_id).toBe(ORDER_ID)
    expect(envelope.scope.market_id).toBe(MARKET_ID)
  })

  it("market_id z order.metadata ma pierwszeństwo spójne z rdzeniem issuance", async () => {
    const pg = makeFixturePg({
      order: {
        order_id: ORDER_ID,
        metadata: { gp: { market_id: MARKET_ID } },
        sales_channel_id: SALES_CHANNEL_ID,
        sales_channel_market_id: MARKET_ID,
      },
    })
    const { req, emitted } = makeReq(incidentEvent(), pg)

    expect((await post(req)).statusCode).toBe(200)
    expect(
      (emitted[0].data as { scope: { market_id: string } }).scope.market_id
    ).toBe(MARKET_ID)
  })
})

describe("Story 5.1 AC4 — rozłączne klasy odrzucenia (zero emisji, czytelny powód)", () => {
  it("brak linku ⇒ 503 link_unresolved, zero emisji i retry Stripe", async () => {
    const pg = makeFixturePg({ linkedOrderIds: [] })
    const { req, emitted } = makeReq(incidentEvent(), pg)

    const res = await post(req)

    expect(res.statusCode).toBe(503)
    expect(res.body.type).toBe("unresolved_link")
    expect(res.body.reason).toBe("link_unresolved")
    expect(emitted).toHaveLength(0)
    expect(pg.webhookDeliveries.size).toBe(0)
  })

  it("stary link_unresolved kończy retry Stripe terminalnym 400", async () => {
    const pg = makeFixturePg({ linkedOrderIds: [] })
    // UWAGA: `incidentEvent(overrides)` rozlewa nadpisania do `data.object`, czyli
    // ustawia czas utworzenia PaymentIntenta. Bezpiecznik mierzy natomiast WIEK
    // ZDARZENIA (`stripeEvent.created`) — to dwie różne rzeczy. Nadpisanie musi
    // więc trafić na POZIOM ZDARZENIA, inaczej test sprawdza pole, którego route
    // nie czyta, i przechodzi/failuje z niewłaściwego powodu.
    const { req, emitted } = makeReq(
      {
        ...incidentEvent(),
        created: Math.floor(Date.now() / 1000) - LINK_UNRESOLVED_RETRY_WINDOW_SECONDS - 1,
      },
      pg,
    )

    const res = await post(req)

    expect(res.statusCode).toBe(400)
    expect(res.body.reason).toBe("link_unresolved")
    expect(emitted).toHaveLength(0)
    expect(pg.webhookDeliveries.size).toBe(0)
  })

  it("jedna payment_collection z dwoma zamówieniami ⇒ dwie koperty i vouchery dla obu", async () => {
    const secondOrderId = "order_drugi_seller"
    const secondSalesChannelId = "sc_drugi_seller"
    const pg = makeFixturePg({
      linkedOrderIds: [ORDER_ID, secondOrderId],
      orders: [
        {
          order_id: ORDER_ID,
          metadata: null,
          sales_channel_id: SALES_CHANNEL_ID,
          sales_channel_market_id: MARKET_ID,
        },
        {
          order_id: secondOrderId,
          metadata: null,
          sales_channel_id: secondSalesChannelId,
          sales_channel_market_id: MARKET_ID,
        },
      ],
      linesByOrder: {
        [ORDER_ID]: [
          {
            line_item_id: "li_seller_1",
            metadata: {
              entitlement_profile_id: "voucher-seller-1",
              entitlement_type: "VOUCHER_SERVICE",
              policy: { validity_months: 12, vat_rate_uniqueness: true },
            },
          },
        ],
        [secondOrderId]: [
          {
            line_item_id: "li_seller_2",
            metadata: {
              entitlement_profile_id: "voucher-seller-2",
              entitlement_type: "VOUCHER_SERVICE",
              policy: { validity_months: 12, vat_rate_uniqueness: true },
            },
          },
        ],
      },
    })
    const { req, emitted } = makeReq(incidentEvent(), pg)

    const res = await post(req)

    expect(res.statusCode).toBe(200)
    expect(res.body.emitted_count).toBe(2)
    expect(res.body.order_ids).toEqual([ORDER_ID, secondOrderId].sort())
    expect(emitted).toHaveLength(2)
    expect(
      emitted.map(
        (delivery) =>
          (delivery.data as { payload: { order_id: string } }).payload.order_id
      )
    ).toEqual([ORDER_ID, secondOrderId].sort())

    for (const delivery of emitted) {
      const envelope = delivery.data as {
        scope: { market_id: string }
        payload: Parameters<typeof liveIssueEntitlementsWithinTx>[1]["payload"]
      }
      await liveIssueEntitlementsWithinTx(
        pg.client,
        {
          event_type: PAYMENT_INTENT_SUCCEEDED_EVENT,
          scope: envelope.scope,
          payload: envelope.payload,
        },
        new Date("2026-07-28T12:00:00.000Z")
      )
    }

    expect(pg.entitlements.size).toBe(2)
    expect(
      [...pg.entitlements.values()].map((row) => row.order_id).sort()
    ).toEqual([ORDER_ID, secondOrderId].sort())
  })

  it("metadata jednego zamówienia NIE ucina batcha z linku", async () => {
    const secondOrderId = "order_metadata_nie_ucina"
    const pg = makeFixturePg({
      linkedOrderIds: [ORDER_ID, secondOrderId],
      orders: [
        { order_id: ORDER_ID, metadata: null, sales_channel_id: SALES_CHANNEL_ID, sales_channel_market_id: MARKET_ID },
        { order_id: secondOrderId, metadata: null, sales_channel_id: "sc_2", sales_channel_market_id: MARKET_ID },
      ],
    })
    const { req, emitted } = makeReq(
      incidentEvent({ metadata: { session_id: SESSION_ID, order_id: ORDER_ID, market_id: MARKET_ID } }),
      pg
    )

    const res = await post(req)

    expect(res.statusCode).toBe(200)
    expect(res.body.emitted_count).toBe(2)
    expect(emitted).toHaveLength(2)
  })

  it("link wskazuje zamówienia z różnych rynków ⇒ 400 link_ambiguous", async () => {
    const pg = makeFixturePg({
      linkedOrderIds: [ORDER_ID, "order_inny_rynek"],
      orders: [
        {
          order_id: ORDER_ID,
          metadata: null,
          sales_channel_id: SALES_CHANNEL_ID,
          sales_channel_market_id: MARKET_ID,
        },
        {
          order_id: "order_inny_rynek",
          metadata: null,
          sales_channel_id: "sc_inny_rynek",
          sales_channel_market_id: "inny-rynek",
        },
      ],
    })
    const { req, emitted } = makeReq(incidentEvent(), pg)

    const res = await post(req)

    expect(res.statusCode).toBe(400)
    expect(res.body.reason).toBe("link_ambiguous")
    expect(emitted).toHaveLength(0)
  })

  it("zamówienie nie istnieje ⇒ 400 order_not_found (inna klasa niż brak linku)", async () => {
    const pg = makeFixturePg({ order: null })
    const { req, emitted } = makeReq(incidentEvent(), pg)

    const res = await post(req)

    expect(res.statusCode).toBe(400)
    expect(res.body.reason).toBe("order_not_found")
    expect(emitted).toHaveLength(0)
  })

  it("rynku nie da się przypisać ⇒ 400 market_unresolved, BEZ podstawiania domyślnego", async () => {
    const pg = makeFixturePg({
      order: {
        order_id: ORDER_ID,
        metadata: null,
        sales_channel_id: SALES_CHANNEL_ID,
        sales_channel_market_id: null,
      },
    })
    const { req, emitted } = makeReq(incidentEvent(), pg)

    const res = await post(req)

    expect(res.statusCode).toBe(400)
    expect(res.body.reason).toBe("market_unresolved")
    expect(emitted).toHaveLength(0)
    // Kluczowe: nigdzie nie pojawia się rynek domyślny.
    expect(JSON.stringify(res.body)).not.toContain("gp_default")
  })

  it("sprzeczne przypisania rynku ⇒ 400 market_ambiguous (cicha podmiana byłaby gorsza)", async () => {
    const pg = makeFixturePg({
      order: {
        order_id: ORDER_ID,
        metadata: { gp: { market_id: "bonbeauty" } },
        sales_channel_id: SALES_CHANNEL_ID,
        sales_channel_market_id: "inny-rynek",
      },
    })
    const { req, emitted } = makeReq(incidentEvent(), pg)

    const res = await post(req)

    expect(res.statusCode).toBe(400)
    expect(res.body.reason).toBe("market_ambiguous")
    expect(emitted).toHaveLength(0)
  })

  it("zły podpis ⇒ 400 invalid_signature i baza NIE jest pytana", async () => {
    const pg = makeFixturePg()
    const raw = JSON.stringify(incidentEvent())
    const { req, emitted } = makeReq(incidentEvent(), pg)
    ;(req as { headers: Record<string, string> }).headers[STRIPE_SIGNATURE_HEADER] =
      signedHeader(raw, "zly_sekret")

    const res = await post(req)

    expect(res.statusCode).toBe(400)
    expect(res.body.type).toBe("invalid_signature")
    expect(emitted).toHaveLength(0)
    expect(pg.webhookDeliveries.size).toBe(0)
  })
})

describe("Story 5.1 AC4 — idempotencja obu warstw po naprawie", () => {
  it("ponowna dostawa TEGO SAMEGO zdarzenia ⇒ 200 duplicate, druga emisja NIE zachodzi", async () => {
    const pg = makeFixturePg()

    const first = await post(makeReq(incidentEvent(), pg).req)
    expect(first.statusCode).toBe(200)

    const second = makeReq(incidentEvent(), pg)
    const res = await post(second.req)

    expect(res.statusCode).toBe(200)
    expect(res.body.duplicate).toBe(true)
    expect(res.body.reason).toBe("delivery_already_processed")
    expect(second.emitted).toHaveLength(0)
    expect(pg.webhookDeliveries.size).toBe(1)
  })

  it("DWA różne evt_ dla tego samego PI ⇒ dwie emisje, ale JEDEN entitlement", async () => {
    const pg = makeFixturePg()
    const now = new Date("2026-07-28T12:00:00.000Z")

    const a = makeReq(incidentEvent(), pg)
    await post(a.req)
    const b = makeReq({ ...incidentEvent(), id: "evt_inny_pakiet" }, pg)
    await post(b.req)

    // Warstwa transportowa ich nie łączy (różne event_id) — i słusznie.
    expect(a.emitted).toHaveLength(1)
    expect(b.emitted).toHaveLength(1)
    expect(pg.webhookDeliveries.size).toBe(2)

    // Warstwa issuance (klucz = payment_intent_id + order_id) dopuszcza tylko
    // jedno wydanie dla tego zamówienia.
    for (const delivery of [a, b]) {
      const envelope = delivery.emitted[0].data as Record<string, unknown>
      await liveIssueEntitlementsWithinTx(
        pg.client,
        {
          event_type: PAYMENT_INTENT_SUCCEEDED_EVENT,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          scope: (envelope as any).scope,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          payload: (envelope as any).payload,
        },
        now
      )
    }
    expect(pg.entitlements.size).toBe(1)
  })

  it("awaria emisji ⇒ 500 i ZWOLNIONA rezerwacja (ponowienie Stripe wciąż działa)", async () => {
    const pg = makeFixturePg()

    const failing = makeReq(incidentEvent(), pg, "throw")
    const res = await post(failing.req)
    expect(res.statusCode).toBe(500)
    expect(res.body.type).toBe("emit_failed")
    // Rezerwacja skompensowana — inaczej ponowienie zostałoby wyciszone na zawsze.
    expect(pg.webhookDeliveries.size).toBe(0)

    const retry = makeReq(incidentEvent(), pg)
    expect((await post(retry.req)).statusCode).toBe(200)
    expect(retry.emitted).toHaveLength(1)
  })
})
