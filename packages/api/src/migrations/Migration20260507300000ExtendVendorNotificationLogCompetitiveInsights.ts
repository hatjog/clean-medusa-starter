import { Migration } from "@mikro-orm/migrations"

/**
 * Story v160-cleanup-38-jwt-vendor-scope — audit-log schema extension.
 *
 * Extends `vendor_notification_log` with:
 *
 * 1. New `notification_type` value: 'competitive_insights_query'
 *    The CHECK constraint on this column is extended to allow this new value.
 *    Existing rows are unaffected (additive change only).
 *
 * 2. Composite index for efficient queries by (vendor_id, notification_type):
 *    `idx_vnl_vendor_type_competitive` — supports O(log n) lookup when
 *    auditing competitive-insights query history per vendor.
 *
 * Note: vendor_notification_log has no soft-delete (deleted_at) column —
 * the table is append-only (trigger enforced by Migration20260505000000).
 * Index DOES NOT include a deleted_at filter.
 */
export class Migration20260507200000ExtendVendorNotificationLogCompetitiveInsights extends Migration {
  async up(): Promise<void> {
    // 1. Extend the notification_type CHECK constraint to include the new value.
    //    We drop the old constraint and add a new one (additive — no data loss).
    this.addSql(
      `ALTER TABLE vendor_notification_log
       DROP CONSTRAINT IF EXISTS vendor_notification_log_notification_type_check`,
    )

    this.addSql(
      `ALTER TABLE vendor_notification_log
       ADD CONSTRAINT vendor_notification_log_notification_type_check
       CHECK (notification_type IN (
         't30_migration',
         'decision_capture',
         'lifecycle_transition',
         'jca_generated',
         'jca_dispatched',
         'jca_signed',
         'training_cert_uploaded',
         'training_cert_approved',
         'training_cert_rejected',
         'nudge_t21',
         'nudge_t14',
         'nudge_t7',
         'nudge_t3',
         'competitive_insights_query'
       ))`,
    )

    // 2. Composite index for per-vendor competitive-insights audit queries.
    //    No deleted_at filter — table has no soft-delete column.
    this.addSql(
      `CREATE INDEX IF NOT EXISTS idx_vnl_vendor_type_competitive
       ON vendor_notification_log (vendor_id, notification_type)`,
    )
  }

  async down(): Promise<void> {
    // Drop the index first
    this.addSql(`DROP INDEX IF EXISTS idx_vnl_vendor_type_competitive`)

    // Restore the constraint to exclude 'competitive_insights_query'.
    // NOTE: If any rows with notification_type='competitive_insights_query'
    // exist, this rollback will fail. Operators MUST delete or remap those
    // rows before running down(). We do NOT auto-delete here — that would
    // violate the append-only audit-log invariant.
    this.addSql(
      `ALTER TABLE vendor_notification_log
       DROP CONSTRAINT IF EXISTS vendor_notification_log_notification_type_check`,
    )

    this.addSql(
      `ALTER TABLE vendor_notification_log
       ADD CONSTRAINT vendor_notification_log_notification_type_check
       CHECK (notification_type IN (
         't30_migration',
         'decision_capture',
         'lifecycle_transition',
         'jca_generated',
         'jca_dispatched',
         'jca_signed',
         'training_cert_uploaded',
         'training_cert_approved',
         'training_cert_rejected',
         'nudge_t21',
         'nudge_t14',
         'nudge_t7',
         'nudge_t3'
       ))`,
    )
  }
}
