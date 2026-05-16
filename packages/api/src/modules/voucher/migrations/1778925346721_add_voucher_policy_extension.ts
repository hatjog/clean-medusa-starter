import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story v180-2-2: add BE-1 voucher policy extension substrate.
 *
 * Source: epics.md Story 2.2 BE-1 (FR1.12) + architecture project-structure.
 *
 * Forward: adds entitlement_instance.expires_at and unpaid extension counter.
 * Reverse: drops the added columns.
 *
 * Migration is idempotent (ALTER TABLE IF EXISTS + ADD COLUMN IF NOT EXISTS).
 */
export class Migration1778925346721 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        ADD COLUMN IF NOT EXISTS unpaid_extension_count integer NOT NULL DEFAULT 0
    `)
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.tables
           WHERE table_name = 'entitlement_instance'
        ) THEN
          ALTER TABLE entitlement_instance
            DROP CONSTRAINT IF EXISTS entitlement_instance_unpaid_extension_count_nonnegative;
          ALTER TABLE entitlement_instance
            ADD CONSTRAINT entitlement_instance_unpaid_extension_count_nonnegative
            CHECK (unpaid_extension_count >= 0);
        END IF;
      END $$;
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS entitlement_instance_expires_at_idx
        ON entitlement_instance (expires_at)
        WHERE expires_at IS NOT NULL
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS entitlement_instance_expires_at_idx`)
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        DROP CONSTRAINT IF EXISTS entitlement_instance_unpaid_extension_count_nonnegative
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        DROP COLUMN IF EXISTS unpaid_extension_count
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        DROP COLUMN IF EXISTS expires_at
    `)
  }
}
