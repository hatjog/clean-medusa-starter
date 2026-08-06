/**
 * money-path-compensation-failure-pg.integration.test.ts — v1.15.0 Story 3.5
 * (FR-6c, NFR-3, AD-22).
 *
 * Rejestr nieudanych kompensacji wykonany PRZEZ SAM MODUŁ na REALNYM
 * PostgreSQL-u. Snapshot MikroORM ani sam plik migracji nie dowodzą niczego:
 * `CHECK`-i, `ON CONFLICT`, `NOT NULL` i indeks częściowy albo działają na
 * silniku, albo są prozą w pliku `.ts`.
 *
 * Uruchomienie (`DATABASE_URL` MUSI wskazywać IZOLOWANĄ bazę testową — suita
 * zakłada i kasuje `money_path_compensation_failure`):
 *
 *   DATABASE_URL=postgres://… TEST_TYPE=compensation-failure-pg pnpm jest
 *
 * Bez `DATABASE_URL` suita jest SKIP-owana z powodem — nigdy fałszywy PASS.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals"
import { Pool } from "pg"
import knexFactory from "knex"

import { Migration20260818090000MoneyPathCompensationFailureTable } from "../../migrations/Migration20260818090000MoneyPathCompensationFailureTable"
import {
  buildCompensationFailureId,
  buildPurchaseCorrelationKey,
  findOpenCompensationFailures,
  recordCompensationFailure,
  type CompensationFailureRecord,
} from "../../lib/payment/money-path-compensation-registry"
import {
  createKnexQueryClient,
  STRIPE_PATH_Y_WEBHOOK_PROVIDER,
} from "../../lib/payment/stripe-payment-intent-transport"

const DATABASE_URL = process.env.DATABASE_URL
const runOrSkip = DATABASE_URL ? describe : describe.skip

const EVT = "evt_pg_3_5"
const PI = "pi_pg_3_5"

/**
 * Wyciąga SQL z migracji BEZ uruchamiania MikroORM.
 *
 * `Migration.addSql` jest jedynym punktem, przez który migracja deklaruje
 * swoje DDL. Przechwytując go, wykonujemy DOKŁADNIE te stwierdzenia, które
 * pójdą na produkcję — nie ich ręcznie przepisaną kopię, która mogłaby się
 * rozjechać z plikiem i test świeciłby na zielono przy zepsutej migracji.
 */
function collectSql(direction: "up" | "down"): Promise<string[]> {
  const statements: string[] = []
  const migration = Object.create(
    Migration20260818090000MoneyPathCompensationFailureTable.prototype
  ) as Migration20260818090000MoneyPathCompensationFailureTable & {
    addSql: (sql: string) => void
  }
  migration.addSql = (sql: string) => {
    statements.push(sql)
  }
  return Promise.resolve(migration[direction]()).then(() => statements)
}

function record(
  overrides: Partial<CompensationFailureRecord> = {}
): CompensationFailureRecord {
  return {
    market_id: "bonbeauty",
    compensation_kind: "webhook_delivery_release",
    delivery_path: STRIPE_PATH_Y_WEBHOOK_PROVIDER,
    stripe_event_id: EVT,
    payment_intent_id: PI,
    order_id: "order_pg_3_5_a",
    purchase_correlation_key: buildPurchaseCorrelationKey(PI),
    failure_code: "delivery_release_failed",
    failure_detail: "PG: connection terminated during DELETE",
    ...overrides,
  }
}

runOrSkip("Story 3.5 AC2 — rejestr na REALNYM PostgreSQL-u", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL })
    for (const sql of await collectSql("up")) {
      await pool.query(sql)
    }
  })

  afterAll(async () => {
    if (!pool) return
    for (const sql of await collectSql("down")) {
      await pool.query(sql)
    }
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM money_path_compensation_failure")
  })

  it("`up` zakłada tabelę z `market_id NOT NULL` i oboma indeksami", async () => {
    const columns = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'money_path_compensation_failure'`
    )
    const byName = new Map(columns.rows.map((r) => [r.column_name, r.is_nullable]))
    expect(byName.get("market_id")).toBe("NO")
    expect(byName.get("purchase_correlation_key")).toBe("NO")
    // `order_id` jest skalarny i MOŻE być pusty (porażka przed rezolucją).
    expect(byName.get("order_id")).toBe("YES")

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'money_path_compensation_failure'`
    )
    const names = new Set(indexes.rows.map((r) => r.indexname))
    expect(names.has("idx_money_path_compensation_failure_open")).toBe(true)
    expect(names.has("idx_money_path_compensation_failure_correlation")).toBe(true)
  })

  it("zapisuje wiersz o oczekiwanej TREŚCI (nie `rowCount > 0`)", async () => {
    const written = await recordCompensationFailure(pool, record())
    expect(written.attempt_count).toBe(1)

    const rows = await pool.query(
      `SELECT * FROM money_path_compensation_failure WHERE failure_id = $1`,
      [written.failure_id]
    )
    expect(rows.rowCount).toBe(1)
    const row = rows.rows[0] as Record<string, unknown>
    expect(row.market_id).toBe("bonbeauty")
    expect(row.compensation_kind).toBe("webhook_delivery_release")
    expect(row.delivery_path).toBe(STRIPE_PATH_Y_WEBHOOK_PROVIDER)
    expect(row.stripe_event_id).toBe(EVT)
    expect(row.payment_intent_id).toBe(PI)
    expect(row.order_id).toBe("order_pg_3_5_a")
    expect(row.purchase_correlation_key).toBe(`purchase:${PI}`)
    expect(row.resolution_state).toBe("open")
    expect(row.resolved_at).toBeNull()
    expect(Number(row.attempt_count)).toBe(1)
  })

  it("ponowienie Stripe'a NIE mnoży wierszy i INKREMENTUJE licznik prób", async () => {
    await recordCompensationFailure(pool, record())
    await recordCompensationFailure(pool, record())
    const third = await recordCompensationFailure(pool, record())

    expect(third.attempt_count).toBe(3)
    const count = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM money_path_compensation_failure`
    )
    expect(count.rows[0].n).toBe("1")
  })

  it("N zamówień jednego zakupu = N ROZŁĄCZNYCH wierszy, złączalnych kluczem korelacji", async () => {
    await recordCompensationFailure(pool, record({ order_id: "order_pg_3_5_a" }))
    await recordCompensationFailure(
      pool,
      record({ order_id: "order_pg_3_5_b", market_id: "bongarden" })
    )

    const rows = await pool.query<{ order_id: string; market_id: string }>(
      `SELECT order_id, market_id
         FROM money_path_compensation_failure
        WHERE purchase_correlation_key = $1
        ORDER BY order_id`,
      [buildPurchaseCorrelationKey(PI)]
    )
    expect(rows.rows.map((r) => r.order_id)).toEqual([
      "order_pg_3_5_a",
      "order_pg_3_5_b",
    ])
    // Rynek każdego wiersza pochodzi z JEGO zamówienia — nie z `orders[0]`.
    expect(rows.rows.map((r) => r.market_id)).toEqual(["bonbeauty", "bongarden"])
  })

  it("`order_id IS NULL` NIE otwiera furtki na duplikaty (dlatego PK, nie UNIQUE)", async () => {
    await recordCompensationFailure(pool, record({ order_id: null }))
    const second = await recordCompensationFailure(pool, record({ order_id: null }))
    expect(second.attempt_count).toBe(2)

    const count = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM money_path_compensation_failure`
    )
    expect(count.rows[0].n).toBe("1")
  })

  it("silnik ODRZUCA `market_id NULL`, rodzaj spoza allow-listy i niespójne rozstrzygnięcie", async () => {
    const base = record()
    const id = buildCompensationFailureId(base)

    await expect(
      pool.query(
        `INSERT INTO money_path_compensation_failure
           (failure_id, market_id, compensation_kind, delivery_path, stripe_event_id,
            payment_intent_id, order_id, purchase_correlation_key, failure_code, failure_detail)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          `${id}_null_market`,
          base.compensation_kind,
          base.delivery_path,
          base.stripe_event_id,
          base.payment_intent_id,
          base.order_id,
          base.purchase_correlation_key,
          base.failure_code,
          base.failure_detail,
        ]
      )
    ).rejects.toThrow(/null value in column "market_id"/i)

    await expect(
      recordCompensationFailure(
        pool,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        record({ compensation_kind: "cos_wymyslonego" as any })
      )
    ).rejects.toThrow(/money_path_compensation_failure_kind_check/i)

    await recordCompensationFailure(pool, record())
    await expect(
      pool.query(
        `UPDATE money_path_compensation_failure
            SET resolution_state = 'resolved_manually'
          WHERE failure_id = $1`,
        [id]
      )
    ).rejects.toThrow(/money_path_compensation_failure_resolution_check/i)
  })

  it("zamknięcie ręczne wymaga KOMPLETU: stan + kiedy + kto", async () => {
    const written = await recordCompensationFailure(pool, record())
    await pool.query(
      `UPDATE money_path_compensation_failure
          SET resolution_state = 'resolved_manually',
              resolved_at = now(),
              resolved_by = $2
        WHERE failure_id = $1`,
      [written.failure_id, "robert@bonbeauty"]
    )
    const rows = await pool.query<{ resolution_state: string; resolved_by: string }>(
      `SELECT resolution_state, resolved_by FROM money_path_compensation_failure`
    )
    expect(rows.rows[0].resolution_state).toBe("resolved_manually")
    expect(rows.rows[0].resolved_by).toBe("robert@bonbeauty")
  })
})

/**
 * Dialekt PRODUKCYJNY na realnym silniku — review-fix cyklu 1.
 *
 * `RECORD_COMPENSATION_FAILURE_SQL` jest pisany w składni `$1..$10`, ale na
 * produkcji idzie ZAWSZE przez `createKnexQueryClient` → `toKnexPositionalSql`
 * (`?`) → `knex.raw`. Do tego review-fixu żaden test nie wykonywał tej gałęzi:
 * suita na realnym silniku używała `pg.Pool` (wariant `$N`), a test jednostkowy
 * nie wykonywał SQL-a wcale. Kształt wyniku `knex.raw` z `RETURNING`
 * (`result.rows` vs tablica) i normalizacja `attempt_count` przez `Number(...)`
 * były więc niepotwierdzone wykonaniem w tym właśnie dialekcie.
 */
runOrSkip("Story 3.5 review-fix — dialekt Knex (`?` + knex.raw) na realnym silniku", () => {
  let pool: Pool
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let knex: any

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL })
    for (const sql of await collectSql("down")) {
      await pool.query(sql).catch(() => undefined)
    }
    for (const sql of await collectSql("up")) {
      await pool.query(sql)
    }
    knex = knexFactory({ client: "pg", connection: DATABASE_URL })
  })

  afterAll(async () => {
    await knex?.destroy()
    for (const sql of await collectSql("down")) {
      await pool.query(sql).catch(() => undefined)
    }
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM money_path_compensation_failure")
  })

  it("`INSERT … RETURNING` przez `knex.raw` zwraca wiersz, a `attempt_count` jest LICZBĄ", async () => {
    const client = createKnexQueryClient(knex)

    const first = await recordCompensationFailure(client, record())
    expect(first.failure_id).toBe(
      buildCompensationFailureId({
        delivery_path: STRIPE_PATH_Y_WEBHOOK_PROVIDER,
        stripe_event_id: EVT,
        compensation_kind: "webhook_delivery_release",
        failure_code: "delivery_release_failed",
        order_id: record().order_id,
      })
    )
    // Sedno: gdyby `createKnexQueryClient` nie rozwinął wyniku na `rows`,
    // `recordCompensationFailure` rzuciłoby „INSERT nie zwrócił wiersza".
    expect(typeof first.attempt_count).toBe("number")
    expect(first.attempt_count).toBe(1)

    // `ON CONFLICT … DO UPDATE` przez ten sam dialekt — druga próba, nie drugi wiersz.
    const second = await recordCompensationFailure(client, record())
    expect(second.failure_id).toBe(first.failure_id)
    expect(second.attempt_count).toBe(2)
    expect(typeof second.attempt_count).toBe("number")

    const count = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM money_path_compensation_failure"
    )
    expect(count.rows[0].n).toBe("1")
  })

  it("`findOpenCompensationFailures` przez Knex widzi wiersz otwarty i NIE widzi zamkniętego", async () => {
    const client = createKnexQueryClient(knex)
    const written = await recordCompensationFailure(client, record())

    const open = await findOpenCompensationFailures(client, {
      delivery_path: STRIPE_PATH_Y_WEBHOOK_PROVIDER,
      stripe_event_id: EVT,
    })
    expect(open.map((row) => row.failure_id)).toEqual([written.failure_id])
    expect(typeof open[0].attempt_count).toBe("number")

    // Po ręcznym zamknięciu gałąź `duplicate` wraca do zwykłego ACK — bez tego
    // fix ponowień zamieniłby każdy `stripe events resend` w wieczne 500.
    await pool.query(
      `UPDATE money_path_compensation_failure
          SET resolution_state = 'resolved_manually',
              resolved_at = now(),
              resolved_by = $2
        WHERE failure_id = $1`,
      [written.failure_id, "robert@bonbeauty"]
    )
    const afterClose = await findOpenCompensationFailures(client, {
      delivery_path: STRIPE_PATH_Y_WEBHOOK_PROVIDER,
      stripe_event_id: EVT,
    })
    expect(afterClose).toEqual([])
  })
})
