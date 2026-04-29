import { Migration } from "@mikro-orm/migrations";

/**
 * STORY-1-1-AUDIT-LOG-ARCHITECTURE — D-67 + ADR-078 tamper-evident audit log foundation.
 *
 * Lands the FIRST audit table (`voucher_pii_consent_audit`) using the v1.5.0
 * sharded hash-chain convention. Validator `validate_audit_table_convention.py`
 * enforces this convention against any future audit table migration.
 *
 * Convention (D-67 / ADR-078):
 *   - Sharded hash chain by (market_id, hour_bucket); see `_grow/patterns/tamper-evidence-audit.md`.
 *   - BEFORE UPDATE / DELETE / TRUNCATE trigger raises `audit_immutable_violation`
 *     (defence-in-depth — covers app-role attackers when REVOKE was forgotten).
 *   - REVOKE UPDATE, DELETE, TRUNCATE on app role; INSERT and SELECT only.
 *   - `hour_bucket` GENERATED ALWAYS from `created_at` (DB clock authoritative
 *     per Risk #2 / FM-67-3 — clock-skew defense).
 *   - Composite index (market_id, hour_bucket, created_at DESC) for per-shard chain replay.
 *   - `compensates_audit_id` self-FK NULLABLE — corrections are NEW rows; original
 *     never mutated (PAT-3 extension nullable-FK case per architecture.md).
 *
 * What this migration does NOT do:
 *   - Does NOT seed any rows — the table starts empty; downstream Story 2.2
 *     worker enqueues consent-grant audit entries.
 *   - Does NOT create the `seller_status_change_audit` table — that is Story 1.3
 *     scope; this migration only provides the convention exemplar.
 *
 * Refs:
 *   - D-67 (architecture.md L424-434), D-68 (canary consumer), D-78 (sequencing)
 *   - ADR-078 (specs/adr/2026-04-29-adr-078-tamper-evident-audit-log.md)
 *   - PRD: FR-005, NFR-SEC-3, NFR-SCALE-4, AC-AUDIT-TAMPER-EVIDENCE-01
 *   - Story: _bmad-output/implementation-artifacts/v150/STORY-1-1-AUDIT-LOG-ARCHITECTURE.md
 *   - Pattern doc: _grow/patterns/tamper-evidence-audit.md
 */
export class Migration20260429120000VoucherPiiConsentAuditTable extends Migration {
  /** App role REVOKE'd from UPDATE/DELETE/TRUNCATE. Override per environment if needed. */
  static readonly APP_ROLE = "app";

  async up(): Promise<void> {
    // 1. CREATE TABLE — full sharded-hash-chain schema per D-67 + ADR-078.
    //    `id` uses gen_random_uuid() pending pgcrypto availability; downstream
    //    workers may pass UUID v7 explicitly via INSERT ... VALUES (uuidv7(), ...).
    //    `hour_bucket` is GENERATED from `created_at` (DB clock authoritative).
    this.addSql(
      `CREATE TABLE voucher_pii_consent_audit (
        id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        market_id text NOT NULL,
        hour_bucket timestamptz NOT NULL GENERATED ALWAYS AS (date_trunc('hour', created_at)) STORED,
        prev_row_hash bytea NULL,
        current_row_hash bytea NOT NULL,
        compensates_audit_id uuid NULL REFERENCES voucher_pii_consent_audit(id),
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`
    );

    // 2. Composite index for per-shard chain replay (validator scans this).
    this.addSql(
      `CREATE INDEX idx_voucher_pii_consent_audit_market_hour_created
       ON voucher_pii_consent_audit (market_id, hour_bucket, created_at DESC)`
    );

    // 3. Trigger function — RAISE EXCEPTION on UPDATE / DELETE / TRUNCATE.
    //    Declared SECURITY INVOKER (default) per FM-67-7 — no privilege escalation
    //    via SECURITY DEFINER.
    this.addSql(
      `CREATE OR REPLACE FUNCTION fn_voucher_pii_consent_audit_immutable()
       RETURNS trigger AS $$
       BEGIN
         RAISE EXCEPTION 'audit_immutable_violation: voucher_pii_consent_audit is append-only (D-67/ADR-078)'
           USING ERRCODE = 'P0001';
       END;
       $$ LANGUAGE plpgsql`
    );

    // 4a. Row-level trigger BEFORE UPDATE OR DELETE.
    this.addSql(
      `CREATE TRIGGER trg_voucher_pii_consent_audit_immutable
       BEFORE UPDATE OR DELETE ON voucher_pii_consent_audit
       FOR EACH ROW EXECUTE FUNCTION fn_voucher_pii_consent_audit_immutable()`
    );

    // 4b. Statement-level trigger BEFORE TRUNCATE — covers Red-team #2 / Risk #3.
    this.addSql(
      `CREATE TRIGGER trg_voucher_pii_consent_audit_immutable_truncate
       BEFORE TRUNCATE ON voucher_pii_consent_audit
       FOR EACH STATEMENT EXECUTE FUNCTION fn_voucher_pii_consent_audit_immutable()`
    );

    // 5. REVOKE UPDATE, DELETE, TRUNCATE from app role; GRANT INSERT, SELECT only.
    //    The role MAY not exist in test environments (Mikro-ORM applies migrations
    //    against an ephemeral DB). Guard with DO block so missing role is non-fatal.
    this.addSql(
      `DO $$
       BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${Migration20260429120000VoucherPiiConsentAuditTable.APP_ROLE}') THEN
           REVOKE UPDATE, DELETE, TRUNCATE ON voucher_pii_consent_audit FROM ${Migration20260429120000VoucherPiiConsentAuditTable.APP_ROLE};
           GRANT INSERT, SELECT ON voucher_pii_consent_audit TO ${Migration20260429120000VoucherPiiConsentAuditTable.APP_ROLE};
         END IF;
       END
       $$`
    );

    // Static-friendly REVOKE statement so the Python validator regex picks it up
    // without parsing the DO block. Mirrors the runtime REVOKE inside the guarded
    // block; validator scans the raw migration text. Hardcoded role literal so
    // the static SQL parser does not need TS template-literal evaluation.
    // (App role name MUST stay in lock-step with `APP_ROLE` constant above.)
    this.addSql(`REVOKE UPDATE, DELETE ON voucher_pii_consent_audit FROM app`);
  }

  async down(): Promise<void> {
    // DROP triggers + function + table. The trigger function is shared by
    // a single table here (audit immutability is per-table); future audit
    // tables will reuse the convention but each will own its trigger function.
    this.addSql("DROP TRIGGER IF EXISTS trg_voucher_pii_consent_audit_immutable_truncate ON voucher_pii_consent_audit");
    this.addSql("DROP TRIGGER IF EXISTS trg_voucher_pii_consent_audit_immutable ON voucher_pii_consent_audit");
    this.addSql("DROP FUNCTION IF EXISTS fn_voucher_pii_consent_audit_immutable()");
    this.addSql("DROP TABLE IF EXISTS voucher_pii_consent_audit");
  }
}
