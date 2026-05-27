import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export const SECRET_ROTATION_AUDIT_PROVIDERS = [
  "stripe_webhook",
  "brevo_hmac",
  "mercur_api",
  "google_wallet",
  "map_signing",
  "apple_wallet",
] as const

export class Migration20260527083000SecretRotationAuditProviderColumn extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS secret_rotation_audit (
        id                         TEXT PRIMARY KEY,
        provider                   VARCHAR(32) NOT NULL,
        secret_class_resource_name TEXT NOT NULL,
        market_id                  TEXT NOT NULL,
        rotation_event_kind        VARCHAR(32) NOT NULL,
        previous_version_id        TEXT NULL,
        new_version_id             TEXT NULL,
        outcome                    VARCHAR(32) NOT NULL,
        actor                      TEXT NOT NULL,
        evidence_artifact_ref      TEXT NULL,
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT secret_rotation_audit_provider_check
          CHECK (provider IN (
            'stripe_webhook',
            'brevo_hmac',
            'mercur_api',
            'google_wallet',
            'map_signing',
            'apple_wallet'
          )),
        CONSTRAINT secret_rotation_audit_rotation_event_kind_check
          CHECK (rotation_event_kind IN (
            'version_created',
            'canary_promoted',
            'old_version_disabled',
            'rollback',
            'stub_out_drill'
          )),
        CONSTRAINT secret_rotation_audit_outcome_check
          CHECK (outcome IN (
            'success',
            'failed',
            'rolled_back',
            'stub_out'
          ))
      )
    `)

    this.addSql(`
      ALTER TABLE secret_rotation_audit
        ADD COLUMN IF NOT EXISTS provider VARCHAR(32)
    `)

    this.addSql(`
      UPDATE secret_rotation_audit
        SET provider = 'mercur_api'
        WHERE provider IS NULL
    `)

    this.addSql(`
      ALTER TABLE secret_rotation_audit
        ALTER COLUMN provider SET NOT NULL
    `)

    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'secret_rotation_audit_provider_check'
        ) THEN
          ALTER TABLE secret_rotation_audit
            ADD CONSTRAINT secret_rotation_audit_provider_check
            CHECK (provider IN (
              'stripe_webhook',
              'brevo_hmac',
              'mercur_api',
              'google_wallet',
              'map_signing',
              'apple_wallet'
            ));
        END IF;
      END $$;
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS secret_rotation_audit_market_provider_idx
        ON secret_rotation_audit (market_id, provider, created_at DESC)
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS secret_rotation_audit_market_provider_idx`)
    this.addSql(`
      ALTER TABLE secret_rotation_audit
        DROP CONSTRAINT IF EXISTS secret_rotation_audit_provider_check
    `)
    this.addSql(`
      ALTER TABLE secret_rotation_audit
        DROP COLUMN IF EXISTS provider
    `)
  }
}
