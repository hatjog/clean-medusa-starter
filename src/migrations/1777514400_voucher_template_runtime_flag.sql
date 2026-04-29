-- 1777514400_voucher_template_runtime_flag.sql
--
-- STORY-2-3-VOUCHER-TEMPLATE-RUNTIME-ER11 — D-79 per-market flag column.
--
-- Adds the `voucher_template_v1_runtime_enabled` per-market flag plus the
-- `legal_signoff_status` column used by the D-59 hard gate. The flag is
-- intentionally added to a NEW table (`vendor_template_runtime_flag`) rather
-- than overloading `market_runtime_config` because the runtime activation
-- carries audit + signoff metadata that does not belong on the market config
-- row (per architecture.md L573-578 + D-79 boundary).
--
-- Defaults: every existing market gets a row with `flag_state = 'off'` and
-- `signoff_status = 'pending'`. The D-59 gate (validate_d59_legal_signoff.py
-- + RuntimeFlagResolver) prevents transition to `'on'` until signoff is
-- recorded.
--
-- Idempotent: uses `IF NOT EXISTS` everywhere so running the migration twice
-- is a no-op.
--
-- Refs:
--   - D-79 (architecture.md L573-578)
--   - D-59 (architecture.md L1273-1274 G-COMPLIANCE-LEGAL/EXTERNAL)
--   - ADR-068 (specs/adr/2026-04-29-adr-068-compliance-checklist.md)
--   - STORY-2-3 spec L406 ("Flag voucher_template_v1_runtime_enabled registered per market")
--
-- Run order: applies AFTER STORY-1-1 (`voucher_pii_consent_audit`) and AFTER
-- STORY-1-3 (flag resolver schema). Both land earlier in the v1.5.0 sprint
-- waves.

BEGIN;

-- 1. Per-market flag table.
CREATE TABLE IF NOT EXISTS vendor_template_runtime_flag (
  market_id text NOT NULL PRIMARY KEY,
  flag_state text NOT NULL DEFAULT 'off'
    CHECK (flag_state IN ('off', 'on', 'kill_switch')),
  last_transition_at timestamptz NULL,
  last_transition_actor_id text NULL,
  last_transition_reason text NULL,
  signoff_status text NOT NULL DEFAULT 'pending'
    CHECK (signoff_status IN ('pending', 'approved', 'expired', 'revoked', 'forged')),
  signoff_signed_at timestamptz NULL,
  signoff_pdf_hash bytea NULL,
  signoff_last_hash_verified_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Index supporting "all markets currently ON" sweep + ops dashboards.
CREATE INDEX IF NOT EXISTS idx_vendor_template_runtime_flag_state
  ON vendor_template_runtime_flag (flag_state)
  WHERE flag_state = 'on';

-- 3. Index supporting monthly hash verification cron (per pre-mortem #34).
CREATE INDEX IF NOT EXISTS idx_vendor_template_runtime_flag_hash_verified
  ON vendor_template_runtime_flag (signoff_last_hash_verified_at)
  WHERE signoff_status = 'approved';

-- 4. Trigger: keep `updated_at` honest.
CREATE OR REPLACE FUNCTION fn_vendor_template_runtime_flag_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vendor_template_runtime_flag_touch
  ON vendor_template_runtime_flag;
CREATE TRIGGER trg_vendor_template_runtime_flag_touch
  BEFORE UPDATE ON vendor_template_runtime_flag
  FOR EACH ROW EXECUTE FUNCTION fn_vendor_template_runtime_flag_touch();

-- 5. Defence-in-depth: forbid direct INSERT/DELETE from app role; only the
--    flag-resolver service (running with elevated role) may transition state.
--    Mirrors the audit-table pattern from STORY-1-1.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    REVOKE INSERT, DELETE, TRUNCATE ON vendor_template_runtime_flag FROM app;
    GRANT SELECT, UPDATE ON vendor_template_runtime_flag TO app;
  END IF;
END $$;

-- 6. Seed rows for known markets — idempotent ON CONFLICT DO NOTHING. The
--    operator MAY insert new markets later via the runbook. Default flag_state
--    is 'off', signoff_status is 'pending'.
INSERT INTO vendor_template_runtime_flag (market_id, flag_state, signoff_status)
VALUES
  ('pl', 'off', 'pending'),
  ('ua', 'off', 'pending'),
  ('de', 'off', 'pending'),
  ('en', 'off', 'pending')
ON CONFLICT (market_id) DO NOTHING;

COMMIT;
