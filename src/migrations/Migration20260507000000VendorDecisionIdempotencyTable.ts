import { Migration } from "@mikro-orm/migrations"

/**
 * Story v160-cleanup-36 — super-repo migration wrapper.
 *
 * Review fix M3: previously delegated to a BaseMigration instance whose
 * `addSql` queue was unreachable from this wrapper. Now inlines the same
 * CREATE TABLE + indexes, gated by `to_regclass` so re-running on a DB that
 * already has the table is a clean no-op (the BaseMigration in
 * `packages/api/src/migrations/` may have created it first).
 */
export class Migration20260507000000VendorDecisionIdempotencyTable extends Migration {
  async up(): Promise<void> {
    const result = (await this.execute(
      "select to_regclass('public.vendor_decision_idempotency') as regclass",
    )) as Array<{ regclass?: string | null }> | { rows?: Array<{ regclass?: string | null }> }

    const row = Array.isArray(result) ? result[0] : result?.rows?.[0]
    if (row?.regclass) {
      return
    }

    this.addSql(
      `CREATE TABLE IF NOT EXISTS vendor_decision_idempotency (
        id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        idempotency_key text NOT NULL,
        vendor_id text NOT NULL,
        request_hash text NOT NULL,
        status_code integer NOT NULL,
        response_body jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT vendor_decision_idempotency_key_len_chk CHECK (char_length(idempotency_key) <= 255)
      )`,
    )

    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_decision_idempotency_key
       ON vendor_decision_idempotency (idempotency_key)`,
    )

    this.addSql(
      `CREATE INDEX IF NOT EXISTS idx_vendor_decision_idempotency_vendor
       ON vendor_decision_idempotency (vendor_id, created_at DESC)`,
    )
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS vendor_decision_idempotency`)
  }
}
