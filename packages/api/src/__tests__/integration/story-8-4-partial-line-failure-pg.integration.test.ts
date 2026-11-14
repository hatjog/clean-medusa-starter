/**
 * Story 8.4 (v1.16.0, FR-16, AD-19, NFR-4) — częściowa porażka pozycji
 * prezentowych na PRAWDZIWYM PostgreSQL.
 *
 * Dowodzi, że realny SAVEPOINT / ROLLBACK TO SAVEPOINT w subskrybencie Path Y:
 *   - zostawia zacommitowane `entitlement_instance` + `voucher` linii udanych
 *     (brak ROLLBACK całej transakcji z powodu jednej linii),
 *   - cofa zapis entitlementu linii nieudanej wykonany PRZED błędem,
 *   - NIE konsumuje eventu (`event_processed` pusty ⇒ retry wraca do linii),
 *   - retry po naprawie danych wystawia wyłącznie linię nieudaną.
 *
 * Tabele są TEMP (per sesja jednego klienta) i znikają przy zamknięciu
 * połączenia. Baza wyłącznie `*_test` (bramka `integration-tests/setup.js`).
 * Kontrakt: specs/contracts/checkout/gift-line-issue-outcome.v1.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Pool, type PoolClient } from "pg"

import subscriber, { PAYMENT_INTENT_SUCCEEDED_EVENT } from "../../subscribers/voucher-live-issue"
import { LiveIssuePartialFailureError } from "../../workflows/entitlements/live-issue-from-payment-intent"

process.env.GP_INSTANCE_ID = "gp-test"

const DATABASE_URL = process.env.DATABASE_URL
const runOrSkip = DATABASE_URL ? describe : describe.skip

const ORDER_ID = "order_s84_gift"
const PI_ID = "pi_s84_gift"
const LINES = ["li_s84_1", "li_s84_2", "li_s84_3"] as const

function envelope() {
  return {
    name: PAYMENT_INTENT_SUCCEEDED_EVENT,
    data: {
      event_type: PAYMENT_INTENT_SUCCEEDED_EVENT,
      scope: { instance_id: "gp-test", market_id: "bonbeauty" },
      payload: {
        payment_intent_id: PI_ID,
        order_id: ORDER_ID,
        currency: "PLN",
        amount_minor: 74700,
        psp_occurred_at: "2026-11-14T10:00:00Z",
      },
    },
  }
}

runOrSkip("Story 8.4 — częściowa porażka pozycji prezentowych na realnym PG", () => {
  let pool: Pool
  let client: PoolClient
  const txLog: string[] = []
  const emitted: unknown[] = []

  const container = {
    resolve: (key: string) => {
      if (key === "__pg_pool__") {
        return {
          connect: async () => ({
            query: async (sql: string, values?: ReadonlyArray<unknown>) => {
              const t = sql.trim().toUpperCase()
              if (t === "BEGIN" || t === "COMMIT" || t === "ROLLBACK") txLog.push(t)
              return client.query(sql, values as unknown[])
            },
            release() {},
          }),
        }
      }
      if (key === "event_bus") {
        return { emit: async (e: unknown) => void emitted.push(e) }
      }
      if (key === "logger") return { info() {}, warn() {}, error() {} }
      throw new Error(`unresolved ${key}`)
    },
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 1 })
    client = await pool.connect()
    const statements = [
      `CREATE TEMP TABLE "order" (id text PRIMARY KEY, sales_channel_id text, metadata jsonb, deleted_at timestamptz)`,
      `CREATE TEMP TABLE order_line_item (id text PRIMARY KEY, product_id text, unit_price numeric NOT NULL,
         title text, metadata jsonb, deleted_at timestamptz)`,
      `CREATE TEMP TABLE order_item (order_id text NOT NULL, item_id text NOT NULL,
         created_at timestamptz NOT NULL, deleted_at timestamptz)`,
      `CREATE TEMP TABLE product (id text PRIMARY KEY, title text, metadata jsonb, deleted_at timestamptz)`,
      `CREATE TEMP TABLE product_product_seller_seller (product_id text NOT NULL, seller_id text NOT NULL, deleted_at timestamptz)`,
      `CREATE TEMP TABLE seller (id text PRIMARY KEY, name text, handle text, status text, deleted_at timestamptz)`,
      `CREATE TEMP TABLE voucher (code text PRIMARY KEY, market_id text, seller_id text NOT NULL,
         seller_name text NOT NULL, seller_handle text NOT NULL, product_title text NOT NULL,
         value_minor integer NOT NULL, currency_code text NOT NULL, status text NOT NULL,
         expires_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
      `CREATE TEMP TABLE event_processed (external_id text NOT NULL, event_type text NOT NULL,
         processed_at bigint NOT NULL, purchase_key text, market_id text, instance_id text,
         PRIMARY KEY (external_id, event_type))`,
      `CREATE TEMP TABLE entitlement_instance (id text PRIMARY KEY, entitlement_profile_id text NOT NULL,
         entitlement_type text NOT NULL, order_id text NOT NULL, line_item_id text NOT NULL,
         state text NOT NULL, policy_snapshot jsonb NOT NULL, market_id text NOT NULL,
         sales_channel_id text NOT NULL, vat_classification text NOT NULL, reference_price_minor integer,
         entitlement_dedupe_key text NOT NULL UNIQUE, recipient_index integer NOT NULL,
         recipient_customer_id text, claim_token text, expires_at timestamptz,
         created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
      // Lustro partial UNIQUE z migracji 1778925500000 (FR10: jeden wiersz na linię).
      `CREATE UNIQUE INDEX entitlement_instance_order_line_uniq_idx
         ON entitlement_instance (order_id, line_item_id)`,
      `CREATE TEMP TABLE entitlement_choice_set_item (id text PRIMARY KEY, instance_id text NOT NULL,
         market_id text NOT NULL, label text, reference_amount_minor integer NOT NULL,
         remaining_minor integer NOT NULL, vat_classification text NOT NULL, status text NOT NULL,
         redemption_id text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
    ]
    for (const statement of statements) await client.query(statement)

    await client.query(`INSERT INTO "order" (id, sales_channel_id, metadata) VALUES ($1, 'sc_bonbeauty', $2::jsonb)`, [
      ORDER_ID,
      JSON.stringify({ gp: { market_id: "bonbeauty" } }),
    ])
    await client.query(
      `INSERT INTO seller (id, name, handle, status) VALUES
         ('sel_ok', 'Salon Bon Beauty', 'bon-beauty', 'active'),
         ('sel_broken', NULL, 'bez-nazwy', 'active')`
    )
    for (const [index, lineId] of LINES.entries()) {
      const productId = `prod_${lineId}`
      // Linia 2: sprzedawca bez nazwy ⇒ geneza kodu vouchera rzuca PO INSERT entitlementu.
      const sellerId = index === 1 ? "sel_broken" : "sel_ok"
      await client.query(`INSERT INTO product (id, title, metadata) VALUES ($1, 'Voucher prezentowy', NULL)`, [productId])
      await client.query(`INSERT INTO product_product_seller_seller (product_id, seller_id) VALUES ($1, $2)`, [
        productId,
        sellerId,
      ])
      await client.query(
        `INSERT INTO order_line_item (id, product_id, unit_price, title, metadata) VALUES ($1, $2, 24900, 'Masaż 60 min', $3::jsonb)`,
        [
          lineId,
          productId,
          JSON.stringify({
            entitlement_profile_id: "voucher-rezerwacja-otwarta",
            entitlement_type: "VOUCHER_SERVICE",
            policy: { validity_months: 12, vat_rate_uniqueness: true },
            recipients: [{ customer_id: `cus_${lineId}` }],
          }),
        ]
      )
      await client.query(
        `INSERT INTO order_item (order_id, item_id, created_at) VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
        [ORDER_ID, lineId, String(index)]
      )
    }
  })

  afterAll(async () => {
    await client?.query("DISCARD TEMP")
    client?.release()
    await pool?.end()
  })

  it("porażka linii 2 ⇒ COMMIT linii 1 i 3 (brak ROLLBACK), linia 2 bez wiersza, event nieskonsumowany", async () => {
    let caught: unknown
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await subscriber({ event: envelope(), container } as any)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(LiveIssuePartialFailureError)
    const failure = caught as LiveIssuePartialFailureError
    expect(failure.line_outcomes.map((o) => [o.line_item_id, o.state])).toEqual([
      ["li_s84_1", "issued"],
      ["li_s84_2", "failed"],
      ["li_s84_3", "issued"],
    ])
    expect(failure.failed_lines[0].reason).toBe("issue_write_failed")
    expect(txLog).toEqual(["BEGIN", "COMMIT"])

    const ents = await client.query(`SELECT line_item_id, state FROM entitlement_instance ORDER BY line_item_id`)
    expect(ents.rows).toEqual([
      { line_item_id: "li_s84_1", state: "ISSUED" },
      { line_item_id: "li_s84_3", state: "ISSUED" },
    ])
    const vouchers = await client.query(`SELECT COUNT(*)::int AS n FROM voucher`)
    expect(vouchers.rows[0].n).toBe(2)
    const events = await client.query(`SELECT COUNT(*)::int AS n FROM event_processed`)
    expect(events.rows[0].n).toBe(0)
    expect(emitted).toHaveLength(2)
  })

  it("retry po naprawie danych sprzedawcy ⇒ wystawiona wyłącznie linia 2, event skonsumowany", async () => {
    await client.query(`UPDATE seller SET name = 'Salon Naprawiony' WHERE id = 'sel_broken'`)
    txLog.length = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await subscriber({ event: envelope(), container } as any)
    expect(txLog).toEqual(["BEGIN", "COMMIT"])
    const ents = await client.query(`SELECT line_item_id FROM entitlement_instance ORDER BY line_item_id`)
    expect(ents.rows.map((r) => r.line_item_id)).toEqual([...LINES])
    const events = await client.query(`SELECT COUNT(*)::int AS n FROM event_processed`)
    expect(events.rows[0].n).toBe(1)
    // 2 okablowania z pierwszego przebiegu + 1 (tylko linia 2) z retry.
    expect(emitted).toHaveLength(3)
  })
})
