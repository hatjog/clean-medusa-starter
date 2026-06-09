import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * v1.12.0 Story 1.1 — denormalized market_id for gp_core redemptions/audit.
 *
 * Target database: gp_core. This is schema + backfill only; RLS policy rollout
 * is handled by later stories (1.2 session-var, 1.3 policy USING/WITH CHECK).
 *
 * AC5 / smoke note: as of v1.11.0 there are no application-layer writers to
 * gp_core.redemptions or gp_core.entitlement_audit_log (the live redemption
 * path runs through gp_mercur voucher_redemption). The new NOT NULL column is
 * therefore additive and transparent for all existing v1.11.0 endpoints
 * (issue → redeem → read → audit). Any future writer that inserts into these
 * tables MUST supply market_id — the NOT NULL constraint enforces this
 * explicitly and intentionally.
 */
export class Migration20260524133525 extends Migration {
  async up(): Promise<void> {
    this.addSql(`CREATE SCHEMA IF NOT EXISTS gp_core`);

    // L2: idempotency is per-column: check the specific column existence via
    // information_schema, not just the table. This avoids silently skipping the
    // entire block when the table exists but the column does not yet.
    // L1: guard also checks gp_core.markets (FK target) so an undefined_table
    // error cannot escape the duplicate_object handler.
    this.addSql(`
      DO $$ BEGIN
        IF to_regclass('gp_core.redemptions') IS NOT NULL
           AND to_regclass('gp_core.entitlements') IS NOT NULL
           AND to_regclass('gp_core.markets') IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'gp_core'
               AND table_name   = 'redemptions'
               AND column_name  = 'market_id'
           ) THEN
          ALTER TABLE gp_core.redemptions ADD COLUMN market_id uuid;
        END IF;

        IF to_regclass('gp_core.redemptions') IS NOT NULL
           AND to_regclass('gp_core.entitlements') IS NOT NULL THEN
          UPDATE gp_core.redemptions r
          SET market_id = e.market_id
          FROM gp_core.entitlements e
          WHERE r.entitlement_id = e.entitlement_id
            AND r.market_id IS NULL;

          ALTER TABLE gp_core.redemptions ALTER COLUMN market_id SET NOT NULL;

          CREATE INDEX IF NOT EXISTS idx_redemptions_market_id
            ON gp_core.redemptions (market_id);

          BEGIN
            ALTER TABLE gp_core.redemptions
              ADD CONSTRAINT fk_redemptions_market_id
              FOREIGN KEY (market_id) REFERENCES gp_core.markets(id);
          EXCEPTION WHEN duplicate_object THEN null;
          END;
        END IF;
      END $$
    `);

    this.addSql(`
      DO $$ BEGIN
        IF to_regclass('gp_core.entitlement_audit_log') IS NOT NULL
           AND to_regclass('gp_core.entitlements') IS NOT NULL
           AND to_regclass('gp_core.markets') IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'gp_core'
               AND table_name   = 'entitlement_audit_log'
               AND column_name  = 'market_id'
           ) THEN
          ALTER TABLE gp_core.entitlement_audit_log ADD COLUMN market_id uuid;
        END IF;

        IF to_regclass('gp_core.entitlement_audit_log') IS NOT NULL
           AND to_regclass('gp_core.entitlements') IS NOT NULL THEN
          UPDATE gp_core.entitlement_audit_log a
          SET market_id = e.market_id
          FROM gp_core.entitlements e
          WHERE a.entitlement_id = e.entitlement_id
            AND a.market_id IS NULL;

          ALTER TABLE gp_core.entitlement_audit_log ALTER COLUMN market_id SET NOT NULL;

          CREATE INDEX IF NOT EXISTS idx_entitlement_audit_log_market_id
            ON gp_core.entitlement_audit_log (market_id);

          BEGIN
            ALTER TABLE gp_core.entitlement_audit_log
              ADD CONSTRAINT fk_entitlement_audit_log_market_id
              FOREIGN KEY (market_id) REFERENCES gp_core.markets(id);
          EXCEPTION WHEN duplicate_object THEN null;
          END;
        END IF;
      END $$
    `);
  }

  async down(): Promise<void> {
    // L3: guard down() with to_regclass so it is safe even if tables were
    // never created (mirrors the defensive pattern from up()).
    this.addSql(`
      DO $$ BEGIN
        IF to_regclass('gp_core.entitlement_audit_log') IS NOT NULL THEN
          ALTER TABLE gp_core.entitlement_audit_log DROP CONSTRAINT IF EXISTS fk_entitlement_audit_log_market_id;
          DROP INDEX IF EXISTS gp_core.idx_entitlement_audit_log_market_id;
          ALTER TABLE gp_core.entitlement_audit_log DROP COLUMN IF EXISTS market_id;
        END IF;
        IF to_regclass('gp_core.redemptions') IS NOT NULL THEN
          ALTER TABLE gp_core.redemptions DROP CONSTRAINT IF EXISTS fk_redemptions_market_id;
          DROP INDEX IF EXISTS gp_core.idx_redemptions_market_id;
          ALTER TABLE gp_core.redemptions DROP COLUMN IF EXISTS market_id;
        END IF;
      END $$
    `);
  }
}
