/**
 * owed-unit-ack-contract.unit.test.ts — Story 3.1 AC3 (v1.16.0, Epic 3; AD-47).
 *
 * KONTRAKT „ACK vs JEDNOSTKI NALEŻNE": `200` wolno odpowiedzieć Stripe'owi
 * WYŁĄCZNIE, gdy KAŻDA jednostka `payment_intent_id:order_id` z tej dostawy jest
 * rozliczona (`PASS`). Brak choć jednej (`FAIL`) albo nieznany stan (`UNKNOWN`)
 * MUSI zachować ponowienie (nie-2xx). Werdykt liczy się ZBIORAMI jednostek, nie
 * licznikiem — kontrola negatywna pokazuje, że licznik dałby fałszywe `PASS`.
 *
 * DRUGA CZĘŚĆ PLIKU TO DOWÓD LUKI, nie jej akceptacja: dzisiejsza gałąź
 * `!reserved` route'u Path Y odpowiada `200 duplicate` bez patrzenia na poziom 2.
 * Test mierzy ROZBIEŻNOŚĆ między werdyktem kontraktu a odpowiedzią route'u; gdy
 * Stories 3.2–3.6 wepną kontrakt w route, ten blok MA PĘKNĄĆ — wtedy usuwa się
 * blok „LUKA", a zostaje kontrakt. Nie należy „naprawiać" go zmianą oczekiwań.
 *
 * Lustro dla ludzi: `evidence/3-1/owed-unit-ack-contract.json` (super-repo);
 * ten sam scenariusz na realnym PostgreSQL:
 * `__tests__/integration/stripe-payment-intent-owed-unit-ack-pg.integration.test.ts`.
 */
import { describe, it, expect, jest } from "@jest/globals"
import { createHmac } from "node:crypto"

jest.mock("../../../../../lib/payment/stripe-payment-intent-metadata-stamp", () => ({
  stampPaymentIntentOrderFacts: jest.fn(async () => true),
}))

import { POST } from "../route"
import { STRIPE_SIGNATURE_HEADER } from "../helpers"
import {
  ackStatusForVerdict,
  buildOwedBusinessUnits,
  evaluateOwedUnitAck,
  isAckAllowed,
  OWED_UNIT_ACK_HTTP_STATUS,
  WEBHOOK_DELIVERY_BARRIER_TABLE,
} from "../../../../../lib/payment/stripe-webhook-barrier-contract"
import { Modules } from "@medusajs/framework/utils"

const PI = "pi_3_1_ack"
const ORDER_A = "order_3_1_ack_a"
const ORDER_B = "order_3_1_ack_b"
const UNIT_A = `${PI}:${ORDER_A}`
const UNIT_B = `${PI}:${ORDER_B}`

describe("Story 3.1 AC3 — werdykt ACK liczony zbiorami jednostek należnych", () => {
  const owed = buildOwedBusinessUnits({ payment_intent_id: PI, order_ids: [ORDER_A, ORDER_B] })

  it("komplet jednostek rozliczonych ⇒ PASS, 200, ACK dozwolony", () => {
    const v = evaluateOwedUnitAck({ owed_units: owed, settled_units: [UNIT_B, UNIT_A] })
    expect(v.verdict).toBe("PASS")
    expect(v.missing_units).toEqual([])
    expect(v.unexpected_units).toEqual([])
    expect(ackStatusForVerdict(v.verdict)).toBe(200)
    expect(isAckAllowed(v.verdict)).toBe(true)
  })

  it("brak JEDNEJ jednostki ⇒ FAIL z nazwą braku, nie-2xx, ACK zabroniony", () => {
    const v = evaluateOwedUnitAck({ owed_units: owed, settled_units: [UNIT_A] })
    expect(v.verdict).toBe("FAIL")
    expect(v.missing_units).toEqual([UNIT_B])
    expect(ackStatusForVerdict(v.verdict)).toBeGreaterThanOrEqual(500)
    expect(isAckAllowed(v.verdict)).toBe(false)
  })

  it("stan nieznany (odczyt padł) ⇒ UNKNOWN, nie-2xx — ACK przy nieznanym stanie jest zabroniony", () => {
    const v = evaluateOwedUnitAck({ owed_units: owed, settled_units: null })
    expect(v.verdict).toBe("UNKNOWN")
    expect(v.missing_units).toEqual(owed)
    expect(isAckAllowed(v.verdict)).toBe(false)
    expect(ackStatusForVerdict(v.verdict)).toBeGreaterThanOrEqual(500)
  })

  it("MUTANT licznika: 1 brak + 1 nadmiar dają równe liczności, a werdykt i tak FAIL (zbiory, nie count)", () => {
    const foreign = `${PI}:order_obcy`
    const v = evaluateOwedUnitAck({ owed_units: owed, settled_units: [UNIT_A, foreign] })
    expect(v.settled_units).toHaveLength(v.owed_units.length) // licznik „się zgadza"
    expect(v.verdict).toBe("FAIL")
    expect(v.missing_units).toEqual([UNIT_B])
    expect(v.unexpected_units).toEqual([foreign])
  })

  it("obca jednostka przy kompletnym zbiorze należnym ⇒ FAIL, nie 200 ACK", () => {
    const foreign = `${PI}:order_obcy`
    const v = evaluateOwedUnitAck({ owed_units: owed, settled_units: [...owed, foreign] })
    expect(v.missing_units).toEqual([])
    expect(v.unexpected_units).toEqual([foreign])
    expect(v.verdict).toBe("FAIL")
    expect(ackStatusForVerdict(v.verdict)).toBeGreaterThanOrEqual(500)
    expect(isAckAllowed(v.verdict)).toBe(false)
  })

  it("MUTANT mapowania: żaden werdykt poza PASS nie może mapować się na 2xx", () => {
    for (const [verdict, status] of Object.entries(OWED_UNIT_ACK_HTTP_STATUS)) {
      if (verdict === "PASS") expect(status).toBe(200)
      else expect(status >= 200 && status < 300).toBe(false)
    }
    expect(Object.isFrozen(OWED_UNIT_ACK_HTTP_STATUS)).toBe(true)
  })

  it("pusty zbiór należności nie ma werdyktu (błąd, nie PASS)", () => {
    expect(() => evaluateOwedUnitAck({ owed_units: [], settled_units: [] })).toThrow(/pusty zbiór/)
  })
})

// ── LUKA AC3 na realnym route Path Y (fake PG) ───────────────────────────────

const SECRET = "whsec_ack_3_1"

function signedHeader(rawBody: string, ts = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", SECRET).update(Buffer.from(`${ts}.${rawBody}`)).digest("hex")
  return `t=${ts},v1=${sig}`
}

function stripeEvent(eventId: string) {
  return {
    id: eventId,
    type: "payment_intent.succeeded",
    created: 1_790_000_100,
    data: {
      object: {
        id: PI,
        amount: 30000,
        amount_received: 30000,
        currency: "pln",
        created: 1_790_000_100,
        metadata: { session_id: "payses_ack" },
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
 * Świat z dwoma poziomami: rezerwacje poziomu 1 (route) i „konsument", który
 * rozlicza jednostki poziomu 2 na żądanie testu — tak jak w produkcji, gdzie
 * emit tylko kolejkuje, a subscriber pracuje osobno i może paść na jednej
 * z N kopert.
 */
function makeWorld() {
  const reservations = new Set<string>()
  const settled = new Set<string>()
  const queue: { name: string; data: { payload: { payment_intent_id: string; order_id: string } } }[] = []
  const client = {
    query: async (sql: string, values: ReadonlyArray<unknown> = []) => {
      if (new RegExp(`INSERT INTO ${WEBHOOK_DELIVERY_BARRIER_TABLE}`, "i").test(sql)) {
        const key = `${values[0]}|${values[1]}`
        if (reservations.has(key)) return { rows: [], rowCount: 0 }
        reservations.add(key)
        return { rows: [], rowCount: 1 }
      }
      if (/FROM money_path_compensation_failure/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/FROM payment_session/i.test(sql)) {
        return { rows: [{ order_id: ORDER_A }, { order_id: ORDER_B }], rowCount: 2 }
      }
      if (/AS order_id/i.test(sql) && /sales_channel/i.test(sql)) {
        return {
          rows: [ORDER_A, ORDER_B].map((id) => ({
            order_id: id,
            order_metadata: { gp: { market_id: "bonbeauty" } },
            sales_channel_id: "sc_bonbeauty",
            sales_channel_market_id: "bonbeauty",
          })),
          rowCount: 2,
        }
      }
      return { rows: [], rowCount: 0 }
    },
    release: () => {},
  }
  async function deliver(eventId: string) {
    const rawBody = JSON.stringify(stripeEvent(eventId))
    const req = {
      rawBody: Buffer.from(rawBody, "utf8"),
      headers: { [STRIPE_SIGNATURE_HEADER]: signedHeader(rawBody) },
      scope: {
        resolve: (key: string) => {
          if (key === "logger") return { info() {}, warn() {}, error() {} }
          if (key === "__pg_pool__") return { connect: async () => client }
          if (key === Modules.EVENT_BUS) {
            return { emit: async (e: (typeof queue)[number]) => queue.push(e) }
          }
          throw new Error(`unresolved ${key}`)
        },
      },
    }
    const res = makeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(req as any, res as any)
    return res
  }
  /** Konsument rozlicza tylko koperty dla wskazanych zamówień; reszta „pada". */
  function consume(onlyOrders: string[]) {
    for (const e of queue.splice(0)) {
      if (onlyOrders.includes(e.data.payload.order_id)) {
        settled.add(`${e.data.payload.payment_intent_id}:${e.data.payload.order_id}`)
      }
    }
  }
  return { deliver, consume, settled, queue }
}

describe("Story 3.1 AC3 — LUKA (zamyka 3.2–3.6): route ACK-uje ponowienie mimo brakującej jednostki", () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET
  })

  it("po częściowej konsumpcji kontrakt mówi FAIL, a route odpowiada 200 duplicate — rozbieżność jest mierzalna", async () => {
    const world = makeWorld()
    const owed = buildOwedBusinessUnits({ payment_intent_id: PI, order_ids: [ORDER_A, ORDER_B] })

    // Dostawa 1: rezerwacja + 2 koperty w kolejce; route ACK-uje (emit = kolejkowanie).
    const first = await world.deliver("evt_ack_1")
    expect(first.statusCode).toBe(200)
    expect(world.queue).toHaveLength(2)

    // Konsument rozlicza TYLKO zamówienie A (B pada / ginie w kolejce).
    world.consume([ORDER_A])
    const afterPartial = evaluateOwedUnitAck({ owed_units: owed, settled_units: [...world.settled] })
    expect(afterPartial.verdict).toBe("FAIL")
    expect(afterPartial.missing_units).toEqual([UNIT_B])

    // Dostawa 2 (ponowienie Stripe, ten sam event.id): kontrakt żąda nie-2xx…
    const retry = await world.deliver("evt_ack_1")
    expect(world.queue).toHaveLength(0) // …i route faktycznie NIC nie re-emituje…
    // …ale odpowiada 200 duplicate — to jest LUKA. Asercja mierzy rozbieżność,
    // nie akceptuje jej: gdy route zacznie honorować kontrakt, ta linia pęknie.
    expect(retry.statusCode).toBe(200)
    expect((retry.body as { duplicate?: boolean }).duplicate).toBe(true)
    expect(retry.statusCode).not.toBe(ackStatusForVerdict(afterPartial.verdict))
    // Jednostka B pozostaje nierozliczona po ACK — klientka zapłaciła, vouchera nie ma.
    expect(world.settled.has(UNIT_B)).toBe(false)
  })

  it("po domknięciu brakującej jednostki kontrakt i route są ZGODNE (200 == PASS) — kontrola, że rozbieżność wynika z braku, nie z route'u", async () => {
    const world = makeWorld()
    const owed = buildOwedBusinessUnits({ payment_intent_id: PI, order_ids: [ORDER_A, ORDER_B] })
    await world.deliver("evt_ack_2")
    world.consume([ORDER_A, ORDER_B])
    const complete = evaluateOwedUnitAck({ owed_units: owed, settled_units: [...world.settled] })
    expect(complete.verdict).toBe("PASS")
    const retry = await world.deliver("evt_ack_2")
    expect(retry.statusCode).toBe(ackStatusForVerdict(complete.verdict))
    expect((retry.body as { duplicate?: boolean }).duplicate).toBe(true)
  })
})
