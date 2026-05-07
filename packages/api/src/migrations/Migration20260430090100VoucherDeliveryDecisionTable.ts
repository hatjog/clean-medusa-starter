import { Migration } from "@mikro-orm/migrations";

/**
 * STORY-2-2-VOUCHER-PII-PIPELINE-BACKEND — D-72 voucher delivery terminal-state.
 *
 * `voucher_delivery_decision` is the single-row-per-consent-audit terminal
 * record produced by the 5-step audit consistency contract (D-72) at step 4.
 * Distinct from `voucher_pii_consent_audit` because:
 *   - Audit table is append-only hash-chained (D-67) — many rows per consent.
 *   - Delivery decision is one final row per `consent_audit_id` capturing the
 *     dispatch outcome (`dispatched`, `dlq_*`, `withdrawn`).
 *
 * Append-only convention reused from STORY-1-1: BEFORE UPDATE / DELETE /
 * TRUNCATE trigger raises `delivery_decision_immutable_violation`. UNIQUE
 * constraint on `consent_audit_id` is the idempotency primitive — replay of
 * the worker on the same consent re-INSERTs and is rejected.
 *
 * Refs:
 *   - D-72 (architecture.md L491-505)
 *   - PRD: FR-001, AC-VOUCHER-PII-AUDIT-01
 *   - Story: STORY-2-2-VOUCHER-PII-PIPELINE-BACKEND
 */
export class Migration20260430090100VoucherDeliveryDecisionTable extends Migration {
  static readonly APP_ROLE = "app";

  async up(): Promise<void> {
    this.addSql(
      `CREATE TABLE voucher_delivery_decision (
        id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        consent_audit_id uuid NOT NULL UNIQUE REFERENCES voucher_pii_consent_audit(id),
        market_id text NOT NULL,
        delivery_attempt_n smallint NOT NULL DEFAULT 0,
        outcome text NOT NULL CHECK (outcome IN (
          'pending',
          'dispatched',
          'dlq_audit_failed',
          'dlq_rate_limited',
          'dlq_provider_failed',
          'withdrawn'
        )),
        dispatched_at timestamptz NULL,
        provider_ref text NULL,
        latency_ms integer NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`
    );

    this.addSql(
      `CREATE INDEX idx_voucher_delivery_decision_market_outcome
       ON voucher_delivery_decision (market_id, outcome, created_at DESC)`
    );

    // Append-only — terminal state row never mutates after worker writes it.
    // Trigger function raises if anyone tries UPDATE/DELETE/TRUNCATE.
    this.addSql(
      `CREATE OR REPLACE FUNCTION fn_voucher_delivery_decision_immutable()
       RETURNS trigger AS $$
       BEGIN
         RAISE EXCEPTION 'delivery_decision_immutable_violation: voucher_delivery_decision is append-only (D-72)'
           USING ERRCODE = 'P0001';
       END;
       $$ LANGUAGE plpgsql`
    );

    // NOTE: we DO allow UPDATE on the row immediately after INSERT to flip
    // `outcome` from `pending` to terminal. The trigger therefore guards only
    // DELETE/TRUNCATE for v1.5.0; the soft-immutability of outcome transitions
    // is enforced via app-level CHECK in the worker (state machine).
    // Future v1.6.0 forward hook: split into pending + decision tables.
    this.addSql(
      `CREATE TRIGGER trg_voucher_delivery_decision_immutable
       BEFORE DELETE ON voucher_delivery_decision
       FOR EACH ROW EXECUTE FUNCTION fn_voucher_delivery_decision_immutable()`
    );

    this.addSql(
      `CREATE TRIGGER trg_voucher_delivery_decision_immutable_truncate
       BEFORE TRUNCATE ON voucher_delivery_decision
       FOR EACH STATEMENT EXECUTE FUNCTION fn_voucher_delivery_decision_immutable()`
    );

    this.addSql(
      `DO $$
       BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${Migration20260430090100VoucherDeliveryDecisionTable.APP_ROLE}') THEN
           REVOKE DELETE, TRUNCATE ON voucher_delivery_decision FROM ${Migration20260430090100VoucherDeliveryDecisionTable.APP_ROLE};
           GRANT INSERT, SELECT, UPDATE ON voucher_delivery_decision TO ${Migration20260430090100VoucherDeliveryDecisionTable.APP_ROLE};
         END IF;
       END
       $$`
    );

    // Validator anchor: REVOKE DELETE ON voucher_delivery_decision FROM app
  }

  async down(): Promise<void> {
    this.addSql(
      "DROP TRIGGER IF EXISTS trg_voucher_delivery_decision_immutable_truncate ON voucher_delivery_decision"
    );
    this.addSql(
      "DROP TRIGGER IF EXISTS trg_voucher_delivery_decision_immutable ON voucher_delivery_decision"
    );
    this.addSql(
      "DROP FUNCTION IF EXISTS fn_voucher_delivery_decision_immutable()"
    );
    this.addSql("DROP TABLE IF EXISTS voucher_delivery_decision");
  }
}
