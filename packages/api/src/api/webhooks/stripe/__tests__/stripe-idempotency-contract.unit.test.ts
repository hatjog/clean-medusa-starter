/**
 * stripe-idempotency-contract.unit.test.ts — Story 3.1 AC2 (v1.16.0, Epic 3).
 *
 * KONTRAKT DWÓCH POZIOMÓW KLUCZA (AD-47; ADR-166, ADR-190):
 *   poziom 1 — klucz dostawy `(event.id, provider)` w `webhook_event_processed`;
 *   poziom 2 — klucz jednostki należnej `payment_intent_id:order_id` w
 *              `event_processed` (po JEDNEJ na KAŻDE zamówienie order-setu).
 *
 * Test mierzy kontrakt na REALNYM route Path Y (fake PG, bez sieci) i na czystych
 * funkcjach z `lib/payment/stripe-webhook-barrier-contract.ts`. Kontrole
 * negatywne pokazują, DLACZEGO klucz ma taki kształt: klucz z `session_id`
 * przepuszcza podwójne przetworzenie tej samej dostawy, a klucz „po PI" bez
 * `order_id` zlewa N jednostek w jedną (drugie zamówienie zostaje bez vouchera).
 *
 * Lustro dla ludzi: `evidence/3-1/idempotency-key-contract.json` (super-repo).
 * To śledzony dowód wydania, więc jego brak jest błędem bramki także w
 * samodzielnym checkoutcie submodułu — nie wolno zmieniać go w `skip`.
 */
import { describe, it, expect, jest } from "@jest/globals"
import { createHmac } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

jest.mock("../../../../lib/payment/stripe-payment-intent-metadata-stamp", () => ({
  stampPaymentIntentOrderFacts: jest.fn(async () => true),
}))

import { POST } from "../payment-intent/route"
import { STRIPE_SIGNATURE_HEADER } from "../payment-intent/helpers"
import { PAYMENT_INTENT_SUCCEEDED_EVENT } from "../../../../lib/payment/stripe-payment-intent-event"
import { buildPaymentIntentOrderExternalId } from "../../../../workflows/entitlements/live-issue-from-payment-intent"
import { buildEntitlementDedupeKey } from "../../../../modules/voucher/models/entitlement-dedupe"
import {
  buildOwedBusinessUnitKey,
  buildOwedBusinessUnits,
  buildTransportEventKey,
  STRIPE_NATIVE_WEBHOOK_PROVIDER,
  STRIPE_PATH_Y_WEBHOOK_PROVIDER,
  WEBHOOK_DELIVERY_BARRIER_TABLE,
} from "../../../../lib/payment/stripe-webhook-barrier-contract"
import { Modules } from "@medusajs/framework/utils"

const SECRET = "whsec_contract_3_1"
const PI = "pi_3_1_contract"
const ORDER_A = "order_3_1_a"
const ORDER_B = "order_3_1_b"

function signedHeader(rawBody: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", secret).update(Buffer.from(`${ts}.${rawBody}`)).digest("hex")
  return `t=${ts},v1=${sig}`
}

function stripeEvent(eventId: unknown, sessionId: string) {
  return {
    id: eventId,
    type: "payment_intent.succeeded",
    created: 1_790_000_000,
    data: {
      object: {
        id: PI,
        amount: 42000,
        amount_received: 42000,
        currency: "pln",
        created: 1_790_000_000,
        metadata: { session_id: sessionId },
      },
    },
  }
}

type FakeRes = { statusCode: number; body: unknown; status: (c: number) => FakeRes; json: (b: unknown) => void }
function makeRes(): FakeRes {
  return {
    statusCode: 0,
    body: undefined,
    status(c) {
      this.statusCode = c
      return this
    },
    json(b) {
      this.body = b
    },
  }
}

/**
 * Wspólny „PG" dla wielu dostaw: rezerwacje poziomu 1 żyją między wywołaniami,
 * żeby druga dostawa widziała pierwszą. Rejestr kompensacji jest pusty.
 */
function makeWorld(orderIds: string[]) {
  const reservations = new Map<string, { event_id: string; provider: string; market_id: string | null }>()
  const reserveInserts: unknown[][] = []
  const client = {
    query: async (sql: string, values: ReadonlyArray<unknown> = []) => {
      if (new RegExp(`INSERT INTO ${WEBHOOK_DELIVERY_BARRIER_TABLE}`, "i").test(sql)) {
        reserveInserts.push([...values])
        const key = `${values[0]}|${values[1]}`
        if (reservations.has(key)) return { rows: [], rowCount: 0 }
        reservations.set(key, {
          event_id: String(values[0]),
          provider: String(values[1]),
          market_id: (values[2] as string | null) ?? null,
        })
        return { rows: [], rowCount: 1 }
      }
      if (/FROM money_path_compensation_failure/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/FROM payment_session/i.test(sql)) {
        return { rows: orderIds.map((id) => ({ order_id: id })), rowCount: orderIds.length }
      }
      if (/AS order_id/i.test(sql) && /sales_channel/i.test(sql)) {
        return {
          rows: orderIds.map((id) => ({
            order_id: id,
            order_metadata: { gp: { market_id: "bonbeauty" } },
            sales_channel_id: "sc_bonbeauty",
            sales_channel_market_id: "bonbeauty",
          })),
          rowCount: orderIds.length,
        }
      }
      return { rows: [], rowCount: 0 }
    },
    release: () => {},
  }
  const emitted: { name: string; data: unknown }[] = []
  async function deliver(event: ReturnType<typeof stripeEvent>) {
    const rawBody = JSON.stringify(event)
    const req = {
      rawBody: Buffer.from(rawBody, "utf8"),
      headers: { [STRIPE_SIGNATURE_HEADER]: signedHeader(rawBody) },
      scope: {
        resolve: (key: string) => {
          if (key === "logger") return { info() {}, warn() {}, error() {} }
          if (key === "__pg_pool__") return { connect: async () => client }
          if (key === Modules.EVENT_BUS) {
            return { emit: async (e: { name: string; data: unknown }) => emitted.push(e) }
          }
          throw new Error(`unresolved ${key}`)
        },
      },
    }
    const res = makeRes()
    const before = emitted.length
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(req as any, res as any)
    return { res, emitted: emitted.slice(before) }
  }
  return { deliver, reservations, reserveInserts, emitted }
}

type Envelope = {
  idempotency_key: string
  correlation_id: string
  causation_id: string
  payload: { payment_intent_id: string; order_id: string; amount_minor: number }
  scope: { market_id: string }
}

describe("Story 3.1 AC2 — poziom 1: klucz dostawy = (event.id, provider), NIE session/route", () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET
  })

  it("rezerwacja poziomu 1 dostaje DOKŁADNIE event.id i provider Path Y (nie payment_intent.id, nie session_id)", async () => {
    const world = makeWorld([ORDER_A, ORDER_B])
    const { res } = await world.deliver(stripeEvent("evt_l1_a", "payses_1"))
    expect(res.statusCode).toBe(200)
    expect(world.reserveInserts).toHaveLength(1)
    const [eventId, provider] = world.reserveInserts[0]
    expect(eventId).toBe("evt_l1_a")
    expect(provider).toBe(STRIPE_PATH_Y_WEBHOOK_PROVIDER)
    expect(eventId).not.toBe(PI)
    expect(eventId).not.toBe("payses_1")
    expect(buildTransportEventKey({ stripe_event_id: "evt_l1_a", provider: STRIPE_PATH_Y_WEBHOOK_PROVIDER })).toEqual({
      event_id: "evt_l1_a",
      provider: STRIPE_PATH_Y_WEBHOOK_PROVIDER,
    })
  })

  it("ta sama dostawa (event.id) z ROTOWANYM session_id ⇒ duplikat poziomu 1, zero emisji", async () => {
    const world = makeWorld([ORDER_A, ORDER_B])
    const first = await world.deliver(stripeEvent("evt_l1_same", "payses_1"))
    const second = await world.deliver(stripeEvent("evt_l1_same", "payses_ROTATED"))
    expect(first.res.statusCode).toBe(200)
    expect(first.emitted).toHaveLength(2)
    expect(second.res.statusCode).toBe(200)
    expect((second.res.body as { duplicate?: boolean }).duplicate).toBe(true)
    expect(second.emitted).toHaveLength(0)
    expect(world.reservations.size).toBe(1)
  })

  it("INNY event.id dla TEGO SAMEGO PI/session ⇒ poziom 1 przepuszcza (to poziom 2 broni voucherów)", async () => {
    const world = makeWorld([ORDER_A, ORDER_B])
    const first = await world.deliver(stripeEvent("evt_l1_x", "payses_1"))
    const second = await world.deliver(stripeEvent("evt_l1_y", "payses_1"))
    expect(first.emitted).toHaveLength(2)
    expect(second.emitted).toHaveLength(2)
    expect(world.reservations.size).toBe(2)
    // Poziom 2 dla obu dostaw daje TE SAME jednostki — dedupe `event_processed`
    // (INSERT … ON CONFLICT DO NOTHING) zjada drugą kopię po stronie konsumenta.
    const unitsOf = (rows: { data: unknown }[]) =>
      rows
        .map((e) => e.data as Envelope)
        .map((env) => buildOwedBusinessUnitKey({ payment_intent_id: env.payload.payment_intent_id, order_id: env.payload.order_id }))
        .sort()
    expect(unitsOf(first.emitted)).toEqual(unitsOf(second.emitted))
  })

  it("provider spoza inwentarza tras jest odrzucany (klucz nie może powstać poza dwiema przestrzeniami)", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildTransportEventKey({ stripe_event_id: "evt_x", provider: "stripe-alias" as any })
    ).toThrow(/spoza inwentarza/)
    expect(() => buildTransportEventKey({ stripe_event_id: "  ", provider: STRIPE_NATIVE_WEBHOOK_PROVIDER })).toThrow(
      /event\.id wymagany/
    )
  })

  it("brak Stripe event.id ⇒ 400 przed rezerwacją i emisją; PI nie staje się fallbackiem event_key", async () => {
    const world = makeWorld([ORDER_A, ORDER_B])
    const eventWithoutId = stripeEvent("evt_will_be_removed", "payses_1") as { id?: string }
    delete eventWithoutId.id

    const { res, emitted } = await world.deliver(eventWithoutId as ReturnType<typeof stripeEvent>)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ type: "invalid", reason: "stripe_event_id_missing" })
    expect(world.reserveInserts).toEqual([])
    expect(emitted).toEqual([])
  })

  it.each([0, { id: "evt_nested" }, " evt_l1_whitespace "])(
    "niekanoniczny event.id %p ⇒ 400 przed rezerwacją i emisją",
    async (eventId) => {
      const world = makeWorld([ORDER_A, ORDER_B])

      const { res, emitted } = await world.deliver(stripeEvent(eventId, "payses_1"))

      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ type: "invalid", reason: "stripe_event_id_invalid" })
      expect(world.reserveInserts).toEqual([])
      expect(emitted).toEqual([])
    }
  )
})

describe("Story 3.1 AC2 — poziom 2: jednostka należna = payment_intent_id:order_id, po jednej na zamówienie", () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET
  })

  it("1 PI → 2 zamówienia ⇒ 2 koperty, 2 różne idempotency_key, 2 różne jednostki; amount_minor = CAŁE PI na każdej (ADR-166)", async () => {
    const world = makeWorld([ORDER_A, ORDER_B])
    const { res, emitted } = await world.deliver(stripeEvent("evt_l2", "payses_1"))
    expect(res.statusCode).toBe(200)
    const envelopes = emitted.map((e) => e.data as Envelope)
    expect(emitted.every((e) => e.name === PAYMENT_INTENT_SUCCEEDED_EVENT)).toBe(true)
    expect(envelopes.map((e) => e.payload.order_id).sort()).toEqual([ORDER_A, ORDER_B])
    expect(new Set(envelopes.map((e) => e.idempotency_key)).size).toBe(2)
    expect(new Set(envelopes.map((e) => e.correlation_id))).toEqual(new Set([PI]))
    expect(new Set(envelopes.map((e) => e.causation_id))).toEqual(new Set(["stripe:webhook:evt_l2"]))
    // ADR-166 §6: kwota na kopercie to kwota PaymentIntenta, NIE podział per zamówienie.
    expect(envelopes.map((e) => e.payload.amount_minor)).toEqual([42000, 42000])

    const units = buildOwedBusinessUnits({ payment_intent_id: PI, order_ids: [ORDER_A, ORDER_B] })
    expect(units).toEqual([`${PI}:${ORDER_A}`, `${PI}:${ORDER_B}`])
    // Ten sam kształt, którym konsument pisze `event_processed.external_id`.
    expect(units).toEqual(
      [ORDER_A, ORDER_B].map((o) => buildPaymentIntentOrderExternalId(PI, o)).sort()
    )
  })

  it("klucz per-entitlement (linia × recipient) leży PONIŻEJ jednostki i jej nie zastępuje", () => {
    const unit = buildOwedBusinessUnitKey({ payment_intent_id: PI, order_id: ORDER_A })
    const perEntitlement = [0, 1].map((idx) => buildEntitlementDedupeKey(PI, "li_1", idx))
    expect(new Set(perEntitlement).size).toBe(2)
    expect(perEntitlement.every((k) => k !== unit)).toBe(true)
    // Jednostka NIE zależy od liczby linii/recipientów: jedno zamówienie = jedna jednostka.
    expect(buildOwedBusinessUnits({ payment_intent_id: PI, order_ids: [ORDER_A, ORDER_A] })).toEqual([unit])
  })

  it("pusty składnik jest błędem, nie pustym kluczem", () => {
    expect(() => buildOwedBusinessUnitKey({ payment_intent_id: "", order_id: ORDER_A })).toThrow(/payment_intent_id/)
    expect(() => buildOwedBusinessUnitKey({ payment_intent_id: PI, order_id: " " })).toThrow(/order_id/)
    expect(() => buildOwedBusinessUnits({ payment_intent_id: PI, order_ids: [] })).toThrow(/brak zamówień/)
  })
})

describe("Story 3.1 AC2 — kontrole negatywne: kształty klucza, które kontrakt ODRZUCA", () => {
  const rotatedSessionDeliveries = [
    { event_id: "evt_same", session_id: "payses_1", route: "/webhooks/stripe/payment-intent" },
    { event_id: "evt_same", session_id: "payses_2", route: "/webhooks/stripe/payment-intent" },
  ]

  it("MUTANT: klucz z session_id — ta sama dostawa z rotowaną sesją dostaje DWA klucze (podwójne przetworzenie)", () => {
    const mutantKey = (d: { session_id: string }) => `${STRIPE_PATH_Y_WEBHOOK_PROVIDER}|${d.session_id}`
    const canonical = (d: { event_id: string }) =>
      JSON.stringify(buildTransportEventKey({ stripe_event_id: d.event_id, provider: STRIPE_PATH_Y_WEBHOOK_PROVIDER }))
    expect(new Set(rotatedSessionDeliveries.map(mutantKey)).size).toBe(2)
    expect(new Set(rotatedSessionDeliveries.map(canonical)).size).toBe(1)
  })

  it("MUTANT: klucz z aliasem trasy — ten sam event.id pod dwiema nazwami trasy rozjeżdża się na dwa klucze", () => {
    const aliases = ["/webhooks/stripe/payment-intent", "/webhooks/stripe/payment-intent/"]
    const mutantKey = (route: string) => `${route}|evt_same`
    const canonical = () =>
      JSON.stringify(buildTransportEventKey({ stripe_event_id: "evt_same", provider: STRIPE_PATH_Y_WEBHOOK_PROVIDER }))
    expect(new Set(aliases.map(mutantKey)).size).toBe(2)
    expect(new Set(aliases.map(canonical)).size).toBe(1)
  })

  it("MUTANT: jednostka 'po PI' bez order_id — 2 zamówienia zlewają się w 1 jednostkę (drugie bez vouchera)", () => {
    const mutantUnits = new Set([ORDER_A, ORDER_B].map(() => PI))
    const canonical = buildOwedBusinessUnits({ payment_intent_id: PI, order_ids: [ORDER_A, ORDER_B] })
    expect(mutantUnits.size).toBe(1)
    expect(canonical).toHaveLength(2)
  })
})

// ── Lustro w super-repo (evidence/3-1/idempotency-key-contract.json) ─────────

function findMirror(): string | null {
  let dir = __dirname
  for (let i = 0; i < 12; i += 1) {
    const candidate = path.join(
      dir,
      "_bmad-output/releases/v1.16.0/implementation-artifacts/evidence/3-1/idempotency-key-contract.json"
    )
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const MIRROR = findMirror()

describe("Story 3.1 AC2 — lustro kontraktu w evidence/3-1 (dryf = FAIL)", () => {
  it("idempotency-key-contract.json jest wymaganym lustrem i zgadza się z kontraktem w kodzie", () => {
    expect(MIRROR).not.toBeNull()
    if (!MIRROR) {
      throw new Error(
        "Brak wymaganego evidence/3-1/idempotency-key-contract.json: uruchom test z worktree GP zawierającego artefakt wydania"
      )
    }
    const mirror = JSON.parse(readFileSync(MIRROR, "utf8")) as {
      code_of_record: { contract_module: string; mirror_gate: string }
      levels: {
        transport: {
          level: number
          table: string
          key_columns: string[]
          event_id_source: string
          providers: Record<string, string>
          required_target: string
        }
        owed_business_unit: {
          level: number
          table: string
          key_columns: string[]
          key_shape: string
          required_target: string
          correlation_column: string
          cardinality: string
          amount_rule: string
          example: { payment_intent_id: string; order_ids: string[]; units: string[] }
        }
        below_unit: { table: string; builder: string; role: string }
      }
      rejected_key_shapes: Array<{ mutant: string; why_rejected: string; test: string }>
    }
    expect(mirror.code_of_record.contract_module).toBe(
      "GP/backend/packages/api/src/lib/payment/stripe-webhook-barrier-contract.ts"
    )
    expect(mirror.code_of_record.mirror_gate).toContain("stripe-idempotency-contract.unit.test.ts")
    expect(mirror.levels.transport).toEqual(
      expect.objectContaining({
        level: 1,
        table: WEBHOOK_DELIVERY_BARRIER_TABLE,
        key_columns: ["event_id", "provider"],
      })
    )
    expect(mirror.levels.transport.event_id_source).toContain("Stripe event.id")
    expect(mirror.levels.transport.event_id_source).toContain("NIE payment_intent.id")
    expect(mirror.levels.transport.required_target).toContain("DW-15-225")
    expect(mirror.levels.transport.providers).toEqual({
      "/hooks/payment/stripe": STRIPE_NATIVE_WEBHOOK_PROVIDER,
      "/webhooks/stripe/payment-intent": STRIPE_PATH_Y_WEBHOOK_PROVIDER,
    })
    const owed = mirror.levels.owed_business_unit
    expect(owed).toEqual(
      expect.objectContaining({
        level: 2,
        table: "event_processed",
        key_columns: ["external_id", "event_type"],
        key_shape: "OBSERWOWANY stan runtime: payment_intent_id:order_id",
      })
    )
    expect(owed.required_target).toContain("DW-15-225")
    expect(owed.correlation_column).toContain("purchase_key = payment_intent_id")
    expect(owed.cardinality).toContain("1 PaymentIntent -> N zamowien")
    expect(owed.amount_rule).toContain("pelna kwota PaymentIntenta")
    const ex = owed.example
    expect(ex.units).toEqual(buildOwedBusinessUnits({ payment_intent_id: ex.payment_intent_id, order_ids: ex.order_ids }))
    expect(mirror.levels.below_unit).toEqual(
      expect.objectContaining({
        table: "entitlement_instance",
        builder: "buildEntitlementDedupeKey(payment_intent_id, line_item_id, recipient_index)",
      })
    )
    expect(mirror.levels.below_unit.role).toContain("NIE jest jednostka ACK")
    expect(mirror.rejected_key_shapes.map((entry) => entry.mutant)).toEqual([
      "klucz z session_id",
      "klucz z aliasem trasy",
      "brak Stripe event.id zastapiony payment_intent_id",
      "jednostka 'po PI' bez order_id",
    ])
    expect(mirror.rejected_key_shapes.every((entry) => entry.why_rejected && entry.test)).toBe(true)
  })
})
