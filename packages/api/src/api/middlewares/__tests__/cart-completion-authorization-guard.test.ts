/**
 * cart-completion-authorization-guard.test.ts — v1.15.0 Story 3.5, review-fix
 * cyklu 1 (FR-6c, NFR-3, AD-22; AC4 pozycja 4 — EC-43).
 *
 * Dowód Z WYKONANIA: każdy przypadek przepuszcza REALNY middleware przez
 * REALNE zakończenie odpowiedzi (`res.emit("finish")`) i sprawdza TREŚĆ tego,
 * co powstało w rejestrze — nie obecność pliku ani `rowCount > 0`.
 *
 * Kontrola negatywna: zdjęcie `reportUnreversedAuthorizations` z middleware'u
 * MUSI wywalić ten plik na czerwono.
 */
import { describe, it, expect, beforeEach } from "@jest/globals"
import { EventEmitter } from "node:events"

import { cartCompletionAuthorizationGuardMiddleware } from "../cart-completion-authorization-guard"
import { getRingBuffer, _resetRingBuffer } from "../../../lib/alert-emit"
import { COMPENSATION_FAILURE_ALERT_CODE } from "../../../lib/payment/money-path-compensation-registry"
import {
  CART_COMPLETION_DELIVERY_PATH,
  UNREVERSED_AUTHORIZATION_FAILURE_CODE,
} from "../../../lib/payment/cart-completion-authorization-guard"

const CART_ID = "cart_ec43"

type RegistryRow = Record<string, unknown>

function makeHarness(options: {
  /** Wiersze zwracane przez detekcję nieodwróconego obciążenia. */
  unreversed: Array<Record<string, unknown>>
  /** Sterownik Knexa niedostępny ⇒ guard nie ma czym sprawdzić. */
  noPg?: boolean
}) {
  const registry: RegistryRow[] = []
  const errors: string[] = []

  const client = {
    query: async (sql: string, values: ReadonlyArray<unknown> = []) => {
      if (/FROM cart_payment_collection/i.test(sql)) {
        expect(values[0]).toBe(CART_ID)
        return { rows: options.unreversed, rowCount: options.unreversed.length }
      }
      if (/INSERT INTO money_path_compensation_failure/i.test(sql)) {
        const row = {
          failure_id: values[0],
          market_id: values[1],
          compensation_kind: values[2],
          delivery_path: values[3],
          stripe_event_id: values[4],
          payment_intent_id: values[5],
          order_id: values[6] ?? null,
          failure_code: values[8],
          failure_detail: values[9],
          attempt_count: 1,
        }
        registry.push(row)
        return { rows: [row], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  }

  const scope = {
    resolve: (key: string) => {
      if (key === "logger") {
        return { info() {}, error: (m: string) => errors.push(m) }
      }
      if (key === "__pg_pool__") {
        if (options.noPg) {
          throw new Error("unresolved __pg_pool__")
        }
        return { connect: async () => ({ ...client, release: () => {} }) }
      }
      throw new Error(`unresolved ${key}`)
    },
  }

  const res = new EventEmitter() as EventEmitter & {
    status: (c: number) => unknown
  }
  res.status = (_c: number) => res

  const req = { params: { id: CART_ID }, scope }

  return { req, res, registry, errors }
}

/** Odczekuje na mikro-zadania guardu odpalonego z `res.on("finish")`. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

beforeEach(() => {
  _resetRingBuffer()
})

describe("Story 3.5 AC4 poz. 4 (EC-43) — nieodwrócone obciążenie NIE znika w ciszy", () => {
  it("nieudany completion z AUTORYZOWANĄ sesją i bez zamówienia ⇒ TRWAŁY wpis + ALARM", async () => {
    const h = makeHarness({
      unreversed: [
        {
          payment_session_id: "ps_1",
          status: "authorized",
          payment_collection_id: "pc_1",
          payment_intent_id: "pi_ec43",
          sales_channel_id: "sc_bonbeauty",
        },
      ],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cartCompletionAuthorizationGuardMiddleware(h.req as any, h.res as any, () => {})
    h.res.status(500)
    h.res.emit("finish")
    await settle()

    expect(h.registry).toHaveLength(1)
    const row = h.registry[0]
    expect(row.compensation_kind).toBe("cart_payment_authorization_cancel")
    expect(row.delivery_path).toBe(CART_COMPLETION_DELIVERY_PATH)
    expect(row.failure_code).toBe(UNREVERSED_AUTHORIZATION_FAILURE_CODE)
    expect(row.payment_intent_id).toBe("pi_ec43")
    // `market_id` jest NOT NULL (AD-22) — bez rynku wiersz odpadłby na bazie.
    expect(row.market_id).toBe("sc_bonbeauty")
    expect(String(row.failure_detail)).toContain("EC-43")

    // Alarm jako DRUGI nośnik obok wpisu.
    const alerts = getRingBuffer().filter(
      (e) => e.code === COMPENSATION_FAILURE_ALERT_CODE
    )
    expect(alerts).toHaveLength(1)
    expect(alerts[0].context?.registry_persisted).toBe(true)

    // …i log, który przestaje być JEDYNYM nośnikiem.
    expect(h.errors.join("\n")).toContain("NIEODWROCONE OBCIAZENIE")
  })

  it("status `captured` też jest łapany — defekt EC-43 połyka anulowanie niezależnie od zaawansowania płatności", async () => {
    const h = makeHarness({
      unreversed: [
        {
          payment_session_id: "ps_2",
          status: "captured",
          payment_collection_id: "pc_2",
          payment_intent_id: "pi_captured",
          sales_channel_id: "sc_bonbeauty",
        },
      ],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cartCompletionAuthorizationGuardMiddleware(h.req as any, h.res as any, () => {})
    h.res.status(500)
    h.res.emit("finish")
    await settle()

    expect(h.registry).toHaveLength(1)
    expect(h.registry[0].payment_intent_id).toBe("pi_captured")
  })

  it("N sesji bez zamówienia ⇒ N ROZŁĄCZNYCH wierszy, nie jeden zbiorczy", async () => {
    const h = makeHarness({
      unreversed: [
        {
          payment_session_id: "ps_a",
          status: "authorized",
          payment_collection_id: "pc_a",
          payment_intent_id: "pi_a",
          sales_channel_id: "sc_bonbeauty",
        },
        {
          payment_session_id: "ps_b",
          status: "authorized",
          payment_collection_id: "pc_b",
          payment_intent_id: "pi_b",
          sales_channel_id: "sc_bonbeauty",
        },
      ],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cartCompletionAuthorizationGuardMiddleware(h.req as any, h.res as any, () => {})
    h.res.status(500)
    h.res.emit("finish")
    await settle()

    expect(h.registry).toHaveLength(2)
    const ids = new Set(h.registry.map((r) => r.failure_id))
    expect(ids.size).toBe(2)
  })

  it("KONTROLA PRZECIWNA: completion UDANY nie zapisuje niczego", async () => {
    const h = makeHarness({
      unreversed: [
        {
          payment_session_id: "ps_1",
          status: "authorized",
          payment_collection_id: "pc_1",
          payment_intent_id: "pi_ec43",
          sales_channel_id: "sc_bonbeauty",
        },
      ],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cartCompletionAuthorizationGuardMiddleware(h.req as any, h.res as any, () => {})
    h.res.status(200)
    h.res.emit("finish")
    await settle()

    expect(h.registry).toHaveLength(0)
    expect(
      getRingBuffer().filter((e) => e.code === COMPENSATION_FAILURE_ALERT_CODE)
    ).toHaveLength(0)
  })

  it("KONTROLA PRZECIWNA: porażka BEZ nieodwróconego obciążenia nie zapisuje niczego", async () => {
    // Zwykły błąd walidacji koszyka — bramka nie może krzyczeć na zdrowej
    // ścieżce, bo to uczy ignorować jej czerwień.
    const h = makeHarness({ unreversed: [] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cartCompletionAuthorizationGuardMiddleware(h.req as any, h.res as any, () => {})
    h.res.status(400)
    h.res.emit("finish")
    await settle()

    expect(h.registry).toHaveLength(0)
    expect(h.errors.join("\n")).not.toContain("NIEODWROCONE")
  })

  it("brak dostępu do PG ⇒ „nie dało się SPRAWDZIĆ\" jest powiedziane, a nie przemilczane", async () => {
    const h = makeHarness({ unreversed: [], noPg: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cartCompletionAuthorizationGuardMiddleware(h.req as any, h.res as any, () => {})
    h.res.status(500)
    h.res.emit("finish")
    await settle()

    // Brak pomiaru jest informacją, nie jej brakiem.
    expect(h.errors.join("\n")).toContain("NIE DOSZLA DO SKUTKU")
  })

  it("middleware NIE blokuje łańcucha — `next()` woła się zawsze i od razu", async () => {
    const h = makeHarness({ unreversed: [] })
    let called = 0
    await cartCompletionAuthorizationGuardMiddleware(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      h.req as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      h.res as any,
      () => {
        called += 1
      }
    )
    expect(called).toBe(1)
  })
})
