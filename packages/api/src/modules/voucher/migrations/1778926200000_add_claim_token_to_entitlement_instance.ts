import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.9.0 Wave F6 — Epic-2 HIGH-04 / CC-2 #4 + CC-2 #1.
 *
 * Adds the `claim_token` column to `entitlement_instance` so the Layer 4
 * voucher module (gp_mercur) can carry the public claim URL token. Previously
 * the column lived only on the deprecated `gp_core.entitlements` table
 * (ADR-052). Without it the `/api/v1/entitlements/by-claim-token/[token]`
 * backend route — required by `apps/web/src/app/claim/[claim_token]/page.tsx`
 * — could only be served via fixtures (GP_TEST_MODE).
 *
 * This migration also adds the optional `revoked_at` timestamp (Epic-2 MED-09
 * — buyer-self revoke of leaked claim URLs) so callers can mark a token
 * unusable without dropping the row.
 *
 * Forward: ADD COLUMN + UNIQUE index. Idempotent.
 * Reverse: drop column + index.
 */
export class Migration1778926200000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        ADD COLUMN IF NOT EXISTS claim_token uuid NULL
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        ADD COLUMN IF NOT EXISTS claim_token_revoked_at timestamptz NULL
    `)
    // Partial UNIQUE: NULL allowed (legacy rows), one row per non-null token.
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        entitlement_instance_claim_token_uniq_idx
        ON entitlement_instance (claim_token)
        WHERE claim_token IS NOT NULL
    `)
  }

  async down(): Promise<void> {
    this.addSql(
      `DROP INDEX IF EXISTS entitlement_instance_claim_token_uniq_idx`
    )
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        DROP COLUMN IF EXISTS claim_token_revoked_at
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        DROP COLUMN IF EXISTS claim_token
    `)
  }
}
