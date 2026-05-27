import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260527090000MagicLinkRevocationActorType extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE IF EXISTS magic_link_revocation
        ADD COLUMN IF NOT EXISTS actor_type TEXT NULL
          CHECK (actor_type IN ('customer', 'admin', 'seller'))
    `)
    // F-07: drop ANY pre-existing reason CHECK constraint on the table
    // (constraint name may differ between Postgres auto-generated and
    // entity-defined variants). pg_constraint scan is idempotent and safe
    // to re-run.
    this.addSql(`
      DO $$
      DECLARE
        con_name TEXT;
      BEGIN
        FOR con_name IN
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'magic_link_revocation'::regclass
            AND contype = 'c'
            AND pg_get_constraintdef(oid) ILIKE '%reason%'
        LOOP
          EXECUTE format('ALTER TABLE magic_link_revocation DROP CONSTRAINT IF EXISTS %I', con_name);
        END LOOP;
      END$$;
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS magic_link_revocation
        ADD CONSTRAINT magic_link_revocation_reason_check
        CHECK (reason IN ('user_revoke', 'admin_revoke', 'seller_revoke', 'auto_expired', 'security_response'))
    `)
    // F-05: backfill `actor_type` for historic rows so isolation probes
    // (NFR9.1, stories 6.5/6.6) can filter by actor_type without losing
    // pre-migration revocations. Idempotent via WHERE actor_type IS NULL.
    this.addSql(`
      UPDATE magic_link_revocation
         SET actor_type = CASE
             WHEN reason = 'admin_revoke' THEN 'admin'
             WHEN reason = 'user_revoke' THEN 'customer'
             ELSE actor_type
         END
       WHERE actor_type IS NULL
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS magic_link_revocation_actor_type_idx
        ON magic_link_revocation (actor_type)
    `)
    // Story 6.3 scope expansion documented in Change Log: `subject_seller_id`
    // column + partial index on `magic_link_issued` were required so the new
    // vendor revoke endpoint (and future 6.5 probes) can resolve seller
    // ownership without a JSON path lookup. Issuance path already populates
    // via `recordIssuedFromGenerated` (see lib/auth/magic-link-revocation.ts).
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
      DO $$
      DECLARE
        con_name TEXT;
      BEGIN
        FOR con_name IN
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'magic_link_revocation'::regclass
            AND contype = 'c'
            AND pg_get_constraintdef(oid) ILIKE '%reason%'
        LOOP
          EXECUTE format('ALTER TABLE magic_link_revocation DROP CONSTRAINT IF EXISTS %I', con_name);
        END LOOP;
      END$$;
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
