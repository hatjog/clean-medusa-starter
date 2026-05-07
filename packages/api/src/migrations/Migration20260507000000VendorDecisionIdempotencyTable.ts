import { Migration } from "@mikro-orm/migrations"

/**
 * Story v160-cleanup-36 — vendor decision endpoint idempotency.
 *
 * Creates `vendor_decision_idempotency` table that caches POST
 * /admin/vendors/[id]/decision responses keyed by Idempotency-Key header.
 * Enables:
 *   - Safe client retries (double-click / network blip) — replays cached 200.
 *   - Idempotency-Key reuse detection with different payload — returns 422.
 *   - State-conflict caching — 409 responses persisted for deterministic replay.
 *
 * Design choices (OQ #2 resolution):
 *   - NEW table preferred over extending vendor_notification_log because the
 *     existing table has an append-only immutable trigger (UPDATE/DELETE raise
 *     P0001). Adding nullable idempotency columns would conflict with that
 *     immutability contract and pollute the audit surface with non-audit rows.
 *   - No TTL / retention for v1.6.0 — rows kept indefinitely; cleanup-50+ can
 *     add a retention job.
 *
 * OQ #4 resolution: idempotency_key stored as text (≤ 255 chars); UUIDv4
 * format enforced at the application layer (route handler + client).
 */
export class Migration20260507000000VendorDecisionIdempotencyTable extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `CREATE TABLE vendor_decision_idempotency (
        id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        idempotency_key text NOT NULL,
        vendor_id text NOT NULL,
        request_hash text NOT NULL,
        status_code integer NOT NULL,
        response_body jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`
    )

    this.addSql(
      `CREATE UNIQUE INDEX idx_vendor_decision_idempotency_key
       ON vendor_decision_idempotency (idempotency_key)`
    )

    this.addSql(
      `CREATE INDEX idx_vendor_decision_idempotency_vendor
       ON vendor_decision_idempotency (vendor_id, created_at DESC)`
    )
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS vendor_decision_idempotency`)
  }
}
