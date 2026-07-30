import { Migration } from "@mikro-orm/migrations"

/**
 * Summary dispatch rows are mutable during retry. Preserve the first failure
 * separately so an operator can triage from the summary without reconstructing
 * the append-only audit by hand.
 */
export class Migration1778935000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE voucher_delivery_dispatch
        ADD COLUMN IF NOT EXISTS first_error_code text NULL,
        ADD COLUMN IF NOT EXISTS first_failed_at timestamptz NULL
    `)

    // Existing rows already have the immutable proof in the audit table. The
    // earliest failed transition is the original cause even if retry later
    // reset the mutable summary `error_code`.
    this.addSql(`
      UPDATE voucher_delivery_dispatch d
         SET first_error_code = first_failure.error_code,
             first_failed_at = first_failure.occurred_at
        FROM LATERAL (
          SELECT a.error_code, a.occurred_at
            FROM voucher_delivery_dispatch_audit a
           WHERE a.dispatch_id = d.dispatch_id
             AND a.to_status = 'failed'
             AND a.error_code IS NOT NULL
           ORDER BY a.occurred_at ASC, a.audit_id ASC
           LIMIT 1
        ) first_failure
       WHERE d.first_error_code IS NULL
    `)
  }

  override async down(): Promise<void> {
    // Ledger is forward-only: removing diagnostic evidence is not a safe
    // rollback operation.
  }
}
