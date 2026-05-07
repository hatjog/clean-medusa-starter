import { Migration } from "@mikro-orm/migrations"

/**
 * Story v160-cleanup-39-magicbyte-validator — audit-log schema extension.
 *
 * Two additive changes to `vendor_notification_log`:
 *
 * 1. `notification_type` — `training_cert_uploaded` was ALREADY added in
 *    Migration20260505000000VendorNotificationLogTable (cleanup-7 followup
 *    confirmed it was in scope). No DDL change needed for this value; the
 *    up() is a no-op guard that documents this fact.
 *
 * 2. `status` — existing CHECK allows only ('sent', 'failed').  Upload
 *    rejection outcomes use `status = 'rejected'` per AC6 of this story.
 *    We DROP the old constraint and ADD a new one that includes 'rejected'.
 *    This is additive: existing 'sent'/'failed' rows are unaffected.
 *
 * 3. `error_message` and `metadata` columns already exist; no change.
 *
 * Append-only trigger (`trg_vendor_notification_log_no_update`) inherited
 * from the base migration — no change to trigger or function.
 */
export class Migration20260507100000ExtendVendorNotificationLogTrainingCert extends Migration {
  async up(): Promise<void> {
    // Extend the status CHECK constraint to include 'rejected'.
    this.addSql(
      `ALTER TABLE vendor_notification_log
       DROP CONSTRAINT IF EXISTS vendor_notification_log_status_check`,
    )

    this.addSql(
      `ALTER TABLE vendor_notification_log
       ADD CONSTRAINT vendor_notification_log_status_check
       CHECK (status IN ('sent', 'failed', 'deduplicated', 'rejected'))`,
    )
  }

  async down(): Promise<void> {
    // Restore the constraint from the previous migration (dedup extension)
    // — rows with 'rejected' must be absent or this will fail.
    this.addSql(
      `ALTER TABLE vendor_notification_log
       DROP CONSTRAINT IF EXISTS vendor_notification_log_status_check`,
    )

    this.addSql(
      `ALTER TABLE vendor_notification_log
       ADD CONSTRAINT vendor_notification_log_status_check
       CHECK (status IN ('sent', 'failed', 'deduplicated'))`,
    )
  }
}
