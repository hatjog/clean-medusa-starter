import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260506173000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`ALTER TABLE commission_audit_log ADD COLUMN IF NOT EXISTS market_id TEXT`)
    this.addSql(`UPDATE commission_audit_log SET market_id = 'unknown' WHERE market_id IS NULL OR market_id = ''`)
    this.addSql(`ALTER TABLE commission_audit_log ALTER COLUMN market_id SET DEFAULT 'unknown'`)
    this.addSql(`ALTER TABLE commission_audit_log ALTER COLUMN market_id SET NOT NULL`)
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_commission_audit_log_market_id ON commission_audit_log (market_id)`)
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS idx_commission_audit_log_market_id`)
    this.addSql(`ALTER TABLE commission_audit_log DROP COLUMN IF EXISTS market_id`)
  }
}
