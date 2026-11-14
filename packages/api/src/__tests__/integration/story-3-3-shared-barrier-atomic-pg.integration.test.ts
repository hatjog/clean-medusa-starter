/**
 * v1.16.0 Story 3.3 (FR-9, AD-33, AD-47, NFR-3, AD-44; ADR-242 Proposed) —
 * wspólna bariera idempotencji skutku jako JEDNA operacja atomowa, na realnym
 * PostgreSQL.
 *
 * Profil: `pnpm run test:integration:story-3-3-shared-barrier-pg`
 * Baza: izolowana `gp_story_3_3_test` (stack gp-test, port 55432); suita
 * odmawia startu na bazie bez sufiksu `_test`.
 *
 *  AC1 dwa równoległe połączenia PG (= dwie trasy z RÓŻNYM `event_type`, więc
 *      PK `event_processed (external_id, event_type)` NIE rozdziela ich) rozliczają
 *      te same N∈{1,3} jednostek produkcyjnym `buildOwedUnitEffectBarrierInsert`:
 *      skutków == unikalnych kluczy == znaczników == N; ROLLBACK jednej trasy po
 *      rezerwacji nie zostawia braku. Mutanty na kodzie produkcyjnym (zdjęte
 *      `WHERE EXISTS`) — wynik w evidence `ac1-ac2-ac3-shared-barrier-pg.md`.
 *  AC2 jedno zamówienie, jedna pozycja quantity=2 przez produkcyjny
 *      `liveIssueEntitlementsWithinTx` / `...PerLineWithinTx`: kontrakt egzekwuje
 *      quantity=1 (ADR-242 §Krotność) ⇒ fail-loud, 0 uprawnień, 0 wierszy bariery,
 *      ponowienie = 0 nowych skutków; quantity=1 ⇒ 1 uprawnienie, 1 wiersz bariery.
 *  AC3 `instance_id`, `market_id` NOT NULL (information_schema), RLS
 *      `market_isolation` dla `medusa_store`; backfill z `event_processed`
 *      (pełny scope ⇒ wiersz, NULL scope ⇒ brak) i fail-loud migracji pod rolą
 *      bez BYPASSRLS.
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
  LineIssueError,
  liveIssueEntitlementsPerLineWithinTx,
  liveIssueEntitlementsWithinTx,
} from "../../workflows/entitlements/live-issue-from-payment-intent"

const DATABASE_URL = process.env.DATABASE_URL
const enabled = !!DATABASE_URL

const EVENT_TYPE = "gp.stripe.payment_intent_succeeded.v1"
const SCOPE = { instance_id: "gp_test", market_id: "mkt_3_3_a" }
const PROBE = "story_3_3_effect_probe"
const PREFIX = "pi_3_3_"
const ROUTES = ["route:path-y", "route:native"] as const
/** Trasy zapisują RÓŻNE `event_type` — jedynym wspólnym nośnikiem jest bariera. */
const ROUTE_EVENT_TYPE: Record<string, string> = {
  "route:path-y": EVENT_TYPE,
  "route:native": "gp.stripe.payment_captured.v1",
}

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
      event_type: ROUTE_EVENT_TYPE[route] ?? EVENT_TYPE,
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

async function measure(client: PoolClient, pi: string) {
  const effects = await client.query<{ unit_key: string }>(
    `SELECT unit_key FROM ${PROBE} WHERE unit_key LIKE $1 ORDER BY unit_key`,
    [`${pi}:%`]
  )
  const q = buildOwedUnitEffectBarrierPurchaseQuery(pi)
  const barrier = await client.query<{ owed_business_unit_key: string }>(q.sql, q.params)
  const markers = await client.query<{ external_id: string }>(
    "SELECT external_id FROM event_processed WHERE purchase_key = $1 ORDER BY external_id",
    [pi]
  )
  return {
    effects: effects.rows.map((r) => r.unit_key),
    claimed: barrier.rows.map((r) => r.owed_business_unit_key),
    markers: markers.rows.map((r) => r.external_id),
  }
}

/** Inwariant AC1: dokładnie jeden skutek per zarezerwowany klucz, bez braków i duplikatów. */
function assertOneEffectPerUnit(
  state: { effects: string[]; claimed: string[]; markers: string[] },
  owed: string[]
): void {
  expect(state.effects).toEqual([...owed].sort())
  expect(new Set(state.effects).size).toBe(owed.length)
  expect(state.claimed).toEqual([...owed].sort())
  // jeden znacznik skutku per jednostka, mimo dwóch różnych event_type tras
  expect(state.markers).toEqual([...owed].sort())
}

/**
 * Lustra TEMP tabel czytanych/pisanych przez wystawcę (kształt jak w
 * `stripe-payment-intent-multi-order-pg`); `event_processed` i bariera są
 * REALNYMI tabelami `public` (migracja). Wywołujący trzyma otwartą tx.
 */
async function seedLiveIssueFixture(
  client: PoolClient,
  fx: { order: string; line: string; quantity: number; extraLines?: string[] }
): Promise<void> {
  const statements = [
    `CREATE TEMP TABLE sales_channel (id text PRIMARY KEY, metadata jsonb, deleted_at timestamptz) ON COMMIT DROP`,
    `CREATE TEMP TABLE "order" (id text PRIMARY KEY, sales_channel_id text, metadata jsonb, deleted_at timestamptz) ON COMMIT DROP`,
    `CREATE TEMP TABLE order_line_item (id text PRIMARY KEY, product_id text, unit_price numeric NOT NULL,
       title text, metadata jsonb, deleted_at timestamptz) ON COMMIT DROP`,
    `CREATE TEMP TABLE product (id text PRIMARY KEY, title text, metadata jsonb, deleted_at timestamptz) ON COMMIT DROP`,
    `CREATE TEMP TABLE product_product_seller_seller (product_id text NOT NULL, seller_id text NOT NULL,
       deleted_at timestamptz) ON COMMIT DROP`,
    `CREATE TEMP TABLE seller (id text PRIMARY KEY, name text NOT NULL, handle text NOT NULL, status text,
       deleted_at timestamptz) ON COMMIT DROP`,
    `CREATE TEMP TABLE voucher (code text PRIMARY KEY, market_id text, seller_id text NOT NULL,
       seller_name text NOT NULL, seller_handle text NOT NULL, product_title text NOT NULL,
       value_minor integer NOT NULL, currency_code text NOT NULL, status text NOT NULL,
       expires_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL) ON COMMIT DROP`,
    `CREATE TEMP TABLE order_item (order_id text NOT NULL, item_id text NOT NULL, quantity numeric NOT NULL,
       created_at timestamptz NOT NULL, deleted_at timestamptz) ON COMMIT DROP`,
    `CREATE TEMP TABLE entitlement_instance (id text PRIMARY KEY, entitlement_profile_id text NOT NULL,
       entitlement_type text NOT NULL, order_id text NOT NULL, line_item_id text NOT NULL, state text NOT NULL,
       policy_snapshot jsonb NOT NULL, market_id text NOT NULL, sales_channel_id text NOT NULL,
       vat_classification text NOT NULL, reference_price_minor integer,
       entitlement_dedupe_key text NOT NULL UNIQUE, recipient_index integer NOT NULL,
       recipient_customer_id text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
       claim_token text, expires_at timestamptz, UNIQUE (order_id, line_item_id)) ON COMMIT DROP`,
    `CREATE TEMP TABLE entitlement_choice_set_item (id text PRIMARY KEY, instance_id text NOT NULL,
       market_id text NOT NULL, label text, reference_amount_minor integer NOT NULL,
       remaining_minor integer NOT NULL, vat_classification text NOT NULL, status text NOT NULL,
       redemption_id text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL) ON COMMIT DROP`,
  ]
  for (const sql of statements) await client.query(sql)
  await client.query(`INSERT INTO sales_channel (id, metadata) VALUES ('sc_3_3', $1::jsonb)`, [
    JSON.stringify({ gp_market_id: SCOPE.market_id }),
  ])
  await client.query(`INSERT INTO "order" (id, sales_channel_id, metadata) VALUES ($1, 'sc_3_3', NULL)`, [fx.order])
  await client.query(`INSERT INTO product (id, title, metadata) VALUES ('prod_3_3', 'Voucher Salon 3.3', $1::jsonb)`, [
    JSON.stringify({
      gp: {
        entitlement_profile: {
          profile_id: "voucher-rezerwacja-otwarta",
          entitlement_type: "VOUCHER_SERVICE",
          currency: "PLN",
          policy: { validity_months: 12, vat_rate_uniqueness: true },
        },
      },
    }),
  ])
  await client.query(`INSERT INTO seller (id, name, handle, status) VALUES ('sel_3_3', 'Salon 3.3', 'salon-3-3', 'open')`)
  await client.query(`INSERT INTO product_product_seller_seller (product_id, seller_id) VALUES ('prod_3_3', 'sel_3_3')`)
  await client.query(
    `INSERT INTO order_line_item (id, product_id, unit_price, title, metadata)
     VALUES ($1, 'prod_3_3', 15000, 'Voucher Salon 3.3', NULL)`,
    [fx.line]
  )
  await client.query(
    `INSERT INTO order_item (order_id, item_id, quantity, created_at) VALUES ($1, $2, $3, NOW())`,
    [fx.order, fx.line, fx.quantity]
  )
  for (const extra of fx.extraLines ?? []) {
    await client.query(
      `INSERT INTO order_line_item (id, product_id, unit_price, title, metadata)
       VALUES ($1, 'prod_3_3', 15000, 'Voucher Salon 3.3', NULL)`,
      [extra]
    )
    await client.query(
      `INSERT INTO order_item (order_id, item_id, quantity, created_at) VALUES ($1, $2, 1, NOW())`,
      [fx.order, extra]
    )
  }
}

function liveInput(pi: string, order: string) {
  return {
    event_type: EVENT_TYPE,
    payload: {
      payment_intent_id: pi,
      order_id: order,
      currency: "PLN",
      amount_minor: 15000,
      psp_occurred_at: "2026-11-14T12:00:00.000Z",
    },
    scope: SCOPE,
  }
}

async function countFor(client: PoolClient, pi: string, order: string) {
  const one = async (sql: string, params: unknown[]) =>
    Number((await client.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0)
  return {
    entitlements: await one("SELECT count(*) AS n FROM entitlement_instance WHERE order_id = $1", [order]),
    barrier: await one(`SELECT count(*) AS n FROM ${OWED_UNIT_EFFECT_BARRIER_TABLE} WHERE payment_intent_id = $1`, [pi]),
    markers: await one("SELECT count(*) AS n FROM event_processed WHERE purchase_key = $1", [pi]),
  }
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

  it("AC2: jedno zamówienie, jedna pozycja quantity=2 ⇒ fail-loud (kontrakt quantity=1), 0 uprawnień, 0 wierszy bariery, ponowienie = 0 nowych", async () => {
    const pi = `${PREFIX}quantity_2`
    const order = "order_3_3_q2"
    const line = "li_3_3_q2"
    await a.query("BEGIN")
    try {
      await seedLiveIssueFixture(a, { order, line, quantity: 2 })
      for (const attempt of [1, 2]) {
        await a.query("SAVEPOINT attempt")
        let caught: unknown
        try {
          await liveIssueEntitlementsWithinTx(a as never, liveInput(pi, order) as never, new Date())
        } catch (err) {
          caught = err
        }
        expect(caught).toBeInstanceOf(LineIssueError)
        expect((caught as LineIssueError).reason).toBe("quantity_per_line_unsupported")
        // caller (subscriber) cofa tx ⇒ rezerwacja bariery i znacznik cofnięte razem
        await a.query("ROLLBACK TO SAVEPOINT attempt")
        expect({ attempt, ...(await countFor(a, pi, order)) }).toEqual({
          attempt,
          entitlements: 0,
          barrier: 0,
          markers: 0,
        })
      }
      // tryb izolacji linii (8.4, odzysk on-order-placed): nazwana porażka linii,
      // event NIE skonsumowany, bariera cofnięta razem ze znacznikiem
      const perLine = await liveIssueEntitlementsPerLineWithinTx(a as never, liveInput(pi, order) as never, new Date())
      expect(perLine.event_processed).toBe(false)
      expect(perLine.failed_lines.map((f) => [f.line_item_id, f.reason])).toEqual([
        [line, "quantity_per_line_unsupported"],
      ])
      expect(await countFor(a, pi, order)).toEqual({ entitlements: 0, barrier: 0, markers: 0 })
    } finally {
      await a.query("ROLLBACK")
    }
  })

  it("AC2: jedna pozycja quantity=1 ⇒ 1 uprawnienie, 1 wiersz bariery; ponowienie = 0 nowych skutków", async () => {
    const pi = `${PREFIX}quantity_1`
    const order = "order_3_3_q1"
    await a.query("BEGIN")
    try {
      await seedLiveIssueFixture(a, { order, line: "li_3_3_q1", quantity: 1 })
      const first = await liveIssueEntitlementsWithinTx(a as never, liveInput(pi, order) as never, new Date())
      expect(first.event_processed).toBe(true)
      expect(first.issued.map((e) => e.created)).toEqual([true])
      expect(await countFor(a, pi, order)).toEqual({ entitlements: 1, barrier: 1, markers: 1 })
      const retry = await liveIssueEntitlementsWithinTx(a as never, liveInput(pi, order) as never, new Date())
      expect(retry).toEqual({ event_processed: false, issued: [] })
      expect(await countFor(a, pi, order)).toEqual({ entitlements: 1, barrier: 1, markers: 1 })
    } finally {
      await a.query("ROLLBACK")
    }
  })

  it("AC2: dwie należne jednostki w jednej kopercie (dwie pozycje quantity=1) ⇒ 2 rozłączne uprawnienia, 1 wiersz bariery koperty; ponowienie = 0 nowych", async () => {
    const pi = `${PREFIX}two_lines`
    const order = "order_3_3_two_lines"
    await a.query("BEGIN")
    try {
      await seedLiveIssueFixture(a, { order, line: "li_3_3_l1", quantity: 1, extraLines: ["li_3_3_l2"] })
      const first = await liveIssueEntitlementsWithinTx(a as never, liveInput(pi, order) as never, new Date())
      expect(first.issued.map((e) => e.line_item_id).sort()).toEqual(["li_3_3_l1", "li_3_3_l2"])
      expect(new Set(first.issued.map((e) => e.entitlement_dedupe_key)).size).toBe(2)
      expect(await countFor(a, pi, order)).toEqual({ entitlements: 2, barrier: 1, markers: 1 })
      const retry = await liveIssueEntitlementsWithinTx(a as never, liveInput(pi, order) as never, new Date())
      expect(retry).toEqual({ event_processed: false, issued: [] })
      expect(await countFor(a, pi, order)).toEqual({ entitlements: 2, barrier: 1, markers: 1 })
    } finally {
      await a.query("ROLLBACK")
    }
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

  it("AC3: backfill z event_processed — pełny scope ⇒ wiersz 'backfill:event_processed', NULL scope ⇒ brak", async () => {
    const pi = `${PREFIX}backfill`
    const now = Date.now()
    await a.query(
      `INSERT INTO event_processed (external_id, event_type, processed_at, purchase_key, instance_id, market_id) VALUES
         ($1 || ':order_full', $2, $3, $1, $4, $5),
         ($1 || ':order_null_scope', $2, $3, $1, NULL, NULL),
         ($1 || ':order_other_type', 'gp.stripe.payment_captured.v1', $3, $1, $4, $5)`,
      [pi, EVENT_TYPE, now, SCOPE.instance_id, SCOPE.market_id]
    )
    for (const sql of await collectSql("down")) await a.query(sql)
    for (const sql of await collectSql("up")) await a.query(sql)
    const rows = await a.query(
      `SELECT owed_business_unit_key, order_id, instance_id, market_id, claimed_by_path
         FROM ${OWED_UNIT_EFFECT_BARRIER_TABLE} WHERE payment_intent_id = $1 ORDER BY 1`,
      [pi]
    )
    expect(rows.rows).toEqual([
      {
        owed_business_unit_key: `${pi}:order_full`,
        order_id: "order_full",
        ...SCOPE,
        claimed_by_path: "backfill:event_processed",
      },
    ])
  })

  it("AC3: migracja pod rolą bez BYPASSRLS/superusera odmawia backfillu (fail-loud), zamiast cicho przenieść 0 wierszy", async () => {
    const role = await a.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'gp_runtime_recovery_migrator'"
    )
    expect(role.rows).toEqual([{ rolbypassrls: false, rolsuper: false }])
    await a.query("BEGIN")
    try {
      await a.query(
        `INSERT INTO event_processed (external_id, event_type, processed_at, purchase_key, instance_id, market_id)
         VALUES ($1 || ':order_hidden', $2, $3, $1, $4, $5)`,
        [`${PREFIX}blind`, EVENT_TYPE, Date.now(), SCOPE.instance_id, SCOPE.market_id]
      )
      await a.query("SET LOCAL ROLE gp_runtime_recovery_migrator")
      // ta rola NIE widzi wierszy event_processed (FORCE RLS) — dokładnie stan cichego zera
      const visible = await a.query<{ n: string }>("SELECT count(*) AS n FROM event_processed")
      expect(Number(visible.rows[0]?.n)).toBe(0)
      const [first] = await collectSql("up")
      await expect(a.query(first as string)).rejects.toThrow(/GP_OWED_UNIT_BARRIER_BACKFILL_BLIND/)
    } finally {
      await a.query("ROLLBACK")
    }
  })
})
