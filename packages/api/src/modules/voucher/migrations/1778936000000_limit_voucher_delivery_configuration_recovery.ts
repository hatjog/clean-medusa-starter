import { Migration } from "@mikro-orm/migrations"

/**
 * Bounds automatic configuration-failure recovery per mutable dispatch row.
 *
 * The sweep intentionally gives a delivery parked during a global
 * configuration failure one chance to recover without an operator UPDATE.
 * The counter is durable because `error_code` is a retry summary: relying on
 * it alone made the same row eligible again every cron cycle when an upstream
 * layer returned the generic fallback.
 */
export class Migration1778936000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE voucher_delivery_dispatch
        ADD COLUMN IF NOT EXISTS configuration_recovery_count integer NOT NULL DEFAULT 0
          CHECK (configuration_recovery_count >= 0)
    `)
  }

  override async down(): Promise<void> {
    // Ledger is forward-only: removing operational retry evidence is unsafe.
  }
}
