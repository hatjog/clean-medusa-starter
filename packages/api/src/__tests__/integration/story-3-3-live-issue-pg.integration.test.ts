/**
 * story-3-3-live-issue-pg.integration.test.ts — Story 3.3 AC3 / AC4 (real-PG).
 *
 * Test BEHAWIORALNY na REALNYM PostgreSQL (nie tylko regex na DDL). Dowodzi:
 *
 *   (AC3 / korekta M2) `vat_classification` jest NIEZMIENNE po ISSUED: snapshot
 *     z momentu sprzedaży przeżywa kolejne odczyty ORAZ niezwiązane UPDATE-y wiersza
 *     (np. tranzycja stanu ISSUED→ACTIVE). System NIE reklasyfikuje już sprzedanej
 *     instancji (FR32, TSUE C-68/23) — brak triggera reklasyfikacji w DB.
 *   (AC4 / DEC-5 pkt 3.ii) per-entitlement dedupe na realnym PG: drugi INSERT z tym
 *     samym `entitlement_dedupe_key` (`ON CONFLICT (entitlement_dedupe_key) DO NOTHING`)
 *     jest NO-OP-em (0 affected) — partial UNIQUE index nie podwaja entitlementu;
 *     różny `recipient_index` ⇒ różny klucz ⇒ osobny wiersz (FR10).
 *
 * POSTURE (spójnie z `story-3-2-migration-pg.integration.test.ts`): opt-in, gate
 * `GP_RUN_MIGRATION_INTEGRATION=1` + `DATABASE_URL`. Bez gate'a ⇒ `describe.skip`
 * (quick-gate w worktree bez docker-compose pozostaje zielony — authored-not-applied).
 * NIE-DESTRUKCYJNY: każdy przypadek w `BEGIN ... ROLLBACK` na tymczasowej tabeli.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import { Migration1778928100000 } from "../../modules/voucher/migrations/1778928100000_add_vat_classification_and_ontology_fk"
import { Migration1778928200000 } from "../../modules/voucher/migrations/1778928200000_add_entitlement_dedupe_key_and_recipient_index"
import { Migration1778928300000 } from "../../modules/voucher/migrations/1778928300000_tighten_sales_channel_scope_live_issue"
import { buildEntitlementDedupeKey } from "../../modules/voucher/models/entitlement-dedupe"

function collectUpSql(MigrationClass: { prototype: unknown }): string[] {
  const sqls: string[] = []
  const fakeThis = { addSql: (s: string) => sqls.push(s) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(MigrationClass.prototype as any).up.call(fakeThis)
  return sqls
}

// Szkielet `entitlement_instance` z kolumnami potrzebnymi do 3.2/3.3 up().
const CREATE_MINIMAL_ENTITLEMENT_INSTANCE = `
  CREATE TABLE entitlement_instance (
    id                     text PRIMARY KEY,
    entitlement_profile_id text NOT NULL,
    entitlement_type       text NOT NULL,
    order_id               text NULL,
    line_item_id           text NULL,
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

maybe("Story 3.3 — live-issue na realnym PG (AC3 vat-stability + AC4 dedupe)", () => {
  let pool: Pool

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error("GP_RUN_MIGRATION_INTEGRATION=1 wymaga DATABASE_URL")
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
  })

  afterAll(async () => {
    if (pool) await pool.end()
  })

  async function withMigratedTx(fn: (c: PoolClient) => Promise<void>): Promise<void> {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(CREATE_MINIMAL_ENTITLEMENT_INSTANCE)
      for (const sql of [
        ...collectUpSql(Migration1778928100000),
        ...collectUpSql(Migration1778928200000),
        ...collectUpSql(Migration1778928300000),
      ]) {
        await client.query(sql)
      }
      await fn(client)
    } finally {
      await client.query("ROLLBACK")
      client.release()
    }
  }

  it("(AC3) vat_classification NIEZMIENNE po ISSUED — przeżywa UPDATE stanu", async () => {
    await withMigratedTx(async (c) => {
      await c.query(
        `INSERT INTO entitlement_instance
           (id, entitlement_profile_id, entitlement_type, order_id, line_item_id,
            market_id, sales_channel_id, vat_classification, entitlement_dedupe_key,
            recipient_index, state, policy_snapshot)
         VALUES ('ent_vat_snap','p','VOUCHER_SERVICE','order_1','li_1','bonbeauty',
                 'sc_1','SPV',$1,0,'ISSUED','{"validity_months":12}'::jsonb)`,
        [buildEntitlementDedupeKey("pi_snap", "li_1", 0)]
      )

      // niezwiązana mutacja wiersza (tranzycja stanu) — NIE rusza vat_classification
      await c.query(
        `UPDATE entitlement_instance SET state='ACTIVE', updated_at=now() WHERE id='ent_vat_snap'`
      )

      const res = await c.query<{ vat_classification: string; state: string }>(
        `SELECT vat_classification, state FROM entitlement_instance WHERE id='ent_vat_snap'`
      )
      expect(res.rows[0].state).toBe("ACTIVE")
      expect(res.rows[0].vat_classification).toBe("SPV") // snapshot niezmienny (FR32)
    })
  })

  it("(AC4) per-entitlement dedupe: 2. INSERT tego samego klucza = NO-OP (partial UNIQUE)", async () => {
    await withMigratedTx(async (c) => {
      const key = buildEntitlementDedupeKey("pi_dup", "li_1", 0)
      const insert = (id: string) =>
        c.query(
          `INSERT INTO entitlement_instance
             (id, entitlement_profile_id, entitlement_type, order_id, line_item_id,
              market_id, sales_channel_id, vat_classification, entitlement_dedupe_key,
              recipient_index, state, policy_snapshot)
           VALUES ($1,'p','VOUCHER_SERVICE','order_d','li_1','bonbeauty','sc_1','SPV',$2,0,
                   'ISSUED','{}'::jsonb)
           ON CONFLICT (entitlement_dedupe_key) DO NOTHING`,
          [id, key]
        )

      const r1 = await insert("ent_dup_1")
      expect(r1.rowCount).toBe(1)
      const r2 = await insert("ent_dup_2") // ten sam klucz, inny id
      expect(r2.rowCount).toBe(0) // NO-OP

      const count = await c.query<{ count: string }>(
        `SELECT count(*) AS count FROM entitlement_instance WHERE entitlement_dedupe_key=$1`,
        [key]
      )
      expect(Number(count.rows[0].count)).toBe(1) // brak podwojenia
    })
  })

  it("(AC4/FR10) różny recipient_index ⇒ różny klucz ⇒ osobny wiersz", async () => {
    await withMigratedTx(async (c) => {
      const insert = (idx: number) =>
        c.query(
          `INSERT INTO entitlement_instance
             (id, entitlement_profile_id, entitlement_type, order_id, line_item_id,
              market_id, sales_channel_id, vat_classification, entitlement_dedupe_key,
              recipient_index, state, policy_snapshot)
           VALUES ($1,'p','VOUCHER_SERVICE','order_m','li_g','bonbeauty','sc_1','MPV',$2,$3,
                   'ISSUED','{}'::jsonb)
           ON CONFLICT (entitlement_dedupe_key) DO NOTHING`,
          [`ent_r${idx}`, buildEntitlementDedupeKey("pi_multi", "li_g", idx), idx]
        )
      expect((await insert(0)).rowCount).toBe(1)
      expect((await insert(1)).rowCount).toBe(1)
      expect((await insert(2)).rowCount).toBe(1)

      const count = await c.query<{ count: string }>(
        `SELECT count(*) AS count FROM entitlement_instance WHERE order_id='order_m'`
      )
      expect(Number(count.rows[0].count)).toBe(3)
    })
  })

  it("(H1) live-issued (dedupe_key) Z sales_channel_id PRZECHODZI", async () => {
    await withMigratedTx(async (c) => {
      const r = await c.query(
        `INSERT INTO entitlement_instance
           (id, entitlement_profile_id, entitlement_type, order_id, line_item_id,
            market_id, sales_channel_id, vat_classification, entitlement_dedupe_key,
            recipient_index, state, policy_snapshot)
         VALUES ('ent_h1_ok','p','VOUCHER_SERVICE','order_h1','li_1','bonbeauty','sc_1','SPV',$1,0,
                 'ISSUED','{}'::jsonb)`,
        [buildEntitlementDedupeKey("pi_h1", "li_1", 0)]
      )
      expect(r.rowCount).toBe(1)
    })
  })

  it("(H1) live-issued (dedupe_key) BEZ sales_channel_id ODRZUCONY (fail-closed scope)", async () => {
    await withMigratedTx(async (c) => {
      await expect(
        c.query(
          `INSERT INTO entitlement_instance
             (id, entitlement_profile_id, entitlement_type, order_id, line_item_id,
              market_id, vat_classification, entitlement_dedupe_key, recipient_index,
              state, policy_snapshot)
           VALUES ('ent_h1_bad','p','VOUCHER_SERVICE','order_h1b','li_1','bonbeauty','SPV',$1,0,
                   'ISSUED','{}'::jsonb)`,
          [buildEntitlementDedupeKey("pi_h1b", "li_1", 0)]
        )
      ).rejects.toThrow(/entitlement_instance_sales_channel_scope_chk/)
    })
  })

  it("(H1) captured-path (dedupe_key NULL) BEZ sales_channel_id wciąż PRZECHODZI (brak regresji v1.9.0 H-6)", async () => {
    await withMigratedTx(async (c) => {
      // ścieżka payment.captured (issue-entitlement.ts) ustawia order_id+market_id,
      // ale NIE sales_channel_id ani entitlement_dedupe_key — MUSI nadal działać.
      const r = await c.query(
        `INSERT INTO entitlement_instance
           (id, entitlement_profile_id, entitlement_type, order_id, line_item_id,
            market_id, state, policy_snapshot)
         VALUES ('ent_captured','p','VOUCHER_SERVICE','order_cap','li_c','bonbeauty',
                 'ACTIVE','{}'::jsonb)`
      )
      expect(r.rowCount).toBe(1)
    })
  })

  it("(AC4) recipient_index < 0 ODRZUCONY (CHECK domena nieujemna)", async () => {
    await withMigratedTx(async (c) => {
      await expect(
        c.query(
          `INSERT INTO entitlement_instance
             (id, entitlement_profile_id, entitlement_type, order_id, market_id,
              sales_channel_id, vat_classification, entitlement_dedupe_key, recipient_index,
              state, policy_snapshot)
           VALUES ('ent_neg','p','VOUCHER_SERVICE','order_n','bonbeauty','sc_1','SPV','k_neg',-1,
                   'ISSUED','{}'::jsonb)`
        )
      ).rejects.toThrow(/entitlement_instance_recipient_index_chk/)
    })
  })
})
