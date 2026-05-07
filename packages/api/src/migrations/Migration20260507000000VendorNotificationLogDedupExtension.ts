import { Migration } from "@mikro-orm/migrations";

/**
 * Story v160-cleanup-40-nudge-dedup — extend vendor_notification_log for
 * dedup tracking (TF-94 P0 compliance).
 *
 * Changes vs. Migration20260505000000VendorNotificationLogTable:
 *   1. Widen status CHECK to allow 'deduplicated' (and 'rejected' from cleanup-39).
 *   2. Add nullable `forced boolean default false` column for force=true audit.
 *   3. Add composite index on (vendor_id, notification_type, sent_at DESC) for
 *      O(log n) cooldown lookups at >1M rows (AC6 window-bound query plan).
 *
 * Migration is safe on a populated table:
 *   - `forced` column is nullable with a DEFAULT — no data rewrite needed.
 *   - CHECK widening only ADDS allowed values — existing rows are unaffected.
 */
export class Migration20260507000000VendorNotificationLogDedupExtension extends Migration {
  async up(): Promise<void> {
    // 1. Widen status CHECK constraint to allow 'deduplicated' + 'rejected'
    this.addSql(
      `ALTER TABLE vendor_notification_log
         DROP CONSTRAINT IF EXISTS vendor_notification_log_status_check`
    );
    this.addSql(
      `ALTER TABLE vendor_notification_log
         ADD CONSTRAINT vendor_notification_log_status_check
         CHECK (status IN ('sent', 'failed', 'deduplicated', 'rejected'))`
    );

    // 2. Add forced column (nullable, default false — no backfill needed)
    this.addSql(
      `ALTER TABLE vendor_notification_log
         ADD COLUMN IF NOT EXISTS forced boolean NOT NULL DEFAULT false`
    );

    // 3. Add dedup lookup index — covers findRecentNotificationLog query plan (AC6)
    this.addSql(
      `CREATE INDEX IF NOT EXISTS idx_vendor_notification_log_vendor_type_sent
       ON vendor_notification_log (vendor_id, notification_type, sent_at DESC)`
    );
  }

  async down(): Promise<void> {
    this.addSql(
      `DROP INDEX IF EXISTS idx_vendor_notification_log_vendor_type_sent`
    );

    this.addSql(
      `ALTER TABLE vendor_notification_log
         DROP COLUMN IF EXISTS forced`
    );

    // Revert status CHECK to original shape (sent | failed only)
    this.addSql(
      `ALTER TABLE vendor_notification_log
         DROP CONSTRAINT IF EXISTS vendor_notification_log_status_check`
    );
    this.addSql(
      `ALTER TABLE vendor_notification_log
         ADD CONSTRAINT vendor_notification_log_status_check
         CHECK (status IN ('sent', 'failed'))`
    );
  }
}
