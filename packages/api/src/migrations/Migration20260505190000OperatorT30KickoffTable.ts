import { Migration } from "@mikro-orm/migrations"

/**
 * Story v160-8-2 — durable operator kickoff state.
 *
 * Replaces process-local kickoff memory with an append-only audit table so the
 * T-30 window survives restarts and multi-instance runs.
 */
export class Migration20260505190000OperatorT30KickoffTable extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `CREATE TABLE operator_t30_kickoff (
        id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        started_at timestamptz NOT NULL,
        t0_target timestamptz NOT NULL,
        triggered_by text NOT NULL,
        vendor_count integer NOT NULL CHECK (vendor_count >= 0),
        admin_note text NULL,
        override boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      )`
    )

    this.addSql(
      `CREATE INDEX idx_operator_t30_kickoff_started_at
       ON operator_t30_kickoff (started_at DESC)`
    )

    this.addSql(
      `CREATE OR REPLACE FUNCTION fn_operator_t30_kickoff_immutable()
       RETURNS trigger AS $$
       BEGIN
         RAISE EXCEPTION 'operator_t30_kickoff_immutable_violation: operator_t30_kickoff is append-only (story-8-2)'
           USING ERRCODE = 'P0001';
         RETURN NULL;
       END;
       $$ LANGUAGE plpgsql`
    )

    this.addSql(
      `CREATE TRIGGER trg_operator_t30_kickoff_no_update
       BEFORE UPDATE OR DELETE OR TRUNCATE
       ON operator_t30_kickoff
       FOR EACH STATEMENT
       EXECUTE FUNCTION fn_operator_t30_kickoff_immutable()`
    )
  }

  async down(): Promise<void> {
    this.addSql(
      `DROP TRIGGER IF EXISTS trg_operator_t30_kickoff_no_update ON operator_t30_kickoff`
    )
    this.addSql(
      `DROP FUNCTION IF EXISTS fn_operator_t30_kickoff_immutable()`
    )
    this.addSql(
      `DROP TABLE IF EXISTS operator_t30_kickoff`
    )
  }
}