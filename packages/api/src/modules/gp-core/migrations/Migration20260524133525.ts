import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * v1.12.0 Story 1.1 — denormalized market_id for gp_core redemptions/audit.
 *
 * Target database: gp_core. This is schema + backfill only; RLS policy rollout
 * is handled by later stories.
 */
export class Migration20260524133525 extends Migration {
  async up(): Promise<void> {
    this.addSql(`CREATE SCHEMA IF NOT EXISTS gp_core`);

    this.addSql(`
      DO $$ BEGIN
        IF to_regclass('gp_core.redemptions') IS NOT NULL
           AND to_regclass('gp_core.entitlements') IS NOT NULL THEN
          ALTER TABLE gp_core.redemptions ADD COLUMN IF NOT EXISTS market_id uuid;

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
           AND to_regclass('gp_core.entitlements') IS NOT NULL THEN
          ALTER TABLE gp_core.entitlement_audit_log ADD COLUMN IF NOT EXISTS market_id uuid;

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
    this.addSql(`ALTER TABLE gp_core.entitlement_audit_log DROP CONSTRAINT IF EXISTS fk_entitlement_audit_log_market_id`);
    this.addSql(`ALTER TABLE gp_core.redemptions DROP CONSTRAINT IF EXISTS fk_redemptions_market_id`);
    this.addSql(`DROP INDEX IF EXISTS gp_core.idx_entitlement_audit_log_market_id`);
    this.addSql(`DROP INDEX IF EXISTS gp_core.idx_redemptions_market_id`);
    this.addSql(`ALTER TABLE gp_core.entitlement_audit_log DROP COLUMN IF EXISTS market_id`);
    this.addSql(`ALTER TABLE gp_core.redemptions DROP COLUMN IF EXISTS market_id`);
  }
}
