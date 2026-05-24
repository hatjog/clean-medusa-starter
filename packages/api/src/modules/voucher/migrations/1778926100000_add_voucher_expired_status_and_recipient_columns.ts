import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.9.0 Wave F6 — Epic-2 HIGH-08 + HIGH-05.
 *
 * Two coherent schema extensions delivered in one migration because they share
 * a single rollback story (drop the new column / restore the old CHECK).
 *
 * --- HIGH-08: voucher.status CHECK does not include 'expired' ---
 *   The Story 2.1 migration `Migration20260507000000.ts` constrained
 *   `voucher.status` to `('idle','consent_pending','claimed','withdrawn')`. The
 *   service-layer `claim()` returns `{ status: 'expired', voucher }` to
 *   callers but never persists the terminal state — the voucher row stays
 *   `idle` forever, blocking the F6 expiry sweeper from recording the
 *   transition. We extend the CHECK to admit `'expired'` so the sweeper job
 *   (`voucher-expiry-sweeper`) can flip stale rows safely.
 *
 * --- HIGH-05: entitlement_instance has no recipient binding column ---
 *   `assertTransferabilityAllowed` in `entitlement-boundary.ts` requires
 *   `redeemContext.recipient_customer_id`. The persisted row had no column to
 *   carry it; the redeem workflow could not enforce `personalized`/`hybrid`
 *   transferability. We add a nullable `recipient_customer_id text` column
 *   plus a lookup index so transferability enforcement is wired end-to-end.
 *
 * Forward: ALTER both tables.
 * Reverse: drop the added column / restore original CHECK.
 *
 * Idempotent (IF EXISTS / IF NOT EXISTS).
 */
export class Migration1778926100000 extends Migration {
  async up(): Promise<void> {
    // --- HIGH-08: voucher.status accept 'expired' ---
    this.addSql(`
      ALTER TABLE IF EXISTS voucher
        DROP CONSTRAINT IF EXISTS voucher_status_check
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS voucher
        ADD CONSTRAINT voucher_status_check CHECK (status IN (
          'idle','consent_pending','claimed','withdrawn','expired'
        ))
    `)

    // --- HIGH-05: entitlement_instance.recipient_customer_id ---
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        ADD COLUMN IF NOT EXISTS recipient_customer_id text NULL
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS entitlement_instance_recipient_customer_idx
        ON entitlement_instance (recipient_customer_id)
        WHERE recipient_customer_id IS NOT NULL
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      DROP INDEX IF EXISTS entitlement_instance_recipient_customer_idx
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        DROP COLUMN IF EXISTS recipient_customer_id
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS voucher
        DROP CONSTRAINT IF EXISTS voucher_status_check
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS voucher
        ADD CONSTRAINT voucher_status_check CHECK (status IN (
          'idle','consent_pending','claimed','withdrawn'
        ))
    `)
  }
}
