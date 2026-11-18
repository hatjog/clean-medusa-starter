/**
 * v1.16.0 Story 8.7 — hook RLS (`installRlsPoolHook`) na REALNYM PostgreSQL
 * (baza `*_test`, profil `test:integration:story-8-7-rls-hook-pg`).
 *
 *  - DW-15-370 (retro E5-X-4): odmowa w `acquireConnection` (brak kontekstu
 *    rynku) nie może wyczerpać puli Knexa. Pula `max = n`, n+1 odmów hooka,
 *    potem zapytanie Z kontekstem rynku musi zakończyć się w czasie.
 *
 * Bez `DATABASE_URL` na bazie `*_test` suita jest SKIP-owana — nigdy fałszywy PASS.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import knexFactory, { type Knex } from "knex"

import { installRlsPoolHook, RlsMarketContextRequiredError } from "../../lib/rls-pool-hook"
import { marketContextStorage } from "../../lib/market-context"
import sweep from "../../jobs/voucher-consent-retention-sweep"
import onOrderPlaced from "../../subscribers/on-order-placed-stripe-retry"
import handoffSweep from "../../jobs/voucher-delivery-reconciliation-sweep"

const DATABASE_URL = process.env.DATABASE_URL ?? ""
const isTestDb = /\/[A-Za-z0-9_]*_test(\?|$)/.test(DATABASE_URL)
const maybe = DATABASE_URL && isTestDb ? describe : describe.skip

const POOL_MAX = 2
const ACQUIRE_TIMEOUT_MS = 3_000

maybe("Story 8.7 DW-15-370 — odmowy hooka RLS nie wyczerpują puli (PG)", () => {
  let knex: Knex
  const logs: string[] = []
  const logger = {
    info: (m: string) => logs.push(`info ${m}`),
    warn: (m: string) => logs.push(`warn ${m}`),
    error: (m: string) => logs.push(`error ${m}`),
  }

  beforeAll(() => {
    knex = knexFactory({
      client: "pg",
      connection: DATABASE_URL,
      pool: { min: 0, max: POOL_MAX },
      acquireConnectionTimeout: ACQUIRE_TIMEOUT_MS,
    })
    installRlsPoolHook(knex as never, logger)
  })

  afterAll(async () => {
    await knex?.destroy()
  })

  it(`pula max=${POOL_MAX}: ${POOL_MAX + 1} odmów hooka, potem zapytanie z kontekstem rynku kończy się w czasie`, async () => {
    for (let i = 0; i < POOL_MAX + 1; i += 1) {
      await expect(knex.raw("SELECT 1 AS one")).rejects.toBeInstanceOf(RlsMarketContextRequiredError)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = (knex.client as any).pool
    // Zasób odmówionego połączenia NIE może zostać zaliczony jako „w użyciu".
    expect(pool.numUsed()).toBe(0)

    const started = Date.now()
    const result = await marketContextStorage.run(
      { market_id: "bonbeauty", instance_id: "gp_test" } as never,
      async () => await knex.raw<{ rows: Array<{ market: string; who: string }> }>(
        "SELECT current_setting('app.gp_market_id', true) AS market, current_user AS who"
      )
    )
    const elapsed = Date.now() - started
    expect(result.rows[0]).toEqual({ market: "bonbeauty", who: "medusa_store" })
    expect(elapsed).toBeLessThan(ACQUIRE_TIMEOUT_MS)
    expect(pool.numUsed()).toBe(0)
  })
})

/**
 * Story 8.7 (DW-15-374, retro E11-X-10/X-11): trzy powierzchnie asynchroniczne
 * z ZAINSTALOWANYM hookiem RLS — odzysk Path Y (`order.placed`), sweep handoffu
 * dostawy i sweep retencji zgód. Pomiar: każda powierzchnia musi dostać
 * połączenie z kontekstem rynku (brak logu `RLS pool hook acquire denied`),
 * a sweep zgód nie może zakończyć się sukcesem przy porażce.
 *
 * Dane: własne wiersze z prefiksem przebiegu (sprzątane w `afterAll`).
 *
 * Granty (Story 8.7 fix R-5/R-6, DW-15-363): suita nadaje `medusa_store` DML
 * w `public` tylko na czas przebiegu i COFA w ostatnim teście dokładnie te
 * uprawnienia, których rola nie miała przed suitą (migawka
 * `has_table_privilege`). Ostatni test asertuje, że migawka po == przed —
 * w tym least-privilege tabel append-only z bootstrapu 003.
 */
maybe("Story 8.7 DW-15-374 — powierzchnie asynchroniczne pod zainstalowanym hookiem RLS (PG)", () => {
  const RUN = `s874_${Date.now().toString(36)}`
  const MARKET = "bonbeauty"
  let knex: Knex
  let admin: Knex
  const logs: string[] = []
  const logger = {
    info: (m: string) => logs.push(`info ${m}`),
    warn: (m: string) => logs.push(`warn ${m}`),
    error: (m: string, meta?: unknown) => logs.push(`error ${m} ${meta ? JSON.stringify(meta) : ""}`),
    debug: (m: string) => logs.push(`debug ${m}`),
  }
  const container = {
    resolve: (key: string) => {
      if (key === "pg_connection" || key === "__pg_connection__") return knex
      if (key === "logger") return logger
      if (key === "gp_market_loader") return { listActive: async () => [MARKET] }
      if (key === "notification") return { createNotifications: async () => [] }
      if (key === "voucher") return {}
      throw new Error(`unexpected resolve(${key})`)
    },
  }
  const denials = () => logs.filter((l) => l.includes("RLS pool hook acquire denied"))
  let grantsBefore: string[] = []
  let schemaUsageBefore = true

  beforeAll(async () => {
    admin = knexFactory({ client: "pg", connection: DATABASE_URL, pool: { min: 0, max: 1 } })
    grantsBefore = await snapshotGrants(admin)
    schemaUsageBefore = await hasSchemaUsage(admin)
    await admin.raw("GRANT USAGE ON SCHEMA public TO medusa_store")
    await admin.raw("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO medusa_store")
    knex = knexFactory({ client: "pg", connection: DATABASE_URL, pool: { min: 0, max: 4 }, acquireConnectionTimeout: 5_000 })
    installRlsPoolHook(knex as never, logger)
  })

  afterAll(async () => {
    // Idempotentne: ostatni test już przywrócił granty; tu na wypadek przerwania.
    if (admin) await restoreGrants(admin, grantsBefore, schemaUsageBefore)
    await admin?.raw("DELETE FROM mor_policy_dlq_entry WHERE event_id LIKE ?", [`${RUN}%`])
    await admin?.raw("DELETE FROM voucher_consent_attempt WHERE token_jti LIKE ?", [`${RUN}%`])
    await admin?.raw("DELETE FROM webhook_event_processed WHERE event_id LIKE ?", [`${RUN}%`])
    await admin?.raw("DELETE FROM order_payment_collection WHERE id LIKE ?", [`${RUN}%`])
    await admin?.raw("DELETE FROM payment WHERE id LIKE ?", [`${RUN}%`])
    await knex?.destroy()
    await admin?.destroy()
  })

  it("sweep zgód: pod hookiem kasuje przeterminowane próby rynku i NIE kończy się sukcesem przy porażce", async () => {
    await admin.raw(
      `INSERT INTO voucher_consent_attempt (token_jti, recipient_id, market_id, sales_channel_id, created_at)
       VALUES (?, ?, ?, 'sc_s874', now() - interval '30 days')`,
      [`${RUN}_jti`, `${RUN}_rcp`, MARKET]
    )
    logs.length = 0
    await sweep(container as never)
    expect(denials()).toEqual([])
    const left = await admin.raw("SELECT count(*)::int AS n FROM voucher_consent_attempt WHERE token_jti = ?", [`${RUN}_jti`])
    expect(left.rows[0].n).toBe(0)

    // Porażka (brak rynków w rosterze) ⇒ odrzucenie, nie cichy sukces.
    const noMarkets = { resolve: (key: string) => (key === "gp_market_loader" ? { listActive: async () => [] } : container.resolve(key)) }
    await expect(sweep(noMarkets as never)).rejects.toThrow()
  })

  it("odzysk Path Y (`order.placed`): wybór pracy biegnie z kontekstem rynku wiersza", async () => {
    const evt = `${RUN}_evt`
    const pi = `pi_${RUN}`
    const order = `${RUN}_order`
    await admin.transaction(async (trx) => {
      await trx.raw("SET LOCAL session_replication_role = replica")
      await trx.raw(
        `INSERT INTO payment (id, amount, raw_amount, currency_code, provider_id, payment_collection_id, payment_session_id, data)
         VALUES (?, 10000, '{"value":"10000","precision":20}'::jsonb, 'pln', 'pp_stripe', ?, ?, ?::jsonb)`,
        [`${RUN}_pay`, `${RUN}_pc`, `${RUN}_ps`, JSON.stringify({ id: pi })]
      )
      await trx.raw(
        `INSERT INTO order_payment_collection (id, order_id, payment_collection_id) VALUES (?, ?, ?)`,
        [`${RUN}_opc`, order, `${RUN}_pc`]
      )
      await trx.raw(
        `INSERT INTO webhook_event_processed (event_id, provider, market_id, envelope)
         VALUES (?, 'stripe_payment_intent_webhook', ?, ?::jsonb)`,
        [
          `${evt}#deferred-issuance`,
          MARKET,
          JSON.stringify({ scope: `payment_intent:${pi}`, event_type: "payment.captured", entitlement_issue_deferred_reason: "order_not_yet_created" }),
        ]
      )
    })
    logs.length = 0
    await onOrderPlaced({ event: { name: "order.placed", data: { id: order } }, container } as never)
    expect(denials()).toEqual([])
    // Kontrola dodatnia: wiersz rynku został wybrany do pracy (log niesie jego event_id).
    expect(logs.some((l) => l.includes(`${evt}#deferred-issuance`))).toBe(true)
  })

  it("sweep handoffu dostawy: przebieg pod hookiem nie dostaje odmowy połączenia", async () => {
    logs.length = 0
    await handoffSweep(container as never)
    expect(denials()).toEqual([])
    expect(logs.some((l) => l.includes("przebieg przerwany"))).toBe(false)
  })

  async function seedPathYMarker(tag: string, marketId: string | null, envelopeExtra: Record<string, unknown>) {
    const evt = `${RUN}_${tag}_evt`
    const pi = `pi_${RUN}_${tag}`
    const order = `${RUN}_${tag}_order`
    await admin.transaction(async (trx) => {
      await trx.raw("SET LOCAL session_replication_role = replica")
      await trx.raw(
        `INSERT INTO payment (id, amount, raw_amount, currency_code, provider_id, payment_collection_id, payment_session_id, data)
         VALUES (?, 10000, '{"value":"10000","precision":20}'::jsonb, 'pln', 'pp_stripe', ?, ?, ?::jsonb)`,
        [`${RUN}_${tag}_pay`, `${RUN}_${tag}_pc`, `${RUN}_${tag}_ps`, JSON.stringify({ id: pi })]
      )
      await trx.raw(
        `INSERT INTO order_payment_collection (id, order_id, payment_collection_id) VALUES (?, ?, ?)`,
        [`${RUN}_${tag}_opc`, order, `${RUN}_${tag}_pc`]
      )
      await trx.raw(
        `INSERT INTO webhook_event_processed (event_id, provider, market_id, envelope)
         VALUES (?, 'stripe_payment_intent_webhook', ?, ?::jsonb)`,
        [
          `${evt}#deferred-issuance`,
          marketId,
          JSON.stringify({
            scope: `payment_intent:${pi}`,
            event_type: "payment.captured",
            entitlement_issue_deferred_reason: "order_not_yet_created",
            ...envelopeExtra,
          }),
        ]
      )
    })
    return { eventId: `${evt}#deferred-issuance`, order }
  }

  it("R-3: zapis DLQ po trwałej porażce odzysku biegnie z kontekstem rynku wiersza (wiersz DLQ powstaje)", async () => {
    // Marker kompletny (psp_occurred_at) — przechodzi walidację i pada w wystawieniu
    // (zamówienie fikcyjne) klasą trwałą ⇒ ścieżka `DeadLetterPendingError`, czyli
    // zapis DLQ w NOWEJ transakcji, poza przebiegiem per rynek.
    const { eventId, order } = await seedPathYMarker("dlq", MARKET, { psp_occurred_at: "2026-11-18T10:00:00.000Z" })
    logs.length = 0
    const res = await onOrderPlaced({ event: { name: "order.placed", data: { id: order } }, container } as never)
    // Warunek wstępny: przebieg rzeczywiście doszedł do ścieżki DLQ poza transakcją.
    expect(logs.some((l) => l.includes(`event_id=${eventId} class=`) && l.includes("dlq_entry_id="))).toBe(true)
    expect(res.dlq_write_failures).toEqual([])
    expect(denials()).toEqual([])
    const dlq = await admin.raw(
      "SELECT market_id FROM mor_policy_dlq_entry WHERE event_id = ? AND subject_id = ?",
      [eventId, order]
    )
    expect(dlq.rows).toEqual([{ market_id: MARKET }])
  })

  it("R-3: marker bez rynku i spoza rosteru ⇒ nazwany sygnał GP_SYSTEM_ROW_OUTSIDE_ROSTER, nie ciche pominięcie", async () => {
    const nul = await seedPathYMarker("nul", null, {})
    logs.length = 0
    const r1 = await onOrderPlaced({ event: { name: "order.placed", data: { id: nul.order } }, container } as never)
    expect(r1.outside_roster).toEqual([{ order_id: nul.order, event_id: nul.eventId, market_id: null }])
    expect(logs.filter((l) => l.includes("GP_SYSTEM_ROW_OUTSIDE_ROSTER") && l.includes(nul.eventId))).toHaveLength(1)

    const other = await seedPathYMarker("oth", "obcy_rynek", {})
    logs.length = 0
    const r2 = await onOrderPlaced({ event: { name: "order.placed", data: { id: other.order } }, container } as never)
    expect(r2.outside_roster).toEqual([{ order_id: other.order, event_id: other.eventId, market_id: "obcy_rynek" }])
  })

  it("R-4 (pomiar): pod zainstalowanym hookiem zapytanie bez kontekstu rynku (powierzchnia admin / job bez nośnika) dostaje odmowę", async () => {
    // Nazwana powierzchnia, która ODMAWIA przy instalacji hooka na boocie:
    // każde połączenie poza `/store/*` i poza `runPerRosterMarket` — trasy
    // `/admin/*` oraz joby/subscribery bez nośnika kontekstu (inwentarz w
    // evidence/8-7/r4-boot-install-surface.json). Kontrola dodatnia: test DW-15-370.
    await expect(knex.raw("SELECT 1 AS admin_probe")).rejects.toBeInstanceOf(RlsMarketContextRequiredError)
  })

  it("R-7: bez hooka sweep handoffu robi JEDEN przebieg niezależnie od liczby rynków w rosterze", async () => {
    const plain = knexFactory({ client: "pg", connection: DATABASE_URL, pool: { min: 0, max: 2 } })
    try {
      const countQueries = async (roster: string[]) => {
        let n = 0
        const onQuery = () => { n += 1 }
        plain.on("query", onQuery)
        const c = {
          resolve: (key: string) => {
            if (key === "pg_connection" || key === "__pg_connection__") return plain
            if (key === "gp_market_loader") return { listActive: async () => roster }
            return container.resolve(key)
          },
        }
        logs.length = 0
        await handoffSweep(c as never)
        plain.removeListener("query", onQuery)
        expect(logs.some((l) => l.includes("przebieg przerwany"))).toBe(false)
        return n
      }
      const one = await countQueries([MARKET])
      const two = await countQueries([MARKET, "drugi_rynek"])
      expect(one).toBeGreaterThan(0)
      expect(two).toBe(one)
    } finally {
      await plain.destroy()
    }
  })

  it("R-5/R-6: granty medusa_store w public po suicie == przed suitą (least-privilege append-only zachowane)", async () => {
    await restoreGrants(admin, grantsBefore, schemaUsageBefore)
    expect(await snapshotGrants(admin)).toEqual(grantsBefore)
    expect(await hasSchemaUsage(admin)).toBe(schemaUsageBefore)
  })
})

const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const

/** Migawka `relname:PRIV` dla każdego uprawnienia, które `medusa_store` MA na tabeli w `public`. */
async function snapshotGrants(db: Knex): Promise<string[]> {
  const res = await db.raw<{ rows: Array<{ k: string }> }>(
    `SELECT c.relname || ':' || p.priv AS k
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest(?::text[]) AS p(priv)
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
        AND has_table_privilege('medusa_store', c.oid, p.priv)
      ORDER BY 1`,
    [PRIVS as unknown as string[]]
  )
  return res.rows.map((r) => r.k)
}

async function hasSchemaUsage(db: Knex): Promise<boolean> {
  const res = await db.raw<{ rows: Array<{ ok: boolean }> }>(
    "SELECT has_schema_privilege('medusa_store', 'public', 'USAGE') AS ok"
  )
  return res.rows[0].ok
}

/** Cofa uprawnienia nadane przez suitę: wszystko, czego nie było w migawce `before`. */
async function restoreGrants(db: Knex, before: string[], schemaUsage: boolean): Promise<void> {
  const keep = new Set(before)
  for (const key of await snapshotGrants(db)) {
    if (keep.has(key)) continue
    const [table, priv] = key.split(":")
    if (!(PRIVS as readonly string[]).includes(priv)) continue
    await db.raw(`REVOKE ${priv} ON TABLE public.?? FROM medusa_store`, [table])
  }
  if (!schemaUsage) await db.raw("REVOKE USAGE ON SCHEMA public FROM medusa_store")
}
