import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260526100000AddTranslationTables extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE IF EXISTS "translation"
      DROP CONSTRAINT IF EXISTS "translation_reference_id_locale_code_unique"
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS "locale"
      DROP CONSTRAINT IF EXISTS "locale_code_unique"
    `)
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "locale" (
        "id" text NOT NULL,
        "code" text NOT NULL,
        "name" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz NULL,
        CONSTRAINT "locale_pkey" PRIMARY KEY ("id")
      )
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS "IDX_locale_deleted_at"
      ON "locale" ("deleted_at")
      WHERE deleted_at IS NULL
    `)
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_locale_code_unique"
      ON "locale" ("code")
      WHERE deleted_at IS NULL
    `)
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "translation" (
        "id" text NOT NULL,
        "reference_id" text NOT NULL,
        "reference" text NOT NULL,
        "locale_code" text NOT NULL,
        "translations" jsonb NOT NULL,
        "translated_field_count" integer NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz NULL,
        CONSTRAINT "translation_pkey" PRIMARY KEY ("id")
      )
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS "IDX_translation_deleted_at"
      ON "translation" ("deleted_at")
      WHERE deleted_at IS NULL
    `)
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_translation_reference_id_locale_code_unique"
      ON "translation" ("reference_id", "locale_code")
      WHERE deleted_at IS NULL
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS "IDX_translation_reference_id_reference_locale_code"
      ON "translation" ("reference_id", "reference", "locale_code")
      WHERE deleted_at IS NULL
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS "IDX_translation_reference_locale_code"
      ON "translation" ("reference", "locale_code")
      WHERE deleted_at IS NULL
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS "IDX_translation_reference_id_reference"
      ON "translation" ("reference_id", "reference")
      WHERE deleted_at IS NULL
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS "IDX_translation_locale_code"
      ON "translation" ("locale_code")
      WHERE deleted_at IS NULL
    `)
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "translation_settings" (
        "id" text NOT NULL,
        "entity_type" text NOT NULL,
        "fields" jsonb NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz NULL,
        CONSTRAINT "translation_settings_pkey" PRIMARY KEY ("id")
      )
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS "IDX_translation_settings_deleted_at"
      ON "translation_settings" ("deleted_at")
      WHERE deleted_at IS NULL
    `)
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_translation_settings_entity_type_unique"
      ON "translation_settings" ("entity_type")
      WHERE deleted_at IS NULL
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "translation_settings" CASCADE`)
    this.addSql(`DROP TABLE IF EXISTS "translation" CASCADE`)
    this.addSql(`DROP TABLE IF EXISTS "locale" CASCADE`)
  }
}
