import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260506170000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS commission_audit_log (
        id UUID PRIMARY KEY,
        market_id TEXT NOT NULL DEFAULT 'unknown',
        event_name TEXT NOT NULL,
        commission_line_id TEXT,
        order_id TEXT,
        seller_id TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_commission_audit_log_market_id ON commission_audit_log (market_id)`)
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_commission_audit_log_order_id ON commission_audit_log (order_id)`)
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_commission_audit_log_seller_id ON commission_audit_log (seller_id)`)
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_commission_audit_log_created_at ON commission_audit_log (created_at)`)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS commission_audit_log`)
  }
}
