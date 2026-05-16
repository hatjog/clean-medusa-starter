import { Migration } from "@mikro-orm/migrations"

/**
 * Story v180-1.3 / Story 0.18 DDL apply: checkout idempotency UUID.
 *
 * The storefront sends Idempotency-Key for payment-session initiation; backend
 * payment-session wiring stores the UUID + cart hash here before PaymentIntent
 * creation so accidental double-submit can resolve to the existing intent.
 */
export class Migration20260516000100PaymentSessionIdempotencyUuid extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE IF EXISTS payment_session
        ADD COLUMN IF NOT EXISTS idempotency_uuid text NULL
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS payment_session
        ADD COLUMN IF NOT EXISTS idempotency_cart_hash text NULL
    `)
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS payment_session_idempotency_uuid_idx
        ON payment_session (idempotency_uuid)
        WHERE idempotency_uuid IS NOT NULL
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS payment_session_idempotency_uuid_idx`)
    this.addSql(`
      ALTER TABLE IF EXISTS payment_session
        DROP COLUMN IF EXISTS idempotency_cart_hash
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS payment_session
        DROP COLUMN IF EXISTS idempotency_uuid
    `)
  }
}
