/**
 * v1.16.0 Story 6.5 (FR-20, NFR-3, AD-49; DW-15-141; D-35 p.13; ADR-248 `Proposed`)
 * — RLS na `voucher_recipient_pii` na REALNYM PostgreSQL (baza `*_test`, profil
 * `test:integration:story-6-5-recipient-pii-rls-pg`).
 *
 * Dowodzi (AC1):
 *   - ENABLE + FORCE RLS, polityka po `market_id` jako slug `text` (bez castu
 *     `::uuid`, bez gałęzi `OR true`), rola `medusa_store` bez BYPASSRLS;
 *   - dwa rynki A/B: rynek A widzi wyłącznie swoje wiersze; adapter wołany dla
 *     rynku B w sesji A dostaje NAZWANĄ odmowę (`market_mismatch`), nie 0 wierszy;
 *     brak kontekstu rynku ⇒ `missing_market_context`; WITH CHECK odrzuca zapis
 *     wiersza obcego rynku;
 *   - migracja `20261115140000`: up idempotentny, down przywraca poprzednią politykę i nie odbiera zastanego grantu.
 *
 * Każdy przypadek runtime biegnie w transakcji z ROLLBACK (`SET LOCAL ROLE
 * medusa_store`); seed rynku B jest sprzątany w `afterAll` (profil `-pg`).
 * Wartości PII są syntetyczne i nie trafiają do asercji wyjścia.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import knexFactory, { type Knex } from "knex"

import { Migration20261115140000VoucherRecipientPiiMarketSlugPolicy } from "../../migrations/Migration20261115140000VoucherRecipientPiiMarketSlugPolicy"
import { PgVoucherPiiAdapter } from "../../modules/voucher-pii/adapters/pg-pii"
import { RecipientPiiMarketAccessDeniedError } from "../../modules/voucher-pii/recipient-pii-market-guard"

const DATABASE_URL = process.env.DATABASE_URL ?? ""
const isTestDb = /\/[A-Za-z0-9_]*_test(\?|$)/.test(DATABASE_URL)
const maybe = DATABASE_URL && isTestDb ? describe : describe.skip

const RUN = `s65_${Date.now().toString(36)}`
const MARKET_A = `${RUN}_mkta`
const MARKET_B = `${RUN}_mktb`

function collectSql(direction: "up" | "down"): string[] {
  const sqls: string[] = []
  const fakeThis = { addSql: (s: string) => sqls.push(s) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(Migration20261115140000VoucherRecipientPiiMarketSlugPolicy.prototype as any)[direction].call(fakeThis)
  return sqls
}

maybe("Story 6.5 — RLS na danych osobowych obdarowanego (realny PG, rynki A/B)", () => {
  let db: Knex

  async function applyUp(): Promise<void> {
    for (const sql of collectSql("up")) await db.raw(sql)
  }

  /** Sesja runtime: rola bez BYPASSRLS + GUC rynku, zawsze ROLLBACK. */
  async function asRuntime<T>(market: string | null, fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    const trx = await db.transaction()
    try {
      await trx.raw("SET LOCAL ROLE medusa_store")
      if (market !== null) await trx.raw("SELECT set_config('app.gp_market_id', ?, true)", [market])
      return await fn(trx)
    } finally {
      await trx.rollback()
    }
  }

  async function seed(market: string, order: string): Promise<void> {
    await db("voucher_recipient_pii").insert({
      market_id: market,
      entitlement_id: `${order}_ent`,
      order_id: order,
      recipient_email: `${order}@example.invalid`,
      recipient_phone: null,
      locale: "pl",
      is_gift: true,
    })
  }

  beforeAll(async () => {
    db = knexFactory({ client: "pg", connection: DATABASE_URL, pool: { min: 0, max: 4 } })
    await applyUp()
    await seed(MARKET_A, `${RUN}_ordA`)
    await seed(MARKET_B, `${RUN}_ordB`)
  })

  afterAll(async () => {
    await db("voucher_recipient_pii").where("order_id", "like", `${RUN}%`).delete()
    await db.destroy()
  })

  it("AC1: RLS ENABLE + FORCE, polityka po slugu text bez castu uuid i bez OR true; medusa_store bez BYPASSRLS", async () => {
    const cls = await db.raw(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'voucher_recipient_pii'`
    )
    expect(cls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true })

    const pol = await db.raw(
      `SELECT policyname, permissive, qual, with_check FROM pg_policies WHERE tablename = 'voucher_recipient_pii'`
    )
    expect(pol.rows).toHaveLength(1)
    const [p] = pol.rows
    expect(p.policyname).toBe("rls_voucher_recipient_pii_market_isolation")
    for (const expr of [p.qual, p.with_check]) {
      // Dokładne wyrażenie: jedyny predykat, bez castu i bez gałęzi OR.
      expect(expr).toBe("(market_id = NULLIF(current_setting('app.gp_market_id'::text, true), ''::text))")
      expect(expr).not.toMatch(/\bOR\b/i)
    }

    const role = await db.raw(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'medusa_store'`)
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false })
  })

  it("AC1: rynek A widzi wyłącznie swoje wiersze (slug nie rzuca invalid input syntax for type uuid)", async () => {
    const counts = await asRuntime(MARKET_A, async (trx) => {
      const r = await trx.raw(
        `SELECT market_id, count(*)::int AS n FROM voucher_recipient_pii WHERE order_id LIKE ? GROUP BY market_id`,
        [`${RUN}%`]
      )
      return r.rows
    })
    expect(counts).toEqual([{ market_id: MARKET_A, n: 1 }])
  })

  it("AC1: adapter w sesji rynku A wołany dla rynku B ⇒ nazwana odmowa market_mismatch, nie 0 wierszy", async () => {
    const err = await asRuntime(MARKET_A, async (trx) => {
      const adapter = new PgVoucherPiiAdapter(trx)
      return adapter.tombstoneByOrder({ market_id: MARKET_B, order_id: `${RUN}_ordB` }).then(
        () => null,
        (e: unknown) => e
      )
    })
    expect(err).toBeInstanceOf(RecipientPiiMarketAccessDeniedError)
    expect((err as RecipientPiiMarketAccessDeniedError).reason).toBe("market_mismatch")
    expect((err as RecipientPiiMarketAccessDeniedError).http_status).toBe(403)
    expect((err as RecipientPiiMarketAccessDeniedError).error_code).toBe("GP_RECIPIENT_PII_MARKET_ACCESS_DENIED")
  })

  it("AC1: brak kontekstu rynku ⇒ missing_market_context dla każdej operacji adaptera", async () => {
    const reasons = await asRuntime(null, async (trx) => {
      const adapter = new PgVoucherPiiAdapter(trx)
      const out: string[] = []
      const ops: Array<() => Promise<unknown>> = [
        () => adapter.tombstoneByOrder({ market_id: MARKET_A, order_id: `${RUN}_ordA` }),
        () => adapter.purgeByMarketBefore({ market_id: MARKET_A, cutoff: new Date(), batch_size: 10 }),
        () => adapter.cleanupOrphans({ batch_size: 10 }),
        () =>
          adapter.insertRecipientPii({
            market_id: MARKET_A,
            entitlement_id: `${RUN}_x_ent`,
            order_id: `${RUN}_x`,
            recipient_email: null,
            recipient_phone: null,
            locale: "pl",
            is_gift: false,
          }),
      ]
      for (const op of ops) {
        try {
          await op()
          out.push("no_error")
        } catch (e) {
          out.push(e instanceof RecipientPiiMarketAccessDeniedError ? e.reason : `other:${(e as Error).message}`)
        }
      }
      return out
    })
    expect(reasons).toEqual([
      "missing_market_context",
      "missing_market_context",
      "missing_market_context",
      "missing_market_context",
    ])
  })

  it("AC1: rynek A — zapis i tombstone przez adapter przechodzą pod rolą runtime", async () => {
    const result = await asRuntime(MARKET_A, async (trx) => {
      const adapter = new PgVoucherPiiAdapter(trx)
      const ins = await adapter.insertRecipientPii({
        market_id: MARKET_A,
        entitlement_id: `${RUN}_ordA2_ent`,
        order_id: `${RUN}_ordA2`,
        recipient_email: null,
        recipient_phone: null,
        locale: "pl",
        is_gift: false,
      })
      const tomb = await adapter.tombstoneByOrder({ market_id: MARKET_A, order_id: `${RUN}_ordA` })
      return { inserted: typeof ins.recipient_pii_id, tomb: tomb.rows_affected }
    })
    expect(result).toEqual({ inserted: "string", tomb: 1 })
  })

  it("AC1: WITH CHECK odrzuca zapis wiersza rynku B w sesji rynku A", async () => {
    const message = await asRuntime(MARKET_A, async (trx) =>
      trx("voucher_recipient_pii")
        .insert({
          market_id: MARKET_B,
          entitlement_id: `${RUN}_y_ent`,
          order_id: `${RUN}_y`,
          locale: "pl",
          is_gift: false,
        })
        .then(
          () => "inserted",
          (e: Error) => e.message
        )
    )
    expect(message).toMatch(/row-level security/)
  })

  it("migracja 20261115140000: up idempotentny, down przywraca politykę z castem uuid, ponowny up ją usuwa", async () => {
    await applyUp()
    await applyUp()
    for (const sql of collectSql("down")) await db.raw(sql)
    const down = await db.raw(`SELECT qual FROM pg_policies WHERE tablename = 'voucher_recipient_pii'`)
    expect(down.rows[0].qual).toMatch(/uuid/)
    await applyUp()
    const up = await db.raw(`SELECT qual FROM pg_policies WHERE tablename = 'voucher_recipient_pii'`)
    expect(up.rows[0].qual).not.toMatch(/uuid/)
  })

  it("migracja 20261115140000 (fix LOW): grant medusa_store istniejący PRZED up() przeżywa up→down", async () => {
    // Stan jak po infra/postgres/migrations/003-rls-market-isolation.sql: rola ma DML przed up().
    await db.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON voucher_recipient_pii TO medusa_store`)
    await applyUp()
    for (const sql of collectSql("down")) await db.raw(sql)
    for (const sql of collectSql("down")) expect(sql).not.toMatch(/REVOKE/i)
    const priv = await db.raw(
      `SELECT has_table_privilege('medusa_store', 'voucher_recipient_pii', 'SELECT') AS s,
              has_table_privilege('medusa_store', 'voucher_recipient_pii', 'INSERT') AS i,
              has_table_privilege('medusa_store', 'voucher_recipient_pii', 'UPDATE') AS u,
              has_table_privilege('medusa_store', 'voucher_recipient_pii', 'DELETE') AS d`
    )
    expect(priv.rows[0]).toEqual({ s: true, i: true, u: true, d: true })
    await applyUp()
    const up = await db.raw(`SELECT qual FROM pg_policies WHERE tablename = 'voucher_recipient_pii'`)
    expect(up.rows[0].qual).not.toMatch(/uuid/)
  })
})
