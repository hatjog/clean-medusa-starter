import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story v180-2-1: create entitlement_instance table (ADR-099 Layer 4).
 *
 * Source: architecture.md D-V180-ARCH-6 (ADR-099 4-layer entitlement model).
 * F-NEW-J2 naming (<UnixTimestampMs>_<descriptive_snake_case>.ts). DDL is
 * authored per Story 2.1 AC4 field spec — F-NEW-L1 ships verbatim DDL only for
 * webhook_event_processed / magic_link_revocation / payment_session, NOT for
 * entitlement_instance; this migration mirrors the idempotent class shape of
 * Migration20260507000000.ts.
 *
 * Layer 1 entitlement_type and Layer 4 state are enforced as CHECK
 * constraints (text + CHECK, same posture as the voucher table). Layer 3
 * entitlement_profile is declarative config (gp-ops market.yaml), NOT a DB
 * table — entitlement_profile_id is therefore a free text reference, not a FK.
 *
 * AUTHORED Story 2.1; APPLY confirmed Epic 1 Story 1.3 / live infra. No local
 * docker-compose data stack is available in this worktree (fresh submodule
 * checkout), so the migration is authored + committed but NOT applied — mirror
 * of the Story 0.18 authored-not-applied posture. Pre-prod drop+reload is
 * acceptable per memory feedback_pre_prod_db_drop_reload.
 *
 * Forward: creates entitlement_instance with CHECK constraints + indexes.
 * Reverse: drops the table.
 *
 * Migration is idempotent (CREATE TABLE IF NOT EXISTS).
 */
export class Migration1778880672656 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS entitlement_instance (
        id                      text PRIMARY KEY,
        -- Layer 3 reference: a per-market entitlement_profiles[].profile_id
        -- (declarative YAML config, not a DB table) — free text, no FK.
        entitlement_profile_id  text NOT NULL,
        -- Layer 1 canonical taxonomy (6 values, immutable platform-wide).
        entitlement_type        text NOT NULL CHECK (entitlement_type IN (
                                  'VOUCHER_AMOUNT','VOUCHER_SERVICE',
                                  'CREDIT_PACK','SUBSCRIPTION_B2C',
                                  'SUBSCRIPTION_B2B','BUNDLE')),
        -- Nullable until Epic 1 Story 1.3 FR1.22 wires live issue post-payment.
        order_id                text NULL,
        market_id               text NULL,
        -- Layer 4 state machine. Default ISSUED (snapshot taken at issue).
        state                   text NOT NULL DEFAULT 'ISSUED' CHECK (state IN (
                                  'ISSUED','ACTIVE','REDEMPTION_REQUESTED',
                                  'REDEEMED_PARTIAL','REDEEMED_FULL','SETTLED',
                                  'CLOSED','VOIDED','EXPIRED','REFUND_REQUESTED',
                                  'REFUNDED','DISPUTED')),
        -- Immutable policy block snapshotted at ISSUED (regulamin § 12).
        policy_snapshot         jsonb NOT NULL,
        -- Story 2.7 BE-6: remaining value in minor units; nullable for legacy
        -- rows and non-amount entitlements.
        remaining_amount        integer NULL CHECK (remaining_amount IS NULL OR remaining_amount >= 0),
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_at              timestamptz NOT NULL DEFAULT now()
      )
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS entitlement_instance_profile_idx
        ON entitlement_instance (entitlement_profile_id)
    `)
    // Partial index: order_id is NULL until live issue (Epic 1 Story 1.3).
    this.addSql(`
      CREATE INDEX IF NOT EXISTS entitlement_instance_order_idx
        ON entitlement_instance (order_id)
        WHERE order_id IS NOT NULL
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS entitlement_instance_state_idx
        ON entitlement_instance (state)
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS entitlement_instance`)
  }
}
