import type { Knex } from "knex"

const OPERATOR_TABLES = {
  smokeGateRatifications: "phase_b_smoke_gate_ratifications",
  flagAudit: "operator_multi_vendor_flag_audit",
  alertEvaluatorTickHistory: "operator_alert_evaluator_tick_history",
} as const

async function tableExists(db: Knex, tableName: string): Promise<boolean> {
  const result = await db.raw("select to_regclass(?) as regclass", [
    `public.${tableName}`,
  ])
  const row = Array.isArray(result?.rows) ? result.rows[0] : result?.[0]
  return Boolean(row?.regclass)
}

export async function ensureOperatorRuntimeSchema(db: Knex): Promise<void> {
  await db.raw("CREATE EXTENSION IF NOT EXISTS pgcrypto")

  if (!(await tableExists(db, OPERATOR_TABLES.smokeGateRatifications))) {
    await db.raw(
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
      )`,
    )
  }

  await db.raw(
    `CREATE INDEX IF NOT EXISTS idx_phase_b_ratifications_ratified_at
     ON phase_b_smoke_gate_ratifications (ratified_at DESC)`,
  )
  await db.raw(
    `CREATE OR REPLACE FUNCTION fn_phase_b_ratifications_immutable()
     RETURNS trigger AS $$
     BEGIN
       RAISE EXCEPTION 'ratification_immutable_violation: phase_b_smoke_gate_ratifications is append-only (cleanup-15f)'
         USING ERRCODE = 'P0001';
       RETURN NULL;
     END;
     $$ LANGUAGE plpgsql`,
  )
  await db.raw(
    "DROP TRIGGER IF EXISTS trg_phase_b_ratifications_no_update ON phase_b_smoke_gate_ratifications",
  )
  await db.raw(
    `CREATE TRIGGER trg_phase_b_ratifications_no_update
     BEFORE UPDATE OR DELETE OR TRUNCATE
     ON phase_b_smoke_gate_ratifications
     FOR EACH STATEMENT
     EXECUTE FUNCTION fn_phase_b_ratifications_immutable()`,
  )

  if (!(await tableExists(db, OPERATOR_TABLES.flagAudit))) {
    await db.raw(
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
      )`,
    )
  }

  await db.raw(
    `CREATE INDEX IF NOT EXISTS idx_operator_mv_flag_audit_at
     ON operator_multi_vendor_flag_audit (at DESC)`,
  )
  await db.raw(
    `CREATE OR REPLACE FUNCTION fn_operator_mv_flag_audit_immutable()
     RETURNS trigger AS $$
     BEGIN
       RAISE EXCEPTION 'operator_mv_flag_audit_immutable_violation: operator_multi_vendor_flag_audit is append-only (v160-8-3)'
         USING ERRCODE = 'P0001';
       RETURN NULL;
     END;
     $$ LANGUAGE plpgsql`,
  )
  await db.raw(
    "DROP TRIGGER IF EXISTS trg_operator_mv_flag_audit_no_mutation ON operator_multi_vendor_flag_audit",
  )
  await db.raw(
    `CREATE TRIGGER trg_operator_mv_flag_audit_no_mutation
     BEFORE UPDATE OR DELETE OR TRUNCATE
     ON operator_multi_vendor_flag_audit
     FOR EACH STATEMENT
     EXECUTE FUNCTION fn_operator_mv_flag_audit_immutable()`,
  )

  if (!(await tableExists(db, OPERATOR_TABLES.alertEvaluatorTickHistory))) {
    await db.raw(
      `CREATE TABLE operator_alert_evaluator_tick_history (
        id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        schedule_name text NOT NULL,
        triggered_by text NOT NULL CHECK (triggered_by IN ('manual', 'scheduler')),
        tick_started_at timestamptz NOT NULL,
        tick_finished_at timestamptz NOT NULL,
        firing_count integer NOT NULL DEFAULT 0,
        auto_rollbacks integer NOT NULL DEFAULT 0,
        status text NOT NULL CHECK (status IN ('pass', 'fail')),
        error_message text NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    )
  }

  await db.raw(
    `CREATE INDEX IF NOT EXISTS idx_operator_alert_evaluator_tick_history_started_at
     ON operator_alert_evaluator_tick_history (tick_started_at DESC)`,
  )
}