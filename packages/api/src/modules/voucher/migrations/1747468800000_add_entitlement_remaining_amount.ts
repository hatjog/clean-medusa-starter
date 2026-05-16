import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story 2.7 BE-6: add remaining_amount to entitlement_instance.
 *
 * @see architecture.md D-V180-ARCH-6 (ADR-099 4-layer) — BE-6 no-show partial fee.
 *
 * Apply path: local docker-compose available → `npx medusa db:migrate`
 * If infra unavailable → AUTHORED-not-applied per Story 2.1 T4 posture.
 * Composability: idempotent ADD COLUMN IF NOT EXISTS — safe even if Story 2.4
 * runs concurrently; Story 2.17 reconciles the full model.
 */
export class Migration1747468800000AddEntitlementRemainingAmount extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE entitlement_instance
        ADD COLUMN IF NOT EXISTS remaining_amount integer NULL
          CHECK (remaining_amount IS NULL OR remaining_amount >= 0)
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE entitlement_instance
        DROP COLUMN IF EXISTS remaining_amount
    `)
  }
}
