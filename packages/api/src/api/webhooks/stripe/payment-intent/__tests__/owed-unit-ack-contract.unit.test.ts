/**
 * owed-unit-ack-contract.unit.test.ts — Story 3.1 AC3 (v1.16.0, Epic 3; AD-47).
 *
 * KONTRAKT „ACK vs JEDNOSTKI NALEŻNE": `200` wolno odpowiedzieć Stripe'owi
 * WYŁĄCZNIE, gdy KAŻDA jednostka `payment_intent_id:order_id` z tej dostawy jest
 * rozliczona (`PASS`). Brak choć jednej (`FAIL`) albo nieznany stan (`UNKNOWN`)
 * MUSI zachować ponowienie (nie-2xx). Werdykt liczy się ZBIORAMI jednostek, nie
 * licznikiem — kontrola negatywna pokazuje, że licznik dałby fałszywe `PASS`.
 *
 * Druga część pliku sprawdza ścieżkę produkcyjną: powtórzona dostawa po
 * częściowej konsumpcji MUSI odmówić ACK zgodnie z kontraktem, zaś komplet
 * jednostek MUSI pozwolić na `200 duplicate`.
 *
 * Lustro dla ludzi: `evidence/3-1/owed-unit-ack-contract.json` (super-repo);
 * ten sam scenariusz na realnym PostgreSQL:
 * `__tests__/integration/stripe-payment-intent-owed-unit-ack-pg.integration.test.ts`.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals"
import { createHmac } from "node:crypto"

jest.mock("../../../../../lib/payment/stripe-payment-intent-metadata-stamp", () => ({
  stampPaymentIntentOrderFacts: jest.fn(async () => true),
}))

import { PAYMENT_INTENT_SUCCEEDED_EMIT_OPTIONS, POST } from "../route"
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
import { marketContextStorage } from "../../../../../lib/market-context"

// Story 3.1 C3-SEC-002: instancja RLS wyłącznie ze źródła serwerowego (GP_INSTANCE_ID),
// bez domyślnego "gp" — testy ustawiają ją jawnie.
process.env.GP_INSTANCE_ID = "gp-test"

/**
 * Lustro hooka RLS (C3-SEC-001): kontekst rynku/instancji jest przypinany do
 * połączenia W CHWILI `connect()`, tak jak `installRlsPoolHook` ustawia GUC
 * tylko przy acquire. Odczyt GUC zwraca stan z chwili pobrania połączenia.
 */
function withAcquiredRlsContext<C extends { query: (sql: string, values?: ReadonlyArray<unknown>) => Promise<unknown> }>(client: C) {
  const ctx = marketContextStorage.getStore()
  return {
    ...client,
    query: async (sql: string, values: ReadonlyArray<unknown> = []) => {
      if (/current_setting\('app\.gp_market_id'/i.test(sql)) {
        return {
          rows: [{ market_id: ctx?.market_id ?? null, instance_id: ctx?.instance_id ?? null }],
          rowCount: 1,
        }
      }
      return client.query(sql, values)
    },
  }
}

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

// ── AC3 na realnym route Path Y (fake PG) ────────────────────────────────────

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
        metadata: { session_id: "payses_ack", instance_id: "gp-evil" },
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
function makeWorld(opts: { rlsHook?: boolean; settlementError?: string } = {}) {
  const rlsHook = opts.rlsHook ?? true
  const reservations = new Set<string>()
  const settled = new Set<string>()
  const queue: {
    name: string
    data: { payload: { payment_intent_id: string; order_id: string } }
    options?: Record<string, unknown>
  }[] = []
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
      if (/FROM event_processed/i.test(sql)) {
        if (opts.settlementError) throw new Error(opts.settlementError)
        expect(values).toEqual([PI])
        return {
          rows: [...settled].sort().map((external_id) => ({ external_id })),
          rowCount: settled.size,
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
          if (key === "__pg_pool__") {
            return { connect: async () => (rlsHook ? withAcquiredRlsContext(client) : client) }
          }
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

describe("Story 3.1 AC3 — route Path Y steruje ACK werdyktem jednostek należnych", () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET
  })

  it("po częściowej konsumpcji kontrakt mówi FAIL, a route odmawia ACK z widocznym powodem", async () => {
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

    // Dostawa 2 (ponowienie Stripe, ten sam event.id): kontrakt żąda nie-2xx.
    const retry = await world.deliver("evt_ack_1")
    expect(world.queue).toHaveLength(0)
    expect(retry.statusCode).toBe(ackStatusForVerdict(afterPartial.verdict))
    expect(retry.statusCode).toBeGreaterThanOrEqual(500)
    expect(retry.body).toMatchObject({
      type: "owed_unit_ack_incomplete",
      reason: "owed_units_unsettled",
      verdict: "FAIL",
      missing_units: [UNIT_B],
      unexpected_units: [],
    })
    // Jednostka B pozostaje nierozliczona, więc retry Stripe'a musi zostać zachowane.
    expect(world.settled.has(UNIT_B)).toBe(false)
  })

  it("brak WSZYSTKICH skutków po trafieniu rezerwacji ⇒ FAIL, nie zwykły 200 duplicate", async () => {
    const world = makeWorld()
    const owed = buildOwedBusinessUnits({ payment_intent_id: PI, order_ids: [ORDER_A, ORDER_B] })

    // Pierwsza dostawa rezerwuje transport i kolejkuje koperty, ale konsument
    // nie zapisał jeszcze żadnego skutku. Ponowienie tego samego event.id nie
    // może uznać samej rezerwacji za biznesowy ACK.
    const first = await world.deliver("evt_ack_no_settlement")
    expect(first.statusCode).toBe(200)
    expect(world.queue).toHaveLength(2)

    const noSettlement = evaluateOwedUnitAck({ owed_units: owed, settled_units: [] })
    expect(noSettlement.verdict).toBe("FAIL")
    expect(noSettlement.missing_units).toEqual([UNIT_A, UNIT_B])

    const retry = await world.deliver("evt_ack_no_settlement")
    expect(world.queue).toHaveLength(2)
    expect(retry.statusCode).toBe(ackStatusForVerdict(noSettlement.verdict))
    expect(retry.statusCode).toBeGreaterThanOrEqual(500)
    expect(retry.body).toMatchObject({
      type: "owed_unit_ack_incomplete",
      reason: "owed_units_unsettled",
      verdict: "FAIL",
      missing_units: [UNIT_A, UNIT_B],
      unexpected_units: [],
    })
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


// ── Story 8.4 fix (checkpoint PO, MEDIUM): ponowienie należy do busa ─────────

describe("Story 8.4 fix — emisja niesie attempts/backoff, ponowienie Stripe NIE re-emituje", () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET
  })

  it("każda koperta jest emitowana z nazwanymi opcjami ponowienia busa", async () => {
    const world = makeWorld()
    const first = await world.deliver("evt_s84_emit_opts")
    expect(first.statusCode).toBe(200)
    expect(world.queue).toHaveLength(2)
    for (const e of world.queue) {
      expect(e.options).toEqual({ ...PAYMENT_INTENT_SUCCEEDED_EMIT_OPTIONS })
      expect(Number(e.options?.attempts)).toBeGreaterThan(1)
    }
  })

  it("ponowienie Stripe po częściowym rozliczeniu daje 5xx i ZERO ponownych emisji (odzysk = bus, nie Stripe)", async () => {
    const world = makeWorld()
    await world.deliver("evt_s84_no_reemit")
    world.consume([ORDER_A])
    const retry = await world.deliver("evt_s84_no_reemit")
    expect(retry.statusCode).toBeGreaterThanOrEqual(500)
    expect((retry.body as { reason?: string }).reason).toBe("owed_units_unsettled")
    expect(world.queue).toHaveLength(0)
  })
})

// ── Story 3.1 fix C3-SEC-001 / C3-SEC-002 / C3-SEC-003 ──────────────────────

describe("Story 3.1 fix — odczyt poziomu 2 pod kontekstem RLS i bez wycieku", () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET
    process.env.GP_INSTANCE_ID = "gp-test"
  })
  afterEach(() => {
    process.env.GP_INSTANCE_ID = "gp-test"
  })

  it("C3-SEC-001: połączenie BEZ kontekstu RLS (brak GUC) ⇒ odmowa fail-closed UNKNOWN, nie odczyt bez filtra", async () => {
    const world = makeWorld({ rlsHook: false })
    await world.deliver("evt_sec_1")
    world.consume([ORDER_A, ORDER_B])
    const retry = await world.deliver("evt_sec_1")
    // Komplet jednostek JEST rozliczony, ale odczyt na połączeniu bez kontekstu
    // nie może dać PASS — inaczej ACK zależałby od zapytania bez filtra RLS.
    expect(retry.statusCode).toBeGreaterThanOrEqual(500)
    expect(retry.body).toMatchObject({
      type: "owed_unit_ack_incomplete",
      reason: "owed_units_unreadable",
      verdict: "UNKNOWN",
      error_code: "settlement_read_failed",
    })
  })

  it("C3-SEC-001 kontrola dodatnia: ten sam świat Z kontekstem przypiętym przy acquire ⇒ 200 PASS", async () => {
    const world = makeWorld({ rlsHook: true })
    await world.deliver("evt_sec_2")
    world.consume([ORDER_A, ORDER_B])
    const retry = await world.deliver("evt_sec_2")
    expect(retry.statusCode).toBe(200)
    expect((retry.body as { duplicate?: boolean }).duplicate).toBe(true)
  })

  it("C3-SEC-002: brak GP_INSTANCE_ID ⇒ 500 z nazwanym kodem, zero rezerwacji i zero emisji (bez domyślnego 'gp')", async () => {
    delete process.env.GP_INSTANCE_ID
    const world = makeWorld()
    const res = await world.deliver("evt_sec_3")
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ type: "instance_unconfigured", reason: "gp_instance_id_missing" })
    expect(world.queue).toHaveLength(0)
  })

  it("C3-SEC-002: metadata.instance_id NIE wybiera instancji — koperta niesie instancję serwerową", async () => {
    process.env.GP_INSTANCE_ID = "gp-server"
    const world = makeWorld()
    const res = await world.deliver("evt_sec_4")
    expect(res.statusCode).toBe(200)
    for (const delivery of world.queue as unknown as { data: { scope: { instance_id: string } } }[]) {
      expect(delivery.data.scope.instance_id).toBe("gp-server")
    }
    expect(world.queue).toHaveLength(2)
  })

  it("C3-SEC-003: przy UNKNOWN odpowiedź publiczna niesie stały kod, NIE treść błędu bazy", async () => {
    const secret = 'relation "event_processed" does not exist; host=db-internal.gp role=medusa_store'
    const world = makeWorld({ settlementError: secret })
    await world.deliver("evt_sec_5")
    world.consume([ORDER_A, ORDER_B])
    const retry = await world.deliver("evt_sec_5")
    expect(retry.statusCode).toBeGreaterThanOrEqual(500)
    expect(retry.body).toMatchObject({ verdict: "UNKNOWN", error_code: "settlement_read_failed" })
    const serialized = JSON.stringify(retry.body)
    expect(serialized).not.toContain("does not exist")
    expect(serialized).not.toContain("db-internal")
    expect(serialized).not.toContain("settlement_read_error")
  })
})
