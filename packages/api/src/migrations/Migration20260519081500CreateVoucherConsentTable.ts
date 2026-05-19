import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260519081500CreateVoucherConsentTable extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS voucher_consent (
        id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token_jti                  TEXT NOT NULL,
        recipient_id               TEXT NULL,
        consent_rodo               BOOLEAN NOT NULL,
        consent_service_execution  BOOLEAN NOT NULL,
        consent_marketing          BOOLEAN NOT NULL DEFAULT false,
        guardian_email             TEXT NULL,
        guardian_is_parent         BOOLEAN NULL,
        status                     TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'approved_by_guardian', 'rejected')),
        ip_address                 INET NULL,
        user_agent                 TEXT NULL,
        payload_hash               TEXT NOT NULL,
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS voucher_consent_token_jti_uidx
        ON voucher_consent (token_jti)
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_consent_recipient_created_idx
        ON voucher_consent (recipient_id, created_at DESC)
        WHERE recipient_id IS NOT NULL
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS voucher_consent_recipient_created_idx`)
    this.addSql(`DROP INDEX IF EXISTS voucher_consent_token_jti_uidx`)
    this.addSql(`DROP TABLE IF EXISTS voucher_consent`)
  }
}
