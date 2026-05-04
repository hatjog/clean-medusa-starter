import { Migration } from "@mikro-orm/migrations";

/**
 * Story v160-cleanup-15f — AC2 fix.
 *
 * `phase_b_smoke_gate_ratifications` is the durable audit trail for
 * Phase B SMOKE GATE verdicts. Replaces the prior in-memory module-local
 * `_ratificationHistory` array (lost on process restart) with append-only
 * DB rows that survive deploys, restarts, and multi-instance runs.
 *
 * Append-only convention (consistent with voucher_pii_consent_audit +
 * voucher_delivery_decision): BEFORE UPDATE / DELETE / TRUNCATE trigger
 * raises `ratification_immutable_violation`. Operators may not rewrite
 * past ratifications — corrections are NEW append rows with linkage via
 * `supersedes_id`.
 */
export class Migration20260504210000PhaseBSmokeGateRatificationsTable extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `CREATE TABLE phase_b_smoke_gate_ratifications (
        id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        verdict text NOT NULL CHECK (verdict IN ('pass', 'fail')),
        items_json jsonb NOT NULL,
        admin_id text NOT NULL,
        admin_note text NULL,
        force_override boolean NOT NULL DEFAULT false,
        force_override_reason text NULL,
        supersedes_id uuid NULL REFERENCES phase_b_smoke_gate_ratifications(id),
        ratified_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_force_reason_present
          CHECK (force_override = false OR force_override_reason IS NOT NULL)
      )`
    );

    this.addSql(
      `CREATE INDEX idx_phase_b_ratifications_ratified_at
       ON phase_b_smoke_gate_ratifications (ratified_at DESC)`
    );

    this.addSql(
      `CREATE OR REPLACE FUNCTION fn_phase_b_ratifications_immutable()
       RETURNS trigger AS $$
       BEGIN
         RAISE EXCEPTION 'ratification_immutable_violation: phase_b_smoke_gate_ratifications is append-only (cleanup-15f)'
           USING ERRCODE = 'P0001';
         RETURN NULL;
       END;
       $$ LANGUAGE plpgsql`
    );

    this.addSql(
      `CREATE TRIGGER trg_phase_b_ratifications_no_update
       BEFORE UPDATE OR DELETE OR TRUNCATE
       ON phase_b_smoke_gate_ratifications
       FOR EACH STATEMENT
       EXECUTE FUNCTION fn_phase_b_ratifications_immutable()`
    );
  }

  async down(): Promise<void> {
    this.addSql(
      `DROP TRIGGER IF EXISTS trg_phase_b_ratifications_no_update ON phase_b_smoke_gate_ratifications`
    );
    this.addSql(
      `DROP FUNCTION IF EXISTS fn_phase_b_ratifications_immutable()`
    );
    this.addSql(
      `DROP TABLE IF EXISTS phase_b_smoke_gate_ratifications`
    );
  }
}
