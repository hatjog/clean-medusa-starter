import { Migration } from "@mikro-orm/migrations"

/**
 * Story v180-1.7 retry DDL.
 *
 * Story 0.18 / Story 1.3 covered accidental checkout-submit idempotency via
 * `idempotency_uuid`; intentional payment retry needs a separate attempt
 * counter so its Stripe key can be derived from order_id + retry_count.
 */
export class Migration20260517010700PaymentSessionRetryCount extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE IF EXISTS payment_session
        ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS payment_session
        ADD COLUMN IF NOT EXISTS retry_idempotency_key text NULL
    `)
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS payment_session_retry_idempotency_key_idx
        ON payment_session (retry_idempotency_key)
        WHERE retry_idempotency_key IS NOT NULL
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS payment_session_retry_idempotency_key_idx`)
    this.addSql(`
      ALTER TABLE IF EXISTS payment_session
        DROP COLUMN IF EXISTS retry_idempotency_key
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS payment_session
        DROP COLUMN IF EXISTS retry_count
    `)
  }
}
