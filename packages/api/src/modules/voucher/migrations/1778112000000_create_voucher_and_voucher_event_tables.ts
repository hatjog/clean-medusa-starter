import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story v160-cleanup-25: create voucher + voucher_event tables.
 *
 * Forward: creates both tables with FK, indexes, CHECK constraints.
 * Reverse: drops both tables (CASCADE).
 *
 * Migration is idempotent (CREATE TABLE IF NOT EXISTS).
 *
 * Ordering fix (v1.10.0 ra-1 clean-boot): originally named
 * `Migration20260507000000` (YYYYMMDDHHMMSS). MikroORM sorts migrations by the
 * numeric version, and 20260507000000 (~2.0e13) is LARGER than the voucher
 * module's epoch-millisecond migrations (~1.7e12), so this table-CREATE sorted
 * AFTER the migrations that ALTER voucher_event (e.g. 1778925265229 booking
 * pointer) — fine on incremental DBs (tables already existed) but it broke a
 * clean `db:migrate` ("relation voucher_event does not exist"). Renamed to the
 * epoch-ms equivalent of 2026-05-07 (1778112000000) so the CREATE precedes the
 * ALTERs. CREATE TABLE IF NOT EXISTS keeps it safe to re-run on databases that
 * already applied the old class name.
 */
export class Migration1778112000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS voucher (
        code            text PRIMARY KEY,
        -- F7: market_id NULL = global voucher (E2E fixtures only).
        -- Production vouchers MUST set market_id explicitly to enforce
        -- DPIA R-12 cross-market isolation at the route layer (cleanup-27 ALS).
        market_id       text NULL,
        seller_id       text NOT NULL,
        seller_name     text NOT NULL,
        seller_handle   text NOT NULL,
        product_title   text NOT NULL,
        value_minor     integer NOT NULL CHECK (value_minor >= 0),
        currency_code   text NOT NULL,
        status          text NOT NULL CHECK (status IN ('idle','consent_pending','claimed','withdrawn')),
        expires_at      timestamptz NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      )
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_seller_id_idx ON voucher (seller_id)
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_market_id_idx ON voucher (market_id)
        WHERE market_id IS NOT NULL
    `)
    // F4: partial index on expires_at for upcoming expiry-sweeper queries
    // (cleanup-44 / cleanup-55 expiry processing). NULL expires_at rows
    // (non-expiring vouchers) excluded — index stays small.
    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_expires_at_idx ON voucher (expires_at)
        WHERE expires_at IS NOT NULL
    `)

    this.addSql(`
      CREATE TABLE IF NOT EXISTS voucher_event (
        id              text PRIMARY KEY,
        voucher_code    text NOT NULL REFERENCES voucher(code) ON DELETE CASCADE,
        event_type      text NOT NULL CHECK (event_type IN ('created','sent','opened','claimed','withdrawn')),
        occurred_at     timestamptz NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_event_code_idx ON voucher_event (voucher_code, occurred_at)
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS voucher_event`)
    this.addSql(`DROP TABLE IF EXISTS voucher`)
  }
}
