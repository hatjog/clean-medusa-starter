import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260518000300MagicLinkIssuedSubjectEmail extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE IF EXISTS magic_link_issued
        ADD COLUMN IF NOT EXISTS subject_email TEXT NULL
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS magic_link_issued_subject_email_idx
        ON magic_link_issued (subject_email)
        WHERE subject_email IS NOT NULL
    `)
  }

  async down(): Promise<void> {
    this.addSql(`SELECT 1`)
  }
}
