import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260518000100MagicLinkIssuedLedger extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS magic_link_issued (
        token_jti           TEXT PRIMARY KEY,
        purpose             TEXT NOT NULL CHECK (purpose IN ('purchase', 'recover')),
        subject             JSONB NOT NULL,
        subject_customer_id TEXT NULL,
        market_id           TEXT NULL,
        issued_at           TIMESTAMPTZ NOT NULL,
        expires_at          TIMESTAMPTZ NOT NULL
      )
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS magic_link_issued_customer_pending_idx
        ON magic_link_issued (subject_customer_id, expires_at DESC)
        WHERE subject_customer_id IS NOT NULL
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS magic_link_issued_market_idx
        ON magic_link_issued (market_id)
        WHERE market_id IS NOT NULL
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS magic_link_issued_market_idx`)
    this.addSql(`DROP INDEX IF EXISTS magic_link_issued_customer_pending_idx`)
    this.addSql(`DROP TABLE IF EXISTS magic_link_issued`)
  }
}
