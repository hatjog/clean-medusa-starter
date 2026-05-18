import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260518000200MagicLinkIssuedLedgerRetention extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE IF EXISTS magic_link_issued
      ALTER COLUMN subject DROP NOT NULL
    `)
    this.addSql(`
      UPDATE magic_link_issued
      SET subject = NULL
      WHERE subject IS NOT NULL
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS magic_link_issued_expires_at_idx
        ON magic_link_issued (expires_at)
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS magic_link_issued_expires_at_idx`)
  }
}
