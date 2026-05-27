import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260527090000MagicLinkRevocationActorType extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE IF EXISTS magic_link_revocation
        ADD COLUMN IF NOT EXISTS actor_type TEXT NULL
          CHECK (actor_type IN ('customer', 'admin', 'seller'))
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS magic_link_revocation
        DROP CONSTRAINT IF EXISTS magic_link_revocation_reason_check
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS magic_link_revocation
        ADD CONSTRAINT magic_link_revocation_reason_check
        CHECK (reason IN ('user_revoke', 'admin_revoke', 'seller_revoke', 'auto_expired', 'security_response'))
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS magic_link_revocation_actor_type_idx
        ON magic_link_revocation (actor_type)
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS magic_link_issued
        ADD COLUMN IF NOT EXISTS subject_seller_id TEXT NULL
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS magic_link_issued_seller_pending_idx
        ON magic_link_issued (subject_seller_id, expires_at DESC)
        WHERE subject_seller_id IS NOT NULL
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS magic_link_issued_seller_pending_idx`)
    this.addSql(`
      ALTER TABLE IF EXISTS magic_link_issued
        DROP COLUMN IF EXISTS subject_seller_id
    `)
    this.addSql(`DROP INDEX IF EXISTS magic_link_revocation_actor_type_idx`)
    this.addSql(`
      ALTER TABLE IF EXISTS magic_link_revocation
        DROP CONSTRAINT IF EXISTS magic_link_revocation_reason_check
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS magic_link_revocation
        ADD CONSTRAINT magic_link_revocation_reason_check
        CHECK (reason IN ('user_revoke', 'admin_revoke', 'auto_expired', 'security_response'))
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS magic_link_revocation
        DROP COLUMN IF EXISTS actor_type
    `)
  }
}
