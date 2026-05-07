import { Migration } from "@mikro-orm/migrations"

/**
 * Story v160-cleanup-47-lifecycle-status-real-writes — closes TF-108.
 *
 * Adds a first-class `vendor_lifecycle_state` table (OQ #1: Option A —
 * separate table, cleaner rollback, mirrors vendor_notification_log pattern).
 * One mutable row per seller_id (last-write-wins under DB transaction +
 * SELECT FOR UPDATE serialization).
 *
 * Also backfills every existing seller row by seeding a `pending` lifecycle
 * row if `metadata.gp.lifecycle_status` is absent or unrecognised. Valid
 * lifecycle_status values are promoted verbatim.
 *
 * `vendor_notification_log.notification_type` already includes
 * `lifecycle_transition` in the base migration (Migration20260505000000) —
 * no enum extension DDL needed here (OQ #2 resolved: reuse existing log).
 *
 * Append-only trigger on vendor_notification_log is inherited; this table
 * is MUTABLE (single state row, not an audit log) — no trigger added here.
 */
export class Migration20260507200000VendorLifecycleStateTable extends Migration {
  async up(): Promise<void> {
    // 1. Create vendor_lifecycle_state table
    this.addSql(
      `CREATE TABLE vendor_lifecycle_state (
        id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        seller_id text NOT NULL UNIQUE,
        lifecycle_status text NOT NULL DEFAULT 'pending_approval'
          CHECK (lifecycle_status IN ('pending_approval', 'open', 'suspended', 'terminated')),
        decision_state text NOT NULL DEFAULT 'pending'
          CHECK (decision_state IN ('pending', 'opted_in', 'opted_out', 'forced')),
        opt_in_at timestamptz NULL,
        opt_out_at timestamptz NULL,
        last_transition_at timestamptz NOT NULL DEFAULT now(),
        last_transition_by text NOT NULL DEFAULT 'system',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
    )

    this.addSql(
      `CREATE INDEX idx_vendor_lifecycle_state_seller_id
       ON vendor_lifecycle_state (seller_id)`,
    )

    this.addSql(
      `CREATE INDEX idx_vendor_lifecycle_state_lifecycle_status
       ON vendor_lifecycle_state (lifecycle_status)`,
    )

    // 2. Backfill — seed lifecycle rows for all existing seller rows.
    //    Reads metadata.gp.lifecycle_status; defaults to 'pending_approval'.
    //    Idempotent: ON CONFLICT (seller_id) DO NOTHING.
    this.addSql(
      `INSERT INTO vendor_lifecycle_state (seller_id, lifecycle_status, last_transition_by)
       SELECT
         id AS seller_id,
         CASE
           WHEN metadata IS NOT NULL
                AND metadata::jsonb -> 'gp' ->> 'lifecycle_status'
                  IN ('pending_approval', 'open', 'suspended', 'terminated')
             THEN metadata::jsonb -> 'gp' ->> 'lifecycle_status'
           ELSE 'pending_approval'
         END AS lifecycle_status,
         'migration_backfill' AS last_transition_by
       FROM seller
       WHERE deleted_at IS NULL
       ON CONFLICT (seller_id) DO NOTHING`,
    )
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS vendor_lifecycle_state`)
  }
}
