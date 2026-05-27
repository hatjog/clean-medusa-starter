import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export const SECRET_ROTATION_AUDIT_PROVIDERS = [
  "stripe_webhook",
  "brevo_hmac",
  "mercur_api",
  "google_wallet",
  "map_signing",
  "apple_wallet",
] as const

const MIGRATION_TABLE_MARKER =
  "created_by:Migration20260527083000SecretRotationAuditProviderColumn"

export class Migration20260527083000SecretRotationAuditProviderColumn extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      DO $$
      DECLARE
        table_existed boolean;
      BEGIN
        SELECT EXISTS (
          SELECT 1 FROM pg_class
          WHERE relname = 'secret_rotation_audit' AND relkind = 'r'
        ) INTO table_existed;

        IF NOT table_existed THEN
          CREATE TABLE secret_rotation_audit (
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
            event_timestamp            TIMESTAMPTZ NULL,
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
          );
          COMMENT ON TABLE secret_rotation_audit IS '${MIGRATION_TABLE_MARKER}';
        END IF;
      END $$;
    `)

    // Defensive ALTER dla drift scenario (tabela pre-existed z poprzednich srodowisk).
    // W tej galezi typ kolumny moze sie rozjechac wzgledem kontraktu, dlatego walidujemy
    // VARCHAR(32) i podnosimy bezpieczny blad zamiast cicho akceptowac szerszy typ.
    this.addSql(`
      DO $$
      DECLARE
        existing_type text;
        existing_max_len int;
      BEGIN
        SELECT data_type, character_maximum_length
          INTO existing_type, existing_max_len
        FROM information_schema.columns
        WHERE table_name = 'secret_rotation_audit' AND column_name = 'provider';

        IF existing_type IS NULL THEN
          ALTER TABLE secret_rotation_audit
            ADD COLUMN provider VARCHAR(32);
        ELSIF existing_type <> 'character varying' OR existing_max_len <> 32 THEN
          RAISE EXCEPTION 'secret_rotation_audit.provider type drift: % (max_len=%); expected VARCHAR(32)',
            existing_type, existing_max_len;
        END IF;
      END $$;
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
      ALTER TABLE secret_rotation_audit
        ADD COLUMN IF NOT EXISTS event_timestamp TIMESTAMPTZ NULL
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS secret_rotation_audit_market_provider_idx
        ON secret_rotation_audit (market_id, provider, created_at DESC)
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS secret_rotation_audit_market_provider_idx`)

    // Symetryczny rollback: jezeli tabela powstala w tej migracji (marker
    // w COMMENT) traktujemy down() jako pelny revert do v1.8.0 baseline i
    // dropujemy cala tabele wraz ze wszystkimi CHECK constraint. Jezeli tabela
    // istniala wczesniej, cofamy wylacznie ADD COLUMN provider + jego check.
    this.addSql(`
      DO $$
      DECLARE
        table_owned_by_migration boolean;
      BEGIN
        SELECT (
          obj_description('secret_rotation_audit'::regclass, 'pg_class')
            = '${MIGRATION_TABLE_MARKER}'
        ) INTO table_owned_by_migration;

        IF table_owned_by_migration THEN
          DROP TABLE IF EXISTS secret_rotation_audit;
        ELSE
          ALTER TABLE secret_rotation_audit
            DROP CONSTRAINT IF EXISTS secret_rotation_audit_provider_check;
          ALTER TABLE secret_rotation_audit
            DROP COLUMN IF EXISTS provider;
          ALTER TABLE secret_rotation_audit
            DROP COLUMN IF EXISTS event_timestamp;
        END IF;
      EXCEPTION
        WHEN undefined_table THEN
          NULL;
      END $$;
    `)
  }
}
