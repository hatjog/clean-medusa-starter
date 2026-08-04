import { Migration } from "@mikro-orm/migrations"

/**
 * Redaction of `provider_message` removes both carriers of the one fact an
 * operator needs to fix an IP-authorization failure: the IP itself and the
 * authorization link. Redaction is correct and stays — this column adds a
 * STRUCTURED diagnostic channel next to it, carrying an enum rather than data.
 *
 * Measured 2026-08-04: the ledger stored "We have detected you are using an
 * unrecognised IP address <redacted:ip> … in this link:
 * https://app.brevo.<redacted:token>". Diagnosis required querying
 * api.ipify.org from the host and ASSUMING it was the address Brevo saw.
 *
 * No backfill: the kind is derived from the provider response at write time,
 * and reconstructing it for historical rows from already-redacted prose would
 * be a guess recorded as a fact.
 */
export class Migration1778939000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE voucher_delivery_dispatch
        ADD COLUMN IF NOT EXISTS provider_error_kind text NULL
    `)
    this.addSql(`
      ALTER TABLE voucher_delivery_dispatch_audit
        ADD COLUMN IF NOT EXISTS provider_error_kind text NULL
    `)
  }

  override async down(): Promise<void> {
    // Ledger is forward-only: removing diagnostic evidence is not a safe
    // rollback operation (same stance as 1778935000000).
  }
}
