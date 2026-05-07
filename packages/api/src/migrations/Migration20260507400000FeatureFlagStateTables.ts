import { Migration } from "@mikro-orm/migrations"

/**
 * Story v160-cleanup-50: DB-backed feature flag state + history tables.
 *
 * Adds two tables:
 *  - feature_flag_state: authoritative current-state row per flag_id (PK).
 *  - feature_flag_history: minimal append-only value-trail for forensics and
 *    future multi-flag generalisation (v1.7.0+).
 *
 * Seeds initial row for 'multi_vendor_pdp' from:
 *   (a) latest operator_multi_vendor_flag_audit.to_state  OR
 *   (b) GP_MV_FLAG_STATE env var (if valid off|shadow|on)  OR
 *   (c) "off" (fail-closed default).
 *
 * @see specs/proposed/v1.6.0/to-fix.md#TF-113
 * @see specs/adr/ADR-070-feature-flag-tri-state.md
 */
export class Migration20260507400000FeatureFlagStateTables extends Migration {
  async up(): Promise<void> {
    // pgcrypto for gen_random_uuid() — no-op if already present
    this.addSql(`CREATE EXTENSION IF NOT EXISTS pgcrypto`)

    // I1 fix: IF NOT EXISTS — defensive idempotency at the base layer.
    // M1 fix: CHECK constraint enforces tri-state at the DB level (defence in
    // depth for direct SQL writes from operator runbooks per AC8).
    this.addSql(`
      CREATE TABLE IF NOT EXISTS feature_flag_state (
        flag_id    text         NOT NULL PRIMARY KEY,
        value      text         NOT NULL,
        updated_by text         NOT NULL,
        updated_at timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT feature_flag_state_value_chk CHECK (value IN ('off', 'shadow', 'on'))
      )
    `)

    // L1 fix: FK from history.flag_id → state.flag_id keeps history rows
    // referentially honest (forward-compat with v1.7.0 multi-flag rollout).
    // M1 fix: CHECK on to_value / from_value (NULL allowed for from_value).
    this.addSql(`
      CREATE TABLE IF NOT EXISTS feature_flag_history (
        id           uuid         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        flag_id      text         NOT NULL REFERENCES feature_flag_state (flag_id) ON DELETE CASCADE,
        from_value   text         NULL,
        to_value     text         NOT NULL,
        updated_by   text         NOT NULL,
        reason       text         NULL,
        at           timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT feature_flag_history_to_value_chk CHECK (to_value IN ('off', 'shadow', 'on')),
        CONSTRAINT feature_flag_history_from_value_chk CHECK (from_value IS NULL OR from_value IN ('off', 'shadow', 'on'))
      )
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS feature_flag_history_flag_id_at_idx
        ON feature_flag_history (flag_id, at DESC)
    `)

    // Seed: derive initial value per priority chain.
    // Using raw SQL so the migration is self-contained and does not depend on
    // the application layer (which may not be initialised at migration time).
    this.addSql(`
      DO $$
      DECLARE
        v_derived text := 'off';
        v_audit_state text;
        v_env_state text;
      BEGIN
        -- (a) Latest operator audit row
        BEGIN
          SELECT to_state INTO v_audit_state
          FROM operator_multi_vendor_flag_audit
          ORDER BY at DESC, id DESC
          LIMIT 1;
        EXCEPTION WHEN undefined_table THEN
          v_audit_state := NULL;
        END;

        IF v_audit_state IS NOT NULL AND v_audit_state IN ('off', 'shadow', 'on') THEN
          v_derived := v_audit_state;
        ELSE
          -- (b) GP_MV_FLAG_STATE env (passed via psql \setenv or current_setting)
          BEGIN
            v_env_state := current_setting('app.gp_mv_flag_state', true);
          EXCEPTION WHEN OTHERS THEN
            v_env_state := NULL;
          END;
          IF v_env_state IS NOT NULL AND v_env_state IN ('off', 'shadow', 'on') THEN
            v_derived := v_env_state;
          END IF;
          -- (c) falls back to 'off' (already initialised)
        END IF;

        INSERT INTO feature_flag_state (flag_id, value, updated_by)
        VALUES ('multi_vendor_pdp', v_derived, 'migration')
        ON CONFLICT (flag_id) DO NOTHING;

        INSERT INTO feature_flag_history (flag_id, from_value, to_value, updated_by, reason)
        VALUES ('multi_vendor_pdp', NULL, v_derived, 'migration', 'initial seed from env/audit');
      END$$
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS feature_flag_history`)
    this.addSql(`DROP TABLE IF EXISTS feature_flag_state`)
  }
}
