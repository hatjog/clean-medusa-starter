/**
 * story-3-2-migration-pg.integration.test.ts — Story 3.2 review-fix AI-01 / AI-04.
 *
 * Test BEHAWIORALNY na REALNYM PostgreSQL (nie tylko regex na DDL). Dowodzi, że:
 *
 *   (AI-01 / HIGH) realny `db:migrate` Story 3.2 NIE łamie aktywnej ścieżki
 *     live-issue: INSERT live-issued (`order_id NOT NULL`, `market_id` ustawiony,
 *     `sales_channel_id` = NULL — dokładnie to, co produkuje
 *     `issueEntitlementWithinPaymentTransaction`) PRZECHODZI po migracji;
 *   (AI-04 / LOW) CHECK `entitlement_instance_market_scope_chk` egzekwuje fail-closed
 *     behawioralnie: live-issued bez `market_id` jest ODRZUCONY w DB;
 *   (AI-04 / LOW) replay `event_processed` (ON CONFLICT DO NOTHING) jest NO-OP-em
 *     na realnym PG (nie podwaja wiersza, zachowuje pierwotny `processed_at`).
 *
 * POSTURE (spójnie z `entitlement-instance-creation.test.ts` Layer 2): opt-in,
 * gate `GP_RUN_MIGRATION_INTEGRATION=1` + `DATABASE_URL`. Bez gate'a => `describe.skip`
 * (quick-gate w worktree bez docker-compose pozostaje zielony — authored-not-applied).
 *
 * NON-DESTRUKCYJNY: każdy przypadek działa w `BEGIN ... ROLLBACK` na tymczasowej,
 * lokalnej (per-transakcja) tabeli `entitlement_instance` — ZERO trwałych zapisów,
 * bezpieczne nawet na współdzielonej bazie dev.
 */

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { Migration1778928000000 } from "../../modules/voucher/migrations/1778928000000_create_event_processed_table"
import { Migration1778928100000 } from "../../modules/voucher/migrations/1778928100000_add_vat_classification_and_ontology_fk"
import { buildEventProcessedDedupeInsert } from "../../modules/voucher/models/event-processed"

/** Zbiera surowe stringi SQL z `up()` danej migracji (jak `addSql` w Mikro-ORM). */
function collectUpSql(MigrationClass: { prototype: unknown }): string[] {
  const sqls: string[] = []
  const fakeThis = { addSql: (s: string) => sqls.push(s) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(MigrationClass.prototype as any).up.call(fakeThis)
  return sqls
}

// Minimalny szkielet `entitlement_instance` (podzbiór kolumn NOT NULL z
// `1778880672656_create_entitlement_profiles_section.ts` + market_id) — tworzony
// w obrębie transakcji, więc ROLLBACK go usuwa. Pozwala testować ALTER/CHECK
// Story 3.2 bez zależności od pełnego stanu migracji bazy.
const CREATE_MINIMAL_ENTITLEMENT_INSTANCE = `
  CREATE TABLE entitlement_instance (
    id                     text PRIMARY KEY,
    entitlement_profile_id text NOT NULL,
    entitlement_type       text NOT NULL,
    order_id               text NULL,
    market_id              text NULL,
    state                  text NOT NULL DEFAULT 'ISSUED',
    policy_snapshot        jsonb NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
  )
`

const runIntegration =
  process.env.GP_RUN_MIGRATION_INTEGRATION === "1" && !!process.env.DATABASE_URL
const maybe = runIntegration ? describe : describe.skip

maybe("Story 3.2 — migracja na realnym PG (review AI-01 / AI-04)", () => {
  let pool: Pool

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "GP_RUN_MIGRATION_INTEGRATION=1 wymaga DATABASE_URL (PG do migracji)"
      )
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
  })

  afterAll(async () => {
    if (pool) {
      await pool.end()
    }
  })

  /**
   * Wykonuje callback w izolowanej transakcji z lokalną `entitlement_instance`
   * (po migracji Story 3.2), gwarantując ROLLBACK (zero trwałych zmian).
   */
  async function withMigratedTx(fn: (c: PoolClient) => Promise<void>): Promise<void> {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      // tabela widoczna tylko w tej transakcji (DROP na ROLLBACK)
      await client.query("CREATE TEMP TABLE IF NOT EXISTS _noop_guard (x int)")
      await client.query(CREATE_MINIMAL_ENTITLEMENT_INSTANCE)
      // realny up() Story 3.2 (event_processed + ontologia FK + CHECK-i)
      for (const sql of [
        ...collectUpSql(Migration1778928000000),
        ...collectUpSql(Migration1778928100000),
      ]) {
        await client.query(sql)
      }
      await fn(client)
    } finally {
      await client.query("ROLLBACK")
      client.release()
    }
  }

  it("(AI-01) live-issue INSERT (order_id NOT NULL, market_id set, sales_channel_id NULL) PRZECHODZI po migracji", async () => {
    await withMigratedTx(async (c) => {
      // dokładnie kształt z issue-entitlement.ts:301 (sales_channel_id NIE ustawiany)
      await expect(
        c.query(
          `INSERT INTO entitlement_instance
             (id, entitlement_profile_id, entitlement_type, order_id, market_id,
              state, policy_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            "ent_ai01_live",
            "voucher-rezerwacja-otwarta",
            "VOUCHER_SERVICE",
            "order_ai01_001",
            "bonbeauty",
            "ACTIVE",
            JSON.stringify({ validity_months: 12 }),
          ]
        )
      ).resolves.toBeDefined()

      const check = await c.query<{ market_id: string; sales_channel_id: string | null }>(
        `SELECT market_id, sales_channel_id FROM entitlement_instance WHERE id = $1`,
        ["ent_ai01_live"]
      )
      expect(check.rows[0].market_id).toBe("bonbeauty")
      expect(check.rows[0].sales_channel_id).toBeNull()
    })
  })

  it("(AI-04) fail-closed: live-issued (order_id NOT NULL) BEZ market_id jest ODRZUCONY", async () => {
    await withMigratedTx(async (c) => {
      await expect(
        c.query(
          `INSERT INTO entitlement_instance
             (id, entitlement_profile_id, entitlement_type, order_id, market_id,
              state, policy_snapshot)
           VALUES ($1, $2, $3, $4, NULL, $5, $6::jsonb)`,
          [
            "ent_ai04_noscope",
            "voucher-rezerwacja-otwarta",
            "VOUCHER_SERVICE",
            "order_ai04_001",
            "ACTIVE",
            JSON.stringify({ validity_months: 12 }),
          ]
        )
      ).rejects.toThrow(/entitlement_instance_market_scope_chk/)
    })
  })

  it("(AI-04) legacy (order_id NULL) bez scope PRZECHODZI (zwolniony z CHECK-u)", async () => {
    await withMigratedTx(async (c) => {
      await expect(
        c.query(
          `INSERT INTO entitlement_instance
             (id, entitlement_profile_id, entitlement_type, order_id, market_id,
              state, policy_snapshot)
           VALUES ($1, $2, $3, NULL, NULL, $4, $5::jsonb)`,
          [
            "ent_legacy",
            "voucher-rezerwacja-otwarta",
            "VOUCHER_SERVICE",
            "ISSUED",
            JSON.stringify({ validity_months: 12 }),
          ]
        )
      ).resolves.toBeDefined()
    })
  })

  it("(AI-04) vat_classification: SPV/MPV OK, wartość spoza domeny ODRZUCONA", async () => {
    await withMigratedTx(async (c) => {
      await c.query(
        `INSERT INTO entitlement_instance
           (id, entitlement_profile_id, entitlement_type, order_id, market_id,
            vat_classification, state, policy_snapshot)
         VALUES ('ent_vat_ok','p','VOUCHER_SERVICE','order_vat','bonbeauty','SPV','ACTIVE','{}'::jsonb)`
      )
      await expect(
        c.query(
          `INSERT INTO entitlement_instance
             (id, entitlement_profile_id, entitlement_type, order_id, market_id,
              vat_classification, state, policy_snapshot)
           VALUES ('ent_vat_bad','p','VOUCHER_SERVICE','order_vat2','bonbeauty','XX','ACTIVE','{}'::jsonb)`
        )
      ).rejects.toThrow(/entitlement_instance_vat_classification_chk/)
    })
  })

  it("(AI-04) event_processed replay: ON CONFLICT DO NOTHING = NO-OP (nie podwaja, zachowuje processed_at)", async () => {
    await withMigratedTx(async (c) => {
      const first = buildEventProcessedDedupeInsert({
        external_id: "pi_pg_replay",
        event_type: "gp.stripe.payment_intent_succeeded.v1",
        processed_at: 1_780_000_000_000,
      })
      const r1 = await c.query(first.sql, first.params)
      expect(r1.rowCount).toBe(1)

      // replay tego samego (external_id, event_type) z późniejszym processed_at
      const replay = buildEventProcessedDedupeInsert({
        external_id: "pi_pg_replay",
        event_type: "gp.stripe.payment_intent_succeeded.v1",
        processed_at: 1_780_000_999_999,
      })
      const r2 = await c.query(replay.sql, replay.params)
      expect(r2.rowCount).toBe(0) // NO-OP

      const rows = await c.query<{ count: string; processed_at: string }>(
        `SELECT count(*) AS count, max(processed_at) AS processed_at
           FROM event_processed WHERE external_id = $1`,
        ["pi_pg_replay"]
      )
      expect(Number(rows.rows[0].count)).toBe(1) // brak podwojenia
      expect(Number(rows.rows[0].processed_at)).toBe(1_780_000_000_000) // pierwotny zachowany
    })
  })
})
