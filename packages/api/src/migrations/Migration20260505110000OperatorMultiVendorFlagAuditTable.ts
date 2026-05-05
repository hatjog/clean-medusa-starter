import { Migration } from "@mikro-orm/migrations";

/**
 * Story v160-8-3 closure: durable multi-vendor tri-state audit/state.
 *
 * Current state is derived from the latest append-only audit row, so this
 * table becomes both the durable control-plane history and the singleton
 * source of truth across restarts and multi-instance runs.
 */
export class Migration20260505110000OperatorMultiVendorFlagAuditTable extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `CREATE TABLE operator_multi_vendor_flag_audit (
        id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        from_state text NOT NULL CHECK (from_state IN ('off', 'shadow', 'on')),
        to_state text NOT NULL CHECK (to_state IN ('off', 'shadow', 'on')),
        triggered_by text NOT NULL,
        reason text NULL,
        alert_id text NULL,
        smoke_gate_ref text NULL,
        admin_note text NULL,
        cache_invalidate_outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
        at timestamptz NOT NULL DEFAULT now()
      )`
    )

    this.addSql(
      `CREATE INDEX idx_operator_mv_flag_audit_at
       ON operator_multi_vendor_flag_audit (at DESC)`
    )

    this.addSql(
      `CREATE OR REPLACE FUNCTION fn_operator_mv_flag_audit_immutable()
       RETURNS trigger AS $$
       BEGIN
         RAISE EXCEPTION 'operator_mv_flag_audit_immutable_violation: operator_multi_vendor_flag_audit is append-only (v160-8-3)'
           USING ERRCODE = 'P0001';
         RETURN NULL;
       END;
       $$ LANGUAGE plpgsql`
    )

    this.addSql(
      `CREATE TRIGGER trg_operator_mv_flag_audit_no_mutation
       BEFORE UPDATE OR DELETE OR TRUNCATE
       ON operator_multi_vendor_flag_audit
       FOR EACH STATEMENT
       EXECUTE FUNCTION fn_operator_mv_flag_audit_immutable()`
    )
  }

  async down(): Promise<void> {
    this.addSql(
      `DROP TRIGGER IF EXISTS trg_operator_mv_flag_audit_no_mutation ON operator_multi_vendor_flag_audit`
    )
    this.addSql(
      `DROP FUNCTION IF EXISTS fn_operator_mv_flag_audit_immutable()`
    )
    this.addSql(
      `DROP TABLE IF EXISTS operator_multi_vendor_flag_audit`
    )
  }
}