/**
 * v1.16.0 Story 3.3 (FR-9, AD-33, AD-47, NFR-3, AD-44; ADR-242 Proposed) —
 * wspólna bariera idempotencji skutku jako JEDNA operacja atomowa, na realnym
 * PostgreSQL.
 *
 * Profil: `pnpm run test:integration:story-3-3-shared-barrier-pg`
 * Baza: izolowana `gp_story_3_3_test` (stack gp-test, port 55432); suita
 * odmawia startu na bazie bez sufiksu `_test`.
 *
 *  AC1 dwa równoległe połączenia PG (= dwie trasy) rozliczają te same N∈{1,3}
 *      jednostek: skutków == unikalnych kluczy == N; ROLLBACK jednej trasy po
 *      rezerwacji nie zostawia braku; mutant „rezerwacja i skutek w dwóch tx"
 *      zostawia brak i jest wykrywany tą samą asercją.
 *  AC2 jedna koperta z dwiema należnymi jednostkami (quantity=2): dwa różne
 *      klucze, dwa skutki, ponowienie = 0 nowych.
 *  AC3 `instance_id`, `market_id` NOT NULL (information_schema), RLS
 *      `market_isolation` dla `medusa_store`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { Migration20261114140000SharedIdempotencyBarrier } from "../../migrations/Migration20261114140000SharedIdempotencyBarrier"
import {
  buildOwedUnitEffectBarrierInsert,
  buildOwedUnitEffectBarrierPurchaseQuery,
  OWED_UNIT_EFFECT_BARRIER_TABLE,
} from "../../lib/payment/owed-unit-effect-barrier"
import { buildOwedBusinessUnitKey } from "../../lib/payment/stripe-webhook-barrier-contract"
import {
  LIVE_ISSUE_PATH,
  liveIssueEntitlementsWithinTx,
} from "../../workflows/entitlements/live-issue-from-payment-intent"

const DATABASE_URL = process.env.DATABASE_URL
const enabled = !!DATABASE_URL

const EVENT_TYPE = "gp.stripe.payment_intent_succeeded.v1"
const SCOPE = { instance_id: "gp_test", market_id: "mkt_3_3_a" }
const PROBE = "story_3_3_effect_probe"
const PREFIX = "pi_3_3_"
const ROUTES = ["route:path-y", "route:native"] as const

function collectSql(direction: "up" | "down"): Promise<string[]> {
  const statements: string[] = []
  const migration = Object.create(
    Migration20261114140000SharedIdempotencyBarrier.prototype
  ) as Migration20261114140000SharedIdempotencyBarrier & { addSql: (sql: string) => void }
  migration.addSql = (sql: string) => {
    statements.push(sql)
  }
  return Promise.resolve(migration[direction]()).then(() => statements)
}

function unitsFor(pi: string, n: number): Array<{ pi: string; order: string; key: string }> {
  return Array.from({ length: n }, (_, i) => {
    const order = `order_3_3_${i}`
    return { pi, order, key: buildOwedBusinessUnitKey({ payment_intent_id: pi, order_id: order }) }
  })
}

function barrierInsert(unit: { pi: string; order: string; key: string }, route: string) {
  return buildOwedUnitEffectBarrierInsert(
    {
      external_id: unit.key,
      event_type: EVENT_TYPE,
      processed_at: Date.now(),
      purchase_key: unit.pi,
      ...SCOPE,
    },
    {
      owed_business_unit_key: unit.key,
      payment_intent_id: unit.pi,
      order_id: unit.order,
      ...SCOPE,
      claimed_by_path: route,
    }
  )
}

/** Wzorzec produkcyjny: rezerwacja+znacznik (jedna instrukcja) i skutek w JEDNEJ tx. */
async function settleAtomic(
  client: PoolClient,
  route: string,
  units: ReturnType<typeof unitsFor>,
  options: { failAfterClaim?: boolean } = {}
): Promise<number> {
  let created = 0
  await client.query("BEGIN")
  try {
    for (const unit of units) {
      const insert = barrierInsert(unit, route)
      const claimed = await client.query(insert.sql, insert.params)
      if ((claimed.rowCount ?? 0) === 0) continue
      // poszerzenie okna wyścigu: druga trasa czeka na PK bariery
      await client.query("SELECT pg_sleep(0.05)")
      if (options.failAfterClaim) throw new Error("awaria trasy po rezerwacji")
      await client.query(`INSERT INTO ${PROBE} (unit_key, route) VALUES ($1, $2)`, [unit.key, route])
      created += 1
    }
    await client.query("COMMIT")
    return created
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  }
}

/** MUTANT: rezerwacja w osobnej tx (COMMIT) przed zapisem skutku. */
async function settleSplitMutant(
  client: PoolClient,
  route: string,
  units: ReturnType<typeof unitsFor>,
  options: { failAfterClaim?: boolean } = {}
): Promise<void> {
  for (const unit of units) {
    await client.query("BEGIN")
    const insert = barrierInsert(unit, route)
    const claimed = await client.query(insert.sql, insert.params)
    await client.query("COMMIT")
    if ((claimed.rowCount ?? 0) === 0) continue
    if (options.failAfterClaim) continue // skutek nigdy nie zapisany
    await client.query("BEGIN")
    await client.query(`INSERT INTO ${PROBE} (unit_key, route) VALUES ($1, $2)`, [unit.key, route])
    await client.query("COMMIT")
  }
}

async function measure(client: PoolClient, pi: string) {
  const effects = await client.query<{ unit_key: string }>(
    `SELECT unit_key FROM ${PROBE} WHERE unit_key LIKE $1 ORDER BY unit_key`,
    [`${pi}:%`]
  )
  const q = buildOwedUnitEffectBarrierPurchaseQuery(pi)
  const barrier = await client.query<{ owed_business_unit_key: string }>(q.sql, q.params)
  return {
    effects: effects.rows.map((r) => r.unit_key),
    claimed: barrier.rows.map((r) => r.owed_business_unit_key),
  }
}

/** Inwariant AC1: dokładnie jeden skutek per zarezerwowany klucz, bez braków i duplikatów. */
function assertOneEffectPerUnit(
  state: { effects: string[]; claimed: string[] },
  owed: string[]
): void {
  expect(state.effects).toEqual([...owed].sort())
  expect(new Set(state.effects).size).toBe(owed.length)
  expect(state.claimed).toEqual([...owed].sort())
}

const describeOrNotRun = enabled ? describe : describe.skip

if (!enabled) {
  describe("Story 3.3 — wspólna bariera skutku na realnym PostgreSQL", () => {
    it("NOT_RUN: wymaga DATABASE_URL izolowanej bazy *_test", () => {
      console.warn("[NOT_RUN] Story 3.3: ustaw DATABASE_URL na gp_story_3_3_test")
    })
  })
}

describeOrNotRun("Story 3.3 — wspólna bariera skutku na realnym PostgreSQL", () => {
  let pool: Pool
  let a: PoolClient
  let b: PoolClient

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 })
    a = await pool.connect()
    b = await pool.connect()
    const db = await a.query<{ name: string }>("SELECT current_database() AS name")
    if (!/_test$/.test(db.rows[0]?.name ?? "")) {
      throw new Error(`Story 3.3 PG: odmowa startu na bazie ${db.rows[0]?.name} (wymagana *_test)`)
    }
    for (const sql of await collectSql("down")) await a.query(sql)
    for (const sql of await collectSql("up")) await a.query(sql)
    await a.query(`DROP TABLE IF EXISTS ${PROBE}`)
    await a.query(`CREATE TABLE ${PROBE} (id bigserial PRIMARY KEY, unit_key text NOT NULL, route text NOT NULL)`)
  })

  afterAll(async () => {
    if (a) {
      await a.query(`DROP TABLE IF EXISTS ${PROBE}`)
      await a.query("DELETE FROM event_processed WHERE purchase_key LIKE $1", [`${PREFIX}%`])
      await a.query(`DELETE FROM ${OWED_UNIT_EFFECT_BARRIER_TABLE} WHERE payment_intent_id LIKE $1`, [`${PREFIX}%`])
      a.release()
    }
    b?.release()
    await pool?.end()
  })

  beforeEach(async () => {
    await a.query(`DELETE FROM ${PROBE}`)
    await a.query("DELETE FROM event_processed WHERE purchase_key LIKE $1", [`${PREFIX}%`])
    await a.query(`DELETE FROM ${OWED_UNIT_EFFECT_BARRIER_TABLE} WHERE payment_intent_id LIKE $1`, [`${PREFIX}%`])
  })

  for (const n of [1, 3]) {
    it(`AC1: obie trasy współbieżnie, N=${n} ⇒ skutków == kluczy == ${n}`, async () => {
      const pi = `${PREFIX}concurrent_${n}`
      const units = unitsFor(pi, n)
      const [ca, cb] = await Promise.all([
        settleAtomic(a, ROUTES[0], units),
        settleAtomic(b, ROUTES[1], units),
      ])
      expect(ca + cb).toBe(n)
      assertOneEffectPerUnit(await measure(a, pi), units.map((u) => u.key))
    })
  }

  it("AC1: ROLLBACK trasy po rezerwacji nie zostawia braku — druga trasa rozlicza jednostki", async () => {
    const pi = `${PREFIX}rollback`
    const units = unitsFor(pi, 3)
    const [failed, ok] = await Promise.allSettled([
      settleAtomic(a, ROUTES[0], units, { failAfterClaim: true }),
      (async () => {
        await new Promise((r) => setTimeout(r, 10))
        return settleAtomic(b, ROUTES[1], units)
      })(),
    ])
    expect(failed.status).toBe("rejected")
    expect(ok).toEqual({ status: "fulfilled", value: 3 })
    assertOneEffectPerUnit(await measure(a, pi), units.map((u) => u.key))
  })

  it("AC1 mutant: rezerwacja i skutek w dwóch transakcjach ⇒ brak skutku wykryty przez inwariant", async () => {
    const pi = `${PREFIX}mutant`
    const units = unitsFor(pi, 3)
    await settleSplitMutant(a, ROUTES[0], units, { failAfterClaim: true })
    await settleSplitMutant(b, ROUTES[1], units)
    const state = await measure(a, pi)
    expect(state.claimed).toHaveLength(3)
    expect(state.effects).toHaveLength(0)
    expect(() => assertOneEffectPerUnit(state, units.map((u) => u.key))).toThrow()
  })

  it("AC1: produkcyjny konsument (liveIssue) rezerwuje klucz jednostki w barierze w pierwszej instrukcji tx", async () => {
    const pi = `${PREFIX}live_issue`
    const order = "order_3_3_live"
    class StopAfterFirstQuery extends Error {}
    let calls = 0
    const firstStepOnly = {
      query: async (sql: string, params?: unknown[]) => {
        calls += 1
        if (calls > 1) throw new StopAfterFirstQuery()
        return a.query(sql, params as unknown[])
      },
    }
    const input = {
      event_type: EVENT_TYPE,
      payload: {
        payment_intent_id: pi,
        order_id: order,
        currency: "PLN",
        amount_minor: 1000,
        psp_occurred_at: "2026-11-14T12:00:00.000Z",
      },
      scope: SCOPE,
    }
    await a.query("BEGIN")
    try {
      await expect(
        liveIssueEntitlementsWithinTx(firstStepOnly as never, input as never, new Date())
      ).rejects.toBeInstanceOf(StopAfterFirstQuery)
      const barrier = await a.query(
        `SELECT owed_business_unit_key, instance_id, market_id, claimed_by_path
           FROM ${OWED_UNIT_EFFECT_BARRIER_TABLE} WHERE payment_intent_id = $1`,
        [pi]
      )
      expect(barrier.rows).toEqual([
        { owed_business_unit_key: `${pi}:${order}`, ...SCOPE, claimed_by_path: LIVE_ISSUE_PATH },
      ])
      const marker = await a.query("SELECT external_id FROM event_processed WHERE purchase_key = $1", [pi])
      expect(marker.rows).toEqual([{ external_id: `${pi}:${order}` }])
    } finally {
      await a.query("ROLLBACK")
    }
    // Inna trasa zarezerwowała jednostkę ⇒ konsument jest no-op (0 znaczników skutku).
    await a.query(
      `INSERT INTO ${OWED_UNIT_EFFECT_BARRIER_TABLE}
         (owed_business_unit_key, payment_intent_id, order_id, instance_id, market_id, claimed_by_path)
       VALUES ($1, $2, $3, $4, $5, 'route:native')`,
      [`${pi}:${order}`, pi, order, SCOPE.instance_id, SCOPE.market_id]
    )
    await a.query("BEGIN")
    try {
      const result = await liveIssueEntitlementsWithinTx(a as never, input as never, new Date())
      expect(result).toEqual({ event_processed: false, issued: [] })
    } finally {
      await a.query("ROLLBACK")
    }
  })

  it("AC2: quantity=2 w jednej kopercie ⇒ dwa rozłączne skutki, ponowienie = 0 nowych", async () => {
    const pi = `${PREFIX}quantity_2`
    const units = unitsFor(pi, 2)
    expect(new Set(units.map((u) => u.key)).size).toBe(2)
    expect(await settleAtomic(a, ROUTES[0], units)).toBe(2)
    expect(await settleAtomic(b, ROUTES[1], units)).toBe(0)
    expect(await settleAtomic(a, ROUTES[0], units)).toBe(0)
    assertOneEffectPerUnit(await measure(a, pi), units.map((u) => u.key))
  })

  it("AC3: instance_id i market_id NOT NULL; ENABLE/FORCE RLS i market_isolation dla medusa_store", async () => {
    const cols = await a.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1
          AND column_name IN ('instance_id','market_id') ORDER BY column_name`,
      [OWED_UNIT_EFFECT_BARRIER_TABLE]
    )
    expect(cols.rows).toEqual([
      { column_name: "instance_id", is_nullable: "NO" },
      { column_name: "market_id", is_nullable: "NO" },
    ])
    const rls = await a.query(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1",
      [OWED_UNIT_EFFECT_BARRIER_TABLE]
    )
    expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
    const policy = await a.query(
      "SELECT policyname, roles::text[] AS roles FROM pg_policies WHERE tablename = $1",
      [OWED_UNIT_EFFECT_BARRIER_TABLE]
    )
    expect(policy.rows).toEqual([{ policyname: "market_isolation", roles: ["medusa_store"] }])
  })

  it("AC3: runtime medusa_store nie zapisze wiersza bariery obcego rynku (WITH CHECK)", async () => {
    await a.query("BEGIN")
    try {
      await a.query("SET LOCAL ROLE medusa_store")
      await a.query("SELECT set_config('app.gp_instance_id', $1, true)", [SCOPE.instance_id])
      await a.query("SELECT set_config('app.gp_market_id', $1, true)", ["mkt_3_3_b"])
      await expect(
        a.query(
          `INSERT INTO ${OWED_UNIT_EFFECT_BARRIER_TABLE}
             (owed_business_unit_key, payment_intent_id, order_id, instance_id, market_id, claimed_by_path)
           VALUES ('${PREFIX}rls:o', '${PREFIX}rls', 'o', $1, $2, 'route:test')`,
          [SCOPE.instance_id, SCOPE.market_id]
        )
      ).rejects.toThrow(/row-level security/)
    } finally {
      await a.query("ROLLBACK")
    }
  })
})
