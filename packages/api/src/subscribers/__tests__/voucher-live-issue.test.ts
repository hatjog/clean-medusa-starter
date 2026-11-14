/**
 * voucher-live-issue.test.ts — Story 3.3 AC2/AC4 (Path Y subscriber).
 *
 * Dowodzi: mapowanie envelope.v1 → wejście rdzenia (fail-loud na braki, NFR4),
 * orchestracja w jednej DB-tx (BEGIN/COMMIT), idempotencja end-to-end (replay
 * ⇒ no-op), config.event = kontrakt Story 3.1. Side-effecty issue żyją w rdzeniu;
 * tu sprawdzamy warstwę subscribera (tx + mapowanie + delegacja Path Y).
 */
import { describe, it, expect } from "@jest/globals"

import subscriber, {
  config,
  PAYMENT_INTENT_SUCCEEDED_EVENT,
  toLiveIssueInput,
} from "../voucher-live-issue"
import { LiveIssuePartialFailureError } from "../../workflows/entitlements/live-issue-from-payment-intent"
import { marketContextStorage } from "../../lib/market-context"

describe("Story 3.3 — toLiveIssueInput (mapowanie envelope.v1, fail-loud NFR4)", () => {
  const envelope = {
    event_type: "gp.stripe.payment_intent_succeeded.v1",
    scope: { instance_id: "gp-dev", market_id: "bonbeauty" },
    payload: {
      payment_intent_id: "pi_1",
      order_id: "order_1",
      currency: "PLN",
      amount_minor: 1000,
      psp_occurred_at: "2026-06-02T10:15:28Z",
    },
  }

  it("mapuje kompletny envelope na wejście rdzenia (payload + scope + event_type)", () => {
    const input = toLiveIssueInput("gp.stripe.payment_intent_succeeded.v1", envelope)
    expect(input.payload.payment_intent_id).toBe("pi_1")
    expect(input.scope.market_id).toBe("bonbeauty")
    expect(input.event_type).toBe("gp.stripe.payment_intent_succeeded.v1")
  })

  it.each([
    ["payment_intent_id", { ...envelope, payload: { ...envelope.payload, payment_intent_id: "" } }],
    ["order_id", { ...envelope, payload: { ...envelope.payload, order_id: "" } }],
    ["currency", { ...envelope, payload: { ...envelope.payload, currency: "" } }],
    ["amount_minor", { ...envelope, payload: { ...envelope.payload, amount_minor: undefined } }],
    ["psp_occurred_at", { ...envelope, payload: { ...envelope.payload, psp_occurred_at: "" } }],
  ])("rzuca przy braku %s (kontrakt 3.1)", (field, bad) => {
    expect(() => toLiveIssueInput("e", bad as never)).toThrow(new RegExp(field))
  })

  it("config.event = kontrakt Story 3.1 (AR-EVENTS)", () => {
    expect(config.event).toBe(PAYMENT_INTENT_SUCCEEDED_EVENT)
    expect(PAYMENT_INTENT_SUCCEEDED_EVENT).toBe("gp.stripe.payment_intent_succeeded.v1")
  })

  it("(M2) rzuca przy braku scope.market_id (fail-loud PRZED tx, nie poison-retry)", () => {
    const noMarket = { ...envelope, scope: { instance_id: "gp-dev" } }
    expect(() => toLiveIssueInput("e", noMarket as never)).toThrow(/scope\.market_id/)
  })

  it("(M2) rzuca przy pustym scope.market_id", () => {
    const blankMarket = { ...envelope, scope: { instance_id: "gp-dev", market_id: "  " } }
    expect(() => toLiveIssueInput("e", blankMarket as never)).toThrow(/scope\.market_id/)
  })
})

/** Fake pool/client z obsługą BEGIN/COMMIT + minimalnej semantyki ON CONFLICT. */
function makeFakeContainer() {
  const eventProcessed = new Set<string>()
  const entitlements = new Map<string, unknown>()
  const log: string[] = []
  const txLog: string[] = []
  const seenScopes: Array<{ market_id: string; instance_id?: string } | undefined> = []
  const queryScopes: Array<{ sql: string; scope: { market_id: string; instance_id?: string } | undefined }> = []

  const client = {
    query: async (sql: string, values: ReadonlyArray<unknown> = []) => {
      const currentScope = marketContextStorage.getStore()
      seenScopes.push(currentScope)
      queryScopes.push({ sql, scope: currentScope })
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim())) {
        txLog.push(sql.trim().toUpperCase())
        return { rows: [], rowCount: 0 }
      }
      if (/INSERT INTO event_processed/i.test(sql)) {
        const key = `${values[0]}|${values[1]}`
        if (eventProcessed.has(key)) return { rows: [], rowCount: 0 }
        eventProcessed.add(key)
        return { rows: [], rowCount: 1 }
      }
      if (/FROM "order"/i.test(sql)) {
        return { rows: [{ sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } }], rowCount: 1 }
      }
      if (/FROM order_item/i.test(sql)) {
        return {
          rows: [
            {
              line_item_id: "li_1",
              // `oli.unit_price` to bigNumber Medusy, czyli kolumna NUMERIC — node-pg
              // zwraca ją jako STRING. Fixture celowo jest stringiem, bo to jedyny
              // kształt, w którym test broni klasy ADR-166 R-1 (`typeof === "number"`
              // cicho degradujące do fallbacku). Liczba tutaj przepuściłaby regresję.
              line_unit_price: "24900",
              // Nośniki `voucher.*` (NOT NULL) — geneza kodu vouchera jest przy
              // ich braku fail-loud, bo pusty salon w mailu to defekt, nie stan.
              line_title: "Masaż relaksacyjny 60 min",
              seller_id: "sel_bonbeauty_1",
              seller_name: "Salon Bon Beauty",
              seller_handle: "bon-beauty",
              metadata: {
                entitlement_profile_id: "p",
                entitlement_type: "VOUCHER_SERVICE",
                policy: { vat_rate_uniqueness: true },
              },
            },
          ],
          rowCount: 1,
        }
      }
      if (/INSERT INTO entitlement_instance/i.test(sql)) {
        const key = values[10] as string
        if (entitlements.has(key)) return { rows: [], rowCount: 0 }
        entitlements.set(key, values)
        return { rows: [{ id: values[0] }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    release: () => undefined,
  }

  const pool = { connect: async () => client }
  const container = {
    resolve: (key: string) => {
      if (key === "__pg_pool__") return pool
      if (key === "logger") {
        return {
          info: (m: string) => log.push(`info:${m}`),
          warn: (m: string) => log.push(`warn:${m}`),
          error: (m: string) => log.push(`error:${m}`),
        }
      }
      throw new Error(`unresolved ${key}`)
    },
  }
  return { container, entitlements, log, txLog, seenScopes, queryScopes }
}

function envelopeEvent() {
  return {
    name: PAYMENT_INTENT_SUCCEEDED_EVENT,
    data: {
      event_type: PAYMENT_INTENT_SUCCEEDED_EVENT,
      scope: { instance_id: "gp-dev", market_id: "bonbeauty" },
      payload: {
        payment_intent_id: "pi_sub_1",
        order_id: "order_sub_1",
        currency: "PLN",
        amount_minor: 24900,
        psp_occurred_at: "2026-06-02T10:15:28Z",
      },
    },
  }
}

describe("Story 3.3 — subscriber orchestracja (tx + idempotencja end-to-end)", () => {
  it("przetwarza event ⇒ ISSUED (jeden entitlement), commit", async () => {
    const { container, entitlements } = makeFakeContainer()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await subscriber({ event: envelopeEvent(), container } as any)
    expect(entitlements.size).toBe(1)
  })

  it("replay tego samego eventu ⇒ wciąż jeden entitlement (event-level no-op)", async () => {
    const { container, entitlements } = makeFakeContainer()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await subscriber({ event: envelopeEvent(), container } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await subscriber({ event: envelopeEvent(), container } as any)
    expect(entitlements.size).toBe(1)
  })

  it("envelope niekompletny ⇒ rzuca (fail-loud, Medusa retry/DLQ)", async () => {
    const { container } = makeFakeContainer()
    const bad = { name: PAYMENT_INTENT_SUCCEEDED_EVENT, data: { payload: { order_id: "o" } } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(subscriber({ event: bad, container } as any)).rejects.toThrow()
  })

  it("ustanawia subscriberowy scope przed transakcją i wykonaniem workflow", async () => {
    const { container, seenScopes, queryScopes } = makeFakeContainer()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await subscriber({ event: envelopeEvent(), container } as any)
    expect(seenScopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ market_id: "bonbeauty", instance_id: "gp-dev" }),
    ]))
    expect(queryScopes.find(({ sql }) => /INSERT INTO event_processed/i.test(sql))?.scope).toEqual(
      expect.objectContaining({ market_id: "bonbeauty", instance_id: "gp-dev" }),
    )
  })

  it("odmawia brakującego instance_id przed otwarciem transakcji", async () => {
    const { container, txLog } = makeFakeContainer()
    const event = envelopeEvent()
    event.data.scope = { instance_id: "", market_id: "bonbeauty" }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(subscriber({ event, container } as any)).rejects.toThrow(/scope\.instance_id/)
    expect(txLog).toEqual([])
  })
})

// ===========================================================================
// Story 3.4 (AI-Review-1) — OKABLOWANIE GENEZY ISSUED w subscriberze Path Y
// ===========================================================================

/** Container z event-busem (rejestruje emity okablowania) + capture audit logów. */
function makeWiredContainer() {
  const base = makeFakeContainer()
  const emitted: Array<{ name: string; data: unknown }> = []
  const eventBus = {
    emit: async (e: { name: string; data: unknown }) => {
      base.txLog.push("EMIT")
      emitted.push(e)
    },
  }
  const container = {
    resolve: (key: string) => {
      if (key === "event_bus") return eventBus
      return base.container.resolve(key)
    },
  }
  return {
    container,
    emitted,
    log: base.log,
    entitlements: base.entitlements,
    txLog: base.txLog,
  }
}

describe("Story 3.4 — subscriber okablowuje genezę ISSUED (event + audit; posting inert)", () => {
  it("ISSUED ⇒ event okablowania emitowany POST-COMMIT + audit append-only zalogowany", async () => {
    const { container, emitted, log, txLog } = makeWiredContainer()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await subscriber({ event: envelopeEvent(), container } as any)

    // (1) EVENT okablowania (envelope.v1, AR-EVENTS naming) wyemitowany.
    expect(emitted).toHaveLength(1)
    expect(emitted[0].name).toBe("gp.entitlements.entitlement_state_changed.v1")
    const data = emitted[0].data as {
      payload: { from_state: string; to_state: string }
      schema_version: string
    }
    expect(data.schema_version).toBe("1")
    expect(data.payload.from_state).toBe("__genesis__")
    expect(data.payload.to_state).toBe("ISSUED")

    // (2) AUDIT append-only zalogowany (kto/co/kiedy/scope/wynik).
    const auditLines = log.filter((l) => l.includes("[entitlement-transition-audit]"))
    expect(auditLines).toHaveLength(1)
    expect(auditLines[0]).toContain('"outcome":"transitioned"')
    expect(auditLines[0]).toContain('"to_state":"ISSUED"')

    // AI-Review-3 / ADR-137: event okablowania dopiero po COMMIT.
    expect(txLog).toEqual(["BEGIN", "COMMIT", "EMIT"])
  })

  it("replay (event-level dedupe) ⇒ ZERO ponownego okablowania (idempotencja)", async () => {
    const { container, emitted } = makeWiredContainer()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await subscriber({ event: envelopeEvent(), container } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await subscriber({ event: envelopeEvent(), container } as any)
    // Drugi przebieg = event-level no-op ⇒ wciąż dokładnie 1 emit okablowania.
    expect(emitted).toHaveLength(1)
  })

  it("brak event-busa ⇒ subscriber NIE rzuca (emit best-effort, reconciliation 2.6)", async () => {
    const { container } = makeFakeContainer() // resolve('event_bus') rzuca → bus null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(subscriber({ event: envelopeEvent(), container } as any)).resolves.toBeUndefined()
  })
})

// ===========================================================================
// Story 8.4 (v1.16.0, FR-16, AD-19, NFR-4) — warstwa subskrybenta przy
// częściowej porażce pozycji prezentowych: COMMIT linii udanych (brak ROLLBACK),
// okablowanie tylko udanych, potem fail-loud z wynikiem per pozycja.
// ===========================================================================
function makePartialFailureContainer() {
  const eventProcessed = new Set<string>()
  const entitlements = new Map<string, string>()
  const txLog: string[] = []
  const log: string[] = []
  const emitted: Array<{ name: string; data: unknown }> = []
  const savepoints: Array<{ name: string; ev: Set<string>; ent: Map<string, string> }> = []

  const line = (id: string, sellerName: string) => ({
    line_item_id: id,
    line_unit_price: "24900",
    line_title: "Masaż relaksacyjny 60 min",
    seller_id: "sel_bonbeauty_1",
    seller_name: sellerName,
    seller_handle: "bon-beauty",
    metadata: {
      entitlement_profile_id: "p",
      entitlement_type: "VOUCHER_SERVICE",
      policy: { vat_rate_uniqueness: true },
      recipients: [{ customer_id: `cus_${id}` }],
    },
  })
  // Linia 2 bez nazwy salonu ⇒ geneza kodu vouchera rzuca PO INSERT entitlementu.
  const lines = [line("li_a", "Salon"), line("li_b", ""), line("li_c", "Salon")]

  const client = {
    query: async (sql: string, values: ReadonlyArray<unknown> = []) => {
      const t = sql.trim()
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(t)) {
        txLog.push(t.toUpperCase())
        return { rows: [], rowCount: 0 }
      }
      let m = /^SAVEPOINT (\w+)$/i.exec(t)
      if (m) {
        savepoints.push({ name: m[1], ev: new Set(eventProcessed), ent: new Map(entitlements) })
        return { rows: [], rowCount: 0 }
      }
      m = /^ROLLBACK TO SAVEPOINT (\w+)$/i.exec(t)
      if (m) {
        const idx = savepoints.map((s) => s.name).lastIndexOf(m[1])
        const snap = savepoints[idx]
        savepoints.length = idx + 1
        eventProcessed.clear()
        snap.ev.forEach((k) => eventProcessed.add(k))
        entitlements.clear()
        snap.ent.forEach((v, k) => entitlements.set(k, v))
        return { rows: [], rowCount: 0 }
      }
      m = /^RELEASE SAVEPOINT (\w+)$/i.exec(t)
      if (m) {
        savepoints.length = savepoints.map((s) => s.name).lastIndexOf(m[1])
        return { rows: [], rowCount: 0 }
      }
      if (/INSERT INTO event_processed/i.test(sql)) {
        const key = `${values[0]}|${values[1]}`
        if (eventProcessed.has(key)) return { rows: [], rowCount: 0 }
        eventProcessed.add(key)
        return { rows: [], rowCount: 1 }
      }
      if (/FROM "order"/i.test(sql)) {
        return { rows: [{ sales_channel_id: "sc_x", metadata: { gp: { market_id: "bonbeauty" } } }], rowCount: 1 }
      }
      if (/FROM order_item/i.test(sql)) return { rows: lines, rowCount: lines.length }
      if (/INSERT INTO entitlement_instance/i.test(sql)) {
        const key = values[11] as string
        if (entitlements.has(key)) return { rows: [], rowCount: 0 }
        entitlements.set(key, values[4] as string)
        return { rows: [{ id: values[0] }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    release: () => undefined,
  }
  const container = {
    resolve: (key: string) => {
      if (key === "__pg_pool__") return { connect: async () => client }
      if (key === "event_bus") {
        return {
          emit: async (e: { name: string; data: unknown }) => {
            txLog.push("EMIT")
            emitted.push(e)
          },
        }
      }
      if (key === "logger") {
        return {
          info: (msg: string) => log.push(`info:${msg}`),
          warn: (msg: string) => log.push(`warn:${msg}`),
          error: (msg: string) => log.push(`error:${msg}`),
        }
      }
      throw new Error(`unresolved ${key}`)
    },
  }
  return { container, entitlements, eventProcessed, txLog, log, emitted, lines, line }
}

describe("Story 8.4 — subscriber przy częściowej porażce pozycji prezentowych", () => {
  it("COMMIT linii udanych (brak ROLLBACK), okablowanie 2 udanych, potem rzut z wynikiem per pozycja", async () => {
    const { container, entitlements, eventProcessed, txLog, emitted, log } = makePartialFailureContainer()
    let caught: unknown
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await subscriber({ event: envelopeEvent(), container } as any)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(LiveIssuePartialFailureError)
    const failure = caught as LiveIssuePartialFailureError
    expect(failure.line_outcomes.map((o) => [o.line_item_id, o.state])).toEqual([
      ["li_a", "issued"],
      ["li_b", "failed"],
      ["li_c", "issued"],
    ])
    expect(failure.failed_lines[0]).toMatchObject({ line_item_id: "li_b", reason: "issue_write_failed" })

    expect(txLog).toEqual(["BEGIN", "COMMIT", "EMIT", "EMIT"])
    expect([...entitlements.values()].sort()).toEqual(["li_a", "li_c"])
    expect(emitted).toHaveLength(2)
    // Event NIE skonsumowany ⇒ retry/DLQ wraca do linii nieudanej.
    expect(eventProcessed.size).toBe(0)
    expect(log.some((l) => l.startsWith("error:") && l.includes('"reason":"issue_write_failed"'))).toBe(true)
  })

  it("retry po naprawie linii ⇒ tylko linia nieudana okablowana, event skonsumowany", async () => {
    const ctx = makePartialFailureContainer()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(subscriber({ event: envelopeEvent(), container: ctx.container } as any)).rejects.toBeInstanceOf(
      LiveIssuePartialFailureError
    )
    ctx.lines[1] = ctx.line("li_b", "Salon")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await subscriber({ event: envelopeEvent(), container: ctx.container } as any)
    expect(ctx.entitlements.size).toBe(3)
    expect(ctx.emitted).toHaveLength(3)
    expect(ctx.eventProcessed.size).toBe(1)
  })
})
