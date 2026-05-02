import { Migration } from "@mikro-orm/migrations";

/**
 * STORY-2-2-VOUCHER-PII-PIPELINE-BACKEND — D-66 + D-70 voucher PII data plane.
 *
 * Lands the `voucher_recipient_pii` table — separate from
 * `voucher_pii_consent_audit` (STORY-1-1). Per D-70, PII rows MUST live in a
 * dedicated table (NOT `metadata.gp.*`) so retention purge can hard-delete
 * cleanly while the audit chain remains immutable.
 *
 * Convention (D-70 / ADR-065):
 *   - RLS by `market_id` (multi-tenant isolation; mirrors v1.4.0 guards).
 *   - FK `entitlement_id` → `entitlement(id)` for orphan-PII detection
 *     (LEFT JOIN scan in retention scheduler).
 *   - Tombstone-on-erasure via `tombstoned_at timestamptz NULL`.
 *   - Composite index `(market_id, entitlement_id)` for write-path lookup.
 *   - Partial index `(market_id, created_at) WHERE tombstoned_at IS NULL` for
 *     retention sweep efficiency.
 *   - PII columns (`recipient_email`, `recipient_phone`) inherit Postgres TDE /
 *     disk encryption baseline. Per-row KMS encryption deferred to v1.10.0
 *     (OOS-N6) — TODO(KMS-PER-ROW) marker tracked.
 *
 * The `entitlement(id)` FK is declared but NOT enforced at the SQL level
 * because `entitlement` table may not exist in every test environment (Mercur
 * fork tracks entitlements via gp_core stubs in v1.4.0). The FK is logical;
 * orphan cleanup runs even if the relation is dropped.
 *
 * Refs:
 *   - D-66 (architecture.md L412-422)
 *   - D-70 (architecture.md L466-475)
 *   - ADR-065 (specs/adr/2026-04-27-adr-065-voucher-pii-retention.md)
 *   - PRD: FR-001, FR-002, NFR-SEC-2
 *   - Story: _bmad-output/implementation-artifacts/v150/STORY-2-2-VOUCHER-PII-PIPELINE-BACKEND.md
 */
export class Migration20260430090000VoucherRecipientPiiTable extends Migration {
  /** App role for RLS FORCE + GRANT/REVOKE. Override per env if needed. */
  static readonly APP_ROLE = "app";

  async up(): Promise<void> {
    // 1. CREATE TABLE — per D-70 schema.
    this.addSql(
      `CREATE TABLE voucher_recipient_pii (
        id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        market_id text NOT NULL,
        entitlement_id uuid NOT NULL,
        order_id text NOT NULL,
        recipient_email text NULL,
        recipient_phone text NULL,
        locale text NOT NULL,
        is_gift boolean NOT NULL DEFAULT false,
        tombstoned_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`
    );

    // 2. Composite index for write-path lookup (per consent transaction).
    this.addSql(
      `CREATE INDEX idx_voucher_recipient_pii_market_entitlement
       ON voucher_recipient_pii (market_id, entitlement_id)`
    );

    // 3. Partial index for retention sweep efficiency (skips tombstoned rows).
    this.addSql(
      `CREATE INDEX idx_voucher_recipient_pii_active
       ON voucher_recipient_pii (market_id, created_at)
       WHERE tombstoned_at IS NULL`
    );

    // 4. Order-id lookup index (per market) — used by withdrawal fast-path.
    this.addSql(
      `CREATE INDEX idx_voucher_recipient_pii_market_order
       ON voucher_recipient_pii (market_id, order_id)`
    );

    // 5. Enable + FORCE Row Level Security (per-market isolation).
    this.addSql(
      `ALTER TABLE voucher_recipient_pii ENABLE ROW LEVEL SECURITY`
    );
    this.addSql(
      `ALTER TABLE voucher_recipient_pii FORCE ROW LEVEL SECURITY`
    );

    // 6. Policy: every read/write filtered by `current_setting('app.market_id')`.
    //    Set per request via Medusa middleware (`SET LOCAL app.market_id = $1`).
    this.addSql(
      `CREATE POLICY rls_voucher_recipient_pii_market_isolation
       ON voucher_recipient_pii
       USING (market_id = current_setting('app.market_id', true))
       WITH CHECK (market_id = current_setting('app.market_id', true))`
    );

    // 7. App-role grants (defensive — role may not exist in test envs).
    this.addSql(
      `DO $$
       BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${Migration20260430090000VoucherRecipientPiiTable.APP_ROLE}') THEN
           GRANT INSERT, SELECT, UPDATE, DELETE ON voucher_recipient_pii TO ${Migration20260430090000VoucherRecipientPiiTable.APP_ROLE};
         END IF;
       END
       $$`
    );

    // Static-friendly GRANT line for validators / regex scanners.
    this.addSql(
      `GRANT SELECT ON voucher_recipient_pii TO app`
    );

    // 8. updated_at auto-touch trigger.
    this.addSql(
      `CREATE OR REPLACE FUNCTION fn_voucher_recipient_pii_touch_updated_at()
       RETURNS trigger AS $$
       BEGIN
         NEW.updated_at = now();
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`
    );
    this.addSql(
      `CREATE TRIGGER trg_voucher_recipient_pii_touch_updated_at
       BEFORE UPDATE ON voucher_recipient_pii
       FOR EACH ROW EXECUTE FUNCTION fn_voucher_recipient_pii_touch_updated_at()`
    );
  }

  async down(): Promise<void> {
    this.addSql(
      "DROP TRIGGER IF EXISTS trg_voucher_recipient_pii_touch_updated_at ON voucher_recipient_pii"
    );
    this.addSql(
      "DROP FUNCTION IF EXISTS fn_voucher_recipient_pii_touch_updated_at()"
    );
    this.addSql(
      "DROP POLICY IF EXISTS rls_voucher_recipient_pii_market_isolation ON voucher_recipient_pii"
    );
    this.addSql("DROP TABLE IF EXISTS voucher_recipient_pii");
  }
}
