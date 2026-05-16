import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story v180-1.3 AC10 follow-up: entitlement issuance needs market_id.
 *
 * Fresh databases get the column from the create_entitlement migration; this
 * migration covers databases where that migration was already applied before
 * the live AC10 smoke exposed the missing column.
 */
export class Migration1778925400000AddMarketIdToEntitlementInstance extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        ADD COLUMN IF NOT EXISTS market_id text NULL
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        DROP COLUMN IF EXISTS market_id
    `)
  }
}
