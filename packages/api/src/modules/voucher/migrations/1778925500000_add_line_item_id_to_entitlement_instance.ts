import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.9.0 Wave F5 — Add `line_item_id` to `entitlement_instance` (closes Epic-1
 * HIGH H-6 multi-product cart issue).
 *
 * Source: `_bmad-output/releases/v1.9.0/planning-artifacts/findings/
 * epic-1-cross-review-findings.md#H-6` + `cc-1-stripe-coherence-findings.md`
 * cross-cutting CCP-5 refund pathway gap analysis.
 *
 * Why:
 *   Pre-v1.9.0 `issueEntitlementWithinPaymentTransaction` collapsed all order
 *   line items into a SINGLE `entitlement_instance` row per order (via
 *   `SELECT id ... LIMIT 1` idempotency guard + `ORDER BY ... LIMIT 1` profile
 *   resolver). Multi-product carts that contain N voucher SKUs paid for N
 *   vouchers but the customer received only ONE entitlement. Latent silent
 *   data loss for BonBeauty MVP (single profile catalog) — escalates to
 *   customer-visible loss the moment v1.9.0+ activates `voucher-kwotowy-365d`
 *   and `voucher-sezonowy` alongside `voucher-rezerwacja-otwarta`.
 *
 * What:
 *   Adds nullable `line_item_id text` column with a partial UNIQUE constraint
 *   over `(order_id, line_item_id)` so multi-line carts can carry N rows for
 *   one `order_id`. The legacy single-row data (pre-migration) stays valid
 *   with `line_item_id IS NULL` — the storage path treats that row as the
 *   legacy "whole-order" entitlement.
 *
 * Reverse: drops the column + constraint.
 *
 * Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX/CONSTRAINT IF NOT EXISTS.
 */
export class Migration1778925500000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE entitlement_instance
        ADD COLUMN IF NOT EXISTS line_item_id text NULL
    `)
    // Partial UNIQUE: enforces one-row-per-(order, line). NULL line_item_id is
    // allowed once per order (legacy / single-row carts pre-migration).
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        entitlement_instance_order_line_uniq_idx
        ON entitlement_instance (order_id, line_item_id)
        WHERE order_id IS NOT NULL AND line_item_id IS NOT NULL
    `)
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        entitlement_instance_order_legacy_uniq_idx
        ON entitlement_instance (order_id)
        WHERE order_id IS NOT NULL AND line_item_id IS NULL
    `)
    // Lookup index used by `revokeEntitlementsOnRefund` (refund handler scans
    // all entitlement rows for an order).
    this.addSql(`
      CREATE INDEX IF NOT EXISTS entitlement_instance_order_state_idx
        ON entitlement_instance (order_id, state)
        WHERE order_id IS NOT NULL
    `)
  }

  async down(): Promise<void> {
    this.addSql(
      `DROP INDEX IF EXISTS entitlement_instance_order_line_uniq_idx`
    )
    this.addSql(
      `DROP INDEX IF EXISTS entitlement_instance_order_legacy_uniq_idx`
    )
    this.addSql(
      `DROP INDEX IF EXISTS entitlement_instance_order_state_idx`
    )
    this.addSql(`ALTER TABLE entitlement_instance DROP COLUMN IF EXISTS line_item_id`)
  }
}
