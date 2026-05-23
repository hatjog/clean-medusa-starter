import { Migration } from "@mikro-orm/migrations";

/**
 * Complements the Mercur/Medusa order version schema used during cart
 * completion. Some dev databases have order adjustment/tax child tables from
 * an older split-order schema without `version`; the current ORM filters those
 * child rows by order version while completing paid carts.
 */
export class Migration20260523002000OrderAdjustmentVersion extends Migration {
  async up(): Promise<void> {
    for (const table of [
      "order_shipping_method_adjustment",
      "order_shipping_method_tax_line",
      "order_line_item_tax_line"
    ]) {
      this.addSql(
        `ALTER TABLE ${table}
         ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1`
      );
    }
  }

  async down(): Promise<void> {
    for (const table of [
      "order_shipping_method_adjustment",
      "order_shipping_method_tax_line",
      "order_line_item_tax_line"
    ]) {
      this.addSql(
        `ALTER TABLE ${table}
         DROP COLUMN IF EXISTS version`
      );
    }
  }
}
