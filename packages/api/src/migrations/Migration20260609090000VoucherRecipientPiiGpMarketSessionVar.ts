import { Migration } from "@mikro-orm/migrations";

const POLICY_NAME = "rls_voucher_recipient_pii_market_isolation";
const TABLE_NAME = "voucher_recipient_pii";
const GP_MARKET_SESSION_VAR = "app.gp_market_id";

function createCanonicalPolicySql(): string {
  return `CREATE POLICY ${POLICY_NAME}
       ON ${TABLE_NAME}
       USING (market_id::uuid = current_setting('${GP_MARKET_SESSION_VAR}', true)::uuid)
       WITH CHECK (market_id::uuid = current_setting('${GP_MARKET_SESSION_VAR}', true)::uuid)`;
}

/**
 * Story 1.2 / FR-F3 / AR-10 — canonical market RLS session-var for
 * voucher_recipient_pii.
 *
 * This forward-fix migration replaces any older policy definition with the
 * producer key set by lib/rls-pool-hook.ts: app.gp_market_id.
 */
export class Migration20260609090000VoucherRecipientPiiGpMarketSessionVar extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `DROP POLICY IF EXISTS ${POLICY_NAME} ON ${TABLE_NAME}`
    );
    this.addSql(createCanonicalPolicySql());
  }

  async down(): Promise<void> {
    this.addSql(
      `DROP POLICY IF EXISTS ${POLICY_NAME} ON ${TABLE_NAME}`
    );
    // Forward-fix rollback: do not reintroduce the retired session-var key.
    this.addSql(createCanonicalPolicySql());
  }
}
