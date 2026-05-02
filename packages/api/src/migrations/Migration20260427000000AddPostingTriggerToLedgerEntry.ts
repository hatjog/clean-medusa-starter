import { Migration } from "@mikro-orm/migrations";

/**
 * STORY-MIG-C — D-47 ledger_entry.posting_trigger column + backfill.
 *
 * v1.4.0 scope (this migration):
 *   - C1: ALTER TABLE ledger_entry ADD COLUMN posting_trigger text NULL.
 *         No NOT NULL, no DEFAULT, no CHECK, no index.
 *   - C2: Batched UPDATE backfill — set posting_trigger = 'legacy-pre-v1.4.0'
 *         WHERE posting_trigger IS NULL. LIMIT 10000 per batch, loop until
 *         zero rows updated. Per-batch progress log.
 *
 * v1.5.0+ (DEFERRED — separate story STORY-MIG-C3):
 *   - C3: ALTER COLUMN posting_trigger SET NOT NULL.
 *
 * Design notes:
 *   - Column added unconditionally (no IF NOT EXISTS) so a re-run aborts
 *     loudly — Mikro-ORM tracks migration ledger; idempotency is a CI lint
 *     concern, not a runtime concern.
 *   - Backfill uses a CTE-bound UPDATE with LIMIT 10000 to avoid long-held
 *     row locks and replication lag spikes (R3-AI-06, AC #5/#6).
 *   - The WHERE posting_trigger IS NULL filter is naturally race-safe
 *     against concurrent v1.4.0 writers, which always supply a non-NULL
 *     domain trigger value (AC #7) — concurrent INSERTs never enter the
 *     backfill set (concurrent-write test in
 *     src/__tests__/migrations/ledger-posting-trigger-concurrent-write.test.ts).
 *   - down() drops the column unconditionally — partial-backfill state has
 *     no semantic meaning post-drop (Amelia post-mortem; AC #3).
 *
 * Application-code contract (NOT enforced here):
 *   v1.4.0 ledger writers MUST set posting_trigger to a domain value:
 *   'order_placed' | 'refund' | 'manual_adjustment' | 'sync_repair' | ...
 *   (see src/lib/ledger/posting-trigger.ts for the LEGACY_SENTINEL +
 *   accepted-domain-values catalog used by ledger-writers-no-null-trigger
 *   integration test). NULL writes are a code defect — covered by
 *   integration test, NOT by DB constraint in v1.4.0.
 *
 * Refs: D-47, STORY-MIG-C, _bmad-output/implementation-artifacts/v140/
 *       STORY-MIG-C-ledger-posting-trigger.md
 */
export class Migration20260427000000AddPostingTriggerToLedgerEntry extends Migration {
  /** Sentinel value written by C2 backfill — historical rows only. */
  static readonly LEGACY_SENTINEL = "legacy-pre-v1.4.0";

  /** Batch size — conservative; lower if staging shows >2s wall time per batch. */
  static readonly BACKFILL_BATCH_SIZE = 10_000;

  async up(): Promise<void> {
    // C1 — add nullable column. No NOT NULL, no DEFAULT, no CHECK, no index.
    this.addSql("ALTER TABLE ledger_entry ADD COLUMN posting_trigger text NULL");

    // C2 — batched backfill. Loop runs against the live DB, NOT inside the
    // migration transaction — Mikro-ORM addSql queues DDL; the loop below
    // executes UPDATEs via this.execute() so each batch commits independently
    // (avoids one mega-transaction holding row locks for the whole table).
    let totalUpdated = 0;
    let batchNumber = 0;
    // Loop guarded by terminating condition (rows === 0).
    // Hard-cap loop iterations as a safety net (10M rows / 10k = 1000 batches).
    const MAX_BATCHES = 10_000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      batchNumber++;
      if (batchNumber > MAX_BATCHES) {
        throw new Error(
          `[Migration20260427000000AddPostingTriggerToLedgerEntry] ` +
            `Batch loop exceeded MAX_BATCHES=${MAX_BATCHES}; ` +
            `aborting to prevent infinite loop. totalUpdated=${totalUpdated}`
        );
      }

      const result = (await this.execute(
        `WITH cte AS (
           SELECT id FROM ledger_entry
           WHERE posting_trigger IS NULL
           LIMIT ${Migration20260427000000AddPostingTriggerToLedgerEntry.BACKFILL_BATCH_SIZE}
         )
         UPDATE ledger_entry
         SET posting_trigger = '${Migration20260427000000AddPostingTriggerToLedgerEntry.LEGACY_SENTINEL}'
         FROM cte
         WHERE ledger_entry.id = cte.id
         RETURNING ledger_entry.id`
      )) as unknown;

      // Mikro-ORM execute() returns either an array (pg driver) or
      // { rows: [...] } (depending on driver). Normalize.
      const rows = Array.isArray(result)
        ? result.length
        : (result as { rows?: unknown[] })?.rows?.length ?? 0;

      totalUpdated += rows;

      // eslint-disable-next-line no-console
      console.log(
        `[Migration20260427000000AddPostingTriggerToLedgerEntry] ` +
          `backfill batch=${batchNumber} rows=${rows} total=${totalUpdated}`
      );

      if (rows === 0) {
        break;
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[Migration20260427000000AddPostingTriggerToLedgerEntry] ` +
        `backfill complete. total_rows_updated=${totalUpdated} batches=${batchNumber - 1}`
    );
  }

  async down(): Promise<void> {
    // EXPLICIT — drop column. Reverting backfill to NULL is meaningless
    // post-drop. Per Amelia post-mortem on data-state-coupled rollbacks
    // (AC #3): the only semantically valid rollback is to drop the column.
    // No TODO; this is the intended permanent rollback path.
    this.addSql("ALTER TABLE ledger_entry DROP COLUMN posting_trigger");
  }
}
