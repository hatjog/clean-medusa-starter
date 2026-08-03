import { Migration } from "@mikro-orm/migrations"

/**
 * Records the token that binds a delivered message back to the run that sent it.
 *
 * The gp-dev delivery-smoke (AD-15 point 2, story 5.5 AC5) must confirm receipt
 * automatically. Its primary strategy is `rfc822msgid:` on the provider message
 * ID, but that ID is not always returned — the 2026-08-01 purchase produced two
 * `sent` rows with `provider_message_id IS NULL`. The documented fallback is a
 * full-text mailbox query on a token tied to the run, and that fallback was
 * structurally impossible: nothing durable linked a delivered message to its
 * entitlement. `voucher` has no entitlement column, `entitlement_instance` has
 * no voucher column, and `voucher_event` holds only seeded E2E fixtures.
 *
 * The voucher code is already present in the delivered message (it is part of
 * the subject line), so recording it here adds no new exposure surface — it
 * makes an existing fact queryable. Consumers MUST treat it as a bearer-ish
 * secret: evidence tooling records only its SHA-256 and the strategy name,
 * never the value.
 *
 * Nullable on purpose: historical rows predate the column and backfilling them
 * would mean inventing a binding that was never observed.
 */
export class Migration1778938000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE voucher_delivery_dispatch
        ADD COLUMN IF NOT EXISTS correlation_token text
    `)
  }

  override async down(): Promise<void> {
    // Ledger is forward-only: removing operational delivery evidence is unsafe.
  }
}
