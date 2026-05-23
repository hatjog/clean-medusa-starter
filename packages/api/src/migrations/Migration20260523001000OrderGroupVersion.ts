import { Migration } from "@mikro-orm/migrations";

/**
 * Mercur order-group completion reads `order_group.version` during cart
 * completion. Older local/dev databases can have the split-order group table
 * without that optimistic-lock column, which blocks checkout completion after a
 * successful Stripe PaymentIntent.
 */
export class Migration20260523001000OrderGroupVersion extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE order_group
       ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1`
    );
  }

  async down(): Promise<void> {
    this.addSql(
      `ALTER TABLE order_group
       DROP COLUMN IF EXISTS version`
    );
  }
}
