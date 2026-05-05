import { Migration } from "@mikro-orm/migrations";

/**
 * Story v160-cleanup-7-vendor-lifecycle-prod-wiring follow-up — durable audit
 * trail for vendor notifications (Stories 7.1/7.2/7.3 AC4 closure).
 *
 * Prior state: routes generated VendorNotificationLogEntry rows with
 * `randomUUID()` ids but only kept them in process-local arrays + console.info
 * logs. Restart wiped the trail. AC4 of all three stories required durable
 * persistence to either an existing Mercur audit log surface OR a new
 * `vendor_notification_log` table; the latter is implemented here (Path B
 * per the original story Dev Notes — Path A "existing Mercur audit log
 * surface" was not adopted because Mercur 2 does not expose a generic vendor
 * audit table).
 *
 * Append-only convention reused from voucher_pii_consent_audit +
 * voucher_delivery_decision + phase_b_smoke_gate_ratifications: BEFORE
 * UPDATE / DELETE / TRUNCATE trigger raises `notification_log_immutable_violation`.
 * Operators may not rewrite past entries — corrections are NEW append rows.
 */
export class Migration20260505000000VendorNotificationLogTable extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `CREATE TABLE vendor_notification_log (
        id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        vendor_id text NOT NULL,
        vendor_handle text NULL,
        notification_type text NOT NULL CHECK (notification_type IN (
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
        )),
        sent_at timestamptz NOT NULL DEFAULT now(),
        locale text NOT NULL CHECK (locale IN ('pl', 'en')),
        recipient_email text NOT NULL,
        status text NOT NULL CHECK (status IN ('sent', 'failed')),
        error_message text NULL,
        triggered_by text NOT NULL,
        metadata jsonb NULL
      )`
    );

    this.addSql(
      `CREATE INDEX idx_vendor_notification_log_vendor
       ON vendor_notification_log (vendor_id, sent_at DESC)`
    );

    this.addSql(
      `CREATE INDEX idx_vendor_notification_log_type_status
       ON vendor_notification_log (notification_type, status, sent_at DESC)`
    );

    this.addSql(
      `CREATE OR REPLACE FUNCTION fn_vendor_notification_log_immutable()
       RETURNS trigger AS $$
       BEGIN
         RAISE EXCEPTION 'notification_log_immutable_violation: vendor_notification_log is append-only (cleanup-7-prod-wiring-followup)'
           USING ERRCODE = 'P0001';
         RETURN NULL;
       END;
       $$ LANGUAGE plpgsql`
    );

    this.addSql(
      `CREATE TRIGGER trg_vendor_notification_log_no_update
       BEFORE UPDATE OR DELETE OR TRUNCATE
       ON vendor_notification_log
       FOR EACH STATEMENT
       EXECUTE FUNCTION fn_vendor_notification_log_immutable()`
    );
  }

  async down(): Promise<void> {
    this.addSql(
      `DROP TRIGGER IF EXISTS trg_vendor_notification_log_no_update ON vendor_notification_log`
    );
    this.addSql(`DROP FUNCTION IF EXISTS fn_vendor_notification_log_immutable()`);
    this.addSql(`DROP TABLE IF EXISTS vendor_notification_log`);
  }
}
