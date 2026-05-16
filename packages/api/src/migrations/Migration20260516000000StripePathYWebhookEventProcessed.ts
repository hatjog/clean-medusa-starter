import { Migration } from "@mikro-orm/migrations"

/**
 * Story v180-1.3 / Story 0.18 DDL apply: Stripe Path Y DB dedup.
 *
 * This is the runtime table used by the Medusa-native Stripe subscriber to
 * make webhook replay and multi-replica delivery idempotent.
 */
export class Migration20260516000000StripePathYWebhookEventProcessed extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS webhook_event_processed (
        event_id    text NOT NULL,
        provider    text NOT NULL,
        market_id   text NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        envelope    jsonb NOT NULL,
        PRIMARY KEY (event_id, provider)
      )
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS webhook_event_processed_market_received_idx
        ON webhook_event_processed (market_id, received_at DESC)
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS webhook_event_processed`)
  }
}
