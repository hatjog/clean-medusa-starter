/**
 * story-3-3-purchase-key-migration-pg.integration.test.ts — Story 3.3 AC3.
 *
 * Dowód z WYKONANIA, nie z obecności pliku: migracja `1779006000000`
 * (`event_processed.purchase_key`, AD-16 / ADR-190) jest realnie stosowana na
 * PostgreSQL — `up()` dodaje kolumnę i indeks, `down()` jest udokumentowanym,
 * NON-DESTRUKCYJNYM no-opem (kolumna PRZEŻYWA rollback; usunięcie jej zniszczyłoby
 * jedyny nieparsowany nośnik związku N kopert z jednym zakupem).
 *
 * Test zrzuca kształt `event_processed` PRZED i PO `up()` oraz PO `down()` z
 * `information_schema` — to jest odpowiednik `\d event_processed`, który AC3
 * wymaga w evidence.
 *
 * POSTURE (spójnie z `story-3-2-migration-pg.integration.test.ts`): opt-in,
 * gate `GP_RUN_MIGRATION_INTEGRATION=1` + `DATABASE_URL`; bez gate'a `describe.skip`
 * (quick-gate w worktree bez docker-compose zostaje zielony).
 *
 * NON-DESTRUKCYJNY: całość w `BEGIN ... ROLLBACK` na TYMCZASOWEJ tabeli
 * (`CREATE TEMP TABLE ... ON COMMIT DROP`) — zero trwałych zapisów, bezpieczne
 * także na współdzielonej bazie.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { Migration1779006000000 } from "../../modules/voucher/migrations/1779006000000_add_purchase_key_to_event_processed"
import {
  EVENT_PROCESSED_PURCHASE_KEY_COLUMN,
  buildEventProcessedDedupeInsert,
  buildEventProcessedPurchaseQuery,
} from "../../modules/voucher/models/event-processed"

const PAYMENT_INTENT_ID = "pi_story_3_3_proof"

function collectSql(direction: "up" | "down"): string[] {
  const sqls: string[] = []
  const fakeThis = { addSql: (s: string) => sqls.push(s) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(Migration1779006000000.prototype as any)[direction].call(fakeThis)
  return sqls
}

const runIntegration =
  process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL
const maybe = runIntegration ? describe : describe.skip

maybe("Story 3.3 AC3 — migracja purchase_key na realnym PG", () => {
  let pool: Pool
  let client: PoolClient

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    client = await pool.connect()
  })

  afterAll(async () => {
    client?.release()
    await pool?.end()
  })

  /** Kształt kolumn `event_processed` — odpowiednik `\d event_processed`. */
  async function describeTable(c: PoolClient): Promise<string[]> {
    const rows = await c.query<{
      column_name: string
      data_type: string
      is_nullable: string
    }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'event_processed'
          AND table_schema LIKE 'pg_temp_%'
        ORDER BY ordinal_position`
    )
    return rows.rows.map(
      (row) => `${row.column_name} ${row.data_type} nullable=${row.is_nullable}`
    )
  }

  it("up() dodaje kolumnę + indeks, down() NIE usuwa (append-only), zapis i odczyt po kolumnie działa", async () => {
    await client.query("BEGIN")
    try {
      // stan zastany: `event_processed` sprzed migracji 3.3
      await client.query(`
        CREATE TEMP TABLE event_processed (
          external_id  text NOT NULL CHECK (char_length(external_id) > 0),
          event_type   text NOT NULL CHECK (char_length(event_type) > 0),
          processed_at bigint NOT NULL CHECK (processed_at > 0),
          CONSTRAINT event_processed_pkey PRIMARY KEY (external_id, event_type)
        ) ON COMMIT DROP
      `)

      const before = await describeTable(client)
      // eslint-disable-next-line no-console
      console.log("\\d event_processed PRZED up():\n  " + before.join("\n  "))
      expect(before.some((line) => line.startsWith("purchase_key "))).toBe(false)

      for (const sql of collectSql("up")) await client.query(sql)

      const afterUp = await describeTable(client)
      // eslint-disable-next-line no-console
      console.log("\\d event_processed PO up():\n  " + afterUp.join("\n  "))
      expect(afterUp.some((line) => line.startsWith("purchase_key text"))).toBe(true)

      const indexes = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE tablename = 'event_processed'
            AND indexname = 'event_processed_purchase_key_idx'`
      )
      expect(indexes.rowCount).toBe(1)

      // zapis prymitywem produkcyjnym: dwa wiersze pętli jednego zakupu
      for (const orderId of ["order_a", "order_b"]) {
        const insert = buildEventProcessedDedupeInsert({
          external_id: `${PAYMENT_INTENT_ID}:${orderId}`,
          event_type: "gp.stripe.payment_intent_succeeded.v1",
          processed_at: 1_780_000_000_000,
          purchase_key: PAYMENT_INTENT_ID,
        })
        expect((await client.query(insert.sql, insert.params)).rowCount).toBe(1)
      }

      // odczyt PO KOLUMNIE (AC2) — zero parsowania external_id
      const query = buildEventProcessedPurchaseQuery(PAYMENT_INTENT_ID)
      expect(query.sql).toContain(`WHERE ${EVENT_PROCESSED_PURCHASE_KEY_COLUMN} = $1`)
      const correlated = await client.query<{ external_id: string }>(
        query.sql,
        query.params
      )
      expect(correlated.rows.map((row) => row.external_id)).toEqual([
        `${PAYMENT_INTENT_ID}:order_a`,
        `${PAYMENT_INTENT_ID}:order_b`,
      ])

      // CHECK broni pustego klucza zakupu (pusty string ≠ brak korelacji).
      // SAVEPOINT, bo naruszenie CHECK-a przerywa całą transakcję w PG.
      await client.query("SAVEPOINT przed_naruszeniem_check")
      await expect(
        client.query(
          `INSERT INTO event_processed (external_id, event_type, processed_at, purchase_key)
           VALUES ('x','y',1,'')`
        )
      ).rejects.toThrow(/purchase_key/)
      await client.query("ROLLBACK TO SAVEPOINT przed_naruszeniem_check")

      for (const sql of collectSql("down")) await client.query(sql)
      const afterDown = await describeTable(client)
      // eslint-disable-next-line no-console
      console.log("\\d event_processed PO down():\n  " + afterDown.join("\n  "))
      // down() jest no-opem: kolumna PRZEŻYWA rollback (append-only, NIE DROP).
      expect(afterDown).toEqual(afterUp)
    } finally {
      await client.query("ROLLBACK")
    }
  })
})
