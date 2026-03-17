import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Story v120-1.3: gp_core Schema Migrations & State Machine
 *
 * Creates entitlements, redemptions, entitlement_audit_log tables in gp_core schema
 * with DB-enforced state transitions via BEFORE UPDATE trigger.
 *
 * Uses IF NOT EXISTS / DO $$ BEGIN ... EXCEPTION ... END $$ pattern to coexist
 * with Docker init scripts (infra/postgres/init/03-gp-core-entitlements.sql).
 *
 * Target database: gp_core (corePool_), NOT Mercur DB.
 */
export class Migration20260317000000 extends Migration {
  async up(): Promise<void> {
    // --- ENUM types ---
    // PostgreSQL has no CREATE TYPE IF NOT EXISTS, use exception handler
    this.addSql(`
      DO $$ BEGIN
        CREATE TYPE gp_core.entitlement_status AS ENUM (
          'ISSUED', 'ACTIVE', 'PARTIALLY_REDEEMED', 'REDEEMED',
          'VOIDED', 'REFUNDED', 'EXPIRED'
        );
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);

    this.addSql(`
      DO $$ BEGIN
        CREATE TYPE gp_core.regulatory_class AS ENUM (
          'STANDARD', 'REGULATED', 'MEDICAL'
        );
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);

    // --- Prerequisite tables (IF NOT EXISTS for coexistence with init scripts) ---
    this.addSql(`
      CREATE TABLE IF NOT EXISTS gp_core.verticals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        instance_id TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this.addSql(`
      CREATE TABLE IF NOT EXISTS gp_core.markets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        instance_id TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        vertical_id UUID REFERENCES gp_core.verticals(id),
        status TEXT NOT NULL DEFAULT 'active',
        sales_channel_id TEXT,
        payload_vendor_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // --- Entitlements table ---
    this.addSql(`
      CREATE TABLE IF NOT EXISTS gp_core.entitlements (
        entitlement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        instance_id TEXT NOT NULL,
        market_id UUID NOT NULL REFERENCES gp_core.markets(id),
        vendor_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        line_item_id TEXT NOT NULL,
        product_id TEXT,
        face_value_minor INTEGER NOT NULL CHECK (face_value_minor > 0),
        remaining_minor INTEGER NOT NULL CHECK (remaining_minor >= 0),
        currency TEXT NOT NULL DEFAULT 'PLN',
        status gp_core.entitlement_status NOT NULL DEFAULT 'ISSUED',
        regulatory_class gp_core.regulatory_class NOT NULL DEFAULT 'STANDARD',
        claim_token UUID UNIQUE DEFAULT gen_random_uuid(),
        voucher_code_normalized TEXT UNIQUE,
        buyer_email TEXT,
        buyer_is_recipient BOOLEAN NOT NULL DEFAULT false,
        customer_id TEXT,
        recipient_hint_masked TEXT,
        buyer_hint_masked TEXT,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (order_id, line_item_id)
      )
    `);

    // Add columns that may be missing if table was created by init script
    this.addSql(`ALTER TABLE gp_core.entitlements ADD COLUMN IF NOT EXISTS order_id TEXT`);
    this.addSql(`ALTER TABLE gp_core.entitlements ADD COLUMN IF NOT EXISTS line_item_id TEXT`);
    this.addSql(`ALTER TABLE gp_core.entitlements ADD COLUMN IF NOT EXISTS product_id TEXT`);
    this.addSql(`ALTER TABLE gp_core.entitlements ADD COLUMN IF NOT EXISTS regulatory_class gp_core.regulatory_class NOT NULL DEFAULT 'STANDARD'`);
    this.addSql(`ALTER TABLE gp_core.entitlements ADD COLUMN IF NOT EXISTS claim_token UUID UNIQUE DEFAULT gen_random_uuid()`);
    this.addSql(`ALTER TABLE gp_core.entitlements ADD COLUMN IF NOT EXISTS buyer_email TEXT`);
    this.addSql(`ALTER TABLE gp_core.entitlements ADD COLUMN IF NOT EXISTS buyer_is_recipient BOOLEAN NOT NULL DEFAULT false`);
    this.addSql(`ALTER TABLE gp_core.entitlements ADD COLUMN IF NOT EXISTS customer_id TEXT`);
    this.addSql(`ALTER TABLE gp_core.entitlements ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
    this.addSql(`ALTER TABLE gp_core.entitlements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

    // --- Entitlements indexes ---
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_entitlements_market_id ON gp_core.entitlements (market_id)`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_entitlements_vendor_id ON gp_core.entitlements (vendor_id)`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_entitlements_status ON gp_core.entitlements (status)`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_entitlements_voucher_code_normalized ON gp_core.entitlements (voucher_code_normalized)`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_entitlements_claim_token ON gp_core.entitlements (claim_token)`);

    // --- Redemptions table ---
    this.addSql(`
      CREATE TABLE IF NOT EXISTS gp_core.redemptions (
        redemption_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entitlement_id UUID NOT NULL REFERENCES gp_core.entitlements(entitlement_id) ON DELETE RESTRICT,
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        remaining_minor_after INTEGER NOT NULL,
        status_after gp_core.entitlement_status NOT NULL,
        idempotency_key TEXT NOT NULL,
        actor_hint TEXT,
        client_reference TEXT,
        note TEXT,
        performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (entitlement_id, idempotency_key)
      )
    `);

    this.addSql(`CREATE INDEX IF NOT EXISTS idx_redemptions_entitlement_id ON gp_core.redemptions (entitlement_id)`);

    // --- Entitlement Audit Log table (append-only) ---
    this.addSql(`
      CREATE TABLE IF NOT EXISTS gp_core.entitlement_audit_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entitlement_id UUID NOT NULL REFERENCES gp_core.entitlements(entitlement_id) ON DELETE RESTRICT,
        action TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        old_status TEXT,
        new_status TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this.addSql(`CREATE INDEX IF NOT EXISTS idx_audit_log_entitlement_id ON gp_core.entitlement_audit_log (entitlement_id)`);

    // --- State machine BEFORE UPDATE trigger ---
    this.addSql(`
      CREATE OR REPLACE FUNCTION gp_core.validate_entitlement_status_transition()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.status = NEW.status THEN
          RETURN NEW;
        END IF;

        IF NOT (OLD.status, NEW.status) IN (
          ('ISSUED', 'ACTIVE'),
          ('ISSUED', 'VOIDED'),
          ('ISSUED', 'REFUNDED'),
          ('ACTIVE', 'PARTIALLY_REDEEMED'),
          ('ACTIVE', 'REDEEMED'),
          ('ACTIVE', 'VOIDED'),
          ('ACTIVE', 'REFUNDED'),
          ('PARTIALLY_REDEEMED', 'REDEEMED'),
          ('PARTIALLY_REDEEMED', 'REFUNDED')
        ) THEN
          RAISE EXCEPTION 'Invalid state transition from % to %', OLD.status, NEW.status
            USING ERRCODE = 'check_violation';
        END IF;

        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    this.addSql(`
      DO $$ BEGIN
        CREATE TRIGGER trg_entitlement_status_transition
          BEFORE UPDATE OF status ON gp_core.entitlements
          FOR EACH ROW
          EXECUTE FUNCTION gp_core.validate_entitlement_status_transition();
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS trg_entitlement_status_transition ON gp_core.entitlements`);
    this.addSql(`DROP FUNCTION IF EXISTS gp_core.validate_entitlement_status_transition()`);
    this.addSql(`DROP TABLE IF EXISTS gp_core.entitlement_audit_log`);
    this.addSql(`DROP TABLE IF EXISTS gp_core.redemptions`);
    this.addSql(`DROP TABLE IF EXISTS gp_core.entitlements`);
    this.addSql(`DROP TYPE IF EXISTS gp_core.regulatory_class`);
    this.addSql(`DROP TYPE IF EXISTS gp_core.entitlement_status`);
  }
}
