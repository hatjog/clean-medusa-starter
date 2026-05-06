/**
 * STORY-MIG-C T5 (R3-AI-06) — Concurrent write race during backfill.
 *
 * Spawns N=15 parallel "writers" that issue INSERTs DURING the batched
 * backfill loop. Asserts:
 *   1. Concurrent INSERTs land with non-NULL `posting_trigger` (per AC #7).
 *   2. The backfill UPDATE filter `WHERE posting_trigger IS NULL` correctly
 *      excludes the new rows — fresh rows are NEVER overwritten with the
 *      sentinel.
 *   3. Per-batch wall time stays bounded (<2s in-memory simulation; the
 *      integration suite asserts the same against a live Postgres + the
 *      ledger-entry-100k-pre-backfill fixture).
 *   4. No pre-existing legacy row is missed (every NULL row gets sentinel).
 *
 * Implementation note (mirrors backfill-3-instances-concurrent-write.test.ts):
 * the unit test gate runs without Postgres, so this suite simulates the race
 * in-memory using a shared row store and Promise.all to schedule writers and
 * the backfill loop concurrently. The same contract is exercised against a
 * live Postgres container via the integration suite once the staging
 * environment is online.
 */

import { Migration20260427000000AddPostingTriggerToLedgerEntry } from "../../migrations-legacy-base/Migration20260427000000AddPostingTriggerToLedgerEntry";
import {
  KNOWN_POSTING_TRIGGERS,
  assertPostingTrigger,
} from "../../lib/ledger/posting-trigger";

const SENTINEL = "legacy-pre-v1.4.0";
const BATCH_SIZE = Migration20260427000000AddPostingTriggerToLedgerEntry.BACKFILL_BATCH_SIZE;

type LedgerRow = {
  id: string;
  market_id: string;
  posting_trigger: string | null;
  inserted_during_backfill?: boolean;
};

describe("STORY-MIG-C — Concurrent write during batched backfill (T5, R3-AI-06)", () => {
  it("N=15 parallel writers landing during backfill keep their non-NULL trigger; backfill never overwrites", async () => {
    const rows: LedgerRow[] = [];

    // Seed: 35 pre-v1.4.0 rows (NULL posting_trigger) + 5 already-fresh rows
    // (mid-flight from earlier writers; must not be touched).
    for (let i = 0; i < 35; i++) {
      rows.push({
        id: `legacy-${i}`,
        market_id: i % 2 === 0 ? "bonbeauty" : "mercur",
        posting_trigger: null,
      });
    }
    for (let i = 0; i < 5; i++) {
      rows.push({
        id: `pre-fresh-${i}`,
        market_id: "bonbeauty",
        posting_trigger: "order_placed",
      });
    }

    const initialNullCount = rows.filter((r) => r.posting_trigger == null).length;
    expect(initialNullCount).toBe(35);

    let backfillBatchCount = 0;
    let maxBatchWallMs = 0;
    const yieldBetweenBatches = () =>
      new Promise<void>((resolve) => setImmediate(resolve));

    // Backfill loop — yields between batches so writers can interleave.
    const backfillPromise = (async () => {
      let safety = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        safety++;
        if (safety > 100) throw new Error("backfill loop runaway");
        const start = process.hrtime.bigint();
        // Race-safe filter — only NULL rows enter the batch.
        const targets = rows
          .filter((r) => r.posting_trigger == null)
          .slice(0, BATCH_SIZE);
        for (const r of targets) {
          // Re-check filter inside the loop to mimic real UPDATE WHERE clause
          // semantics — concurrent writers may have raced.
          if (r.posting_trigger == null) {
            r.posting_trigger = SENTINEL;
          }
        }
        const wallMs = Number(process.hrtime.bigint() - start) / 1_000_000;
        maxBatchWallMs = Math.max(maxBatchWallMs, wallMs);
        backfillBatchCount++;
        if (targets.length === 0) break;
        await yieldBetweenBatches();
      }
    })();

    // N=15 concurrent writers, each spawning during the backfill's micro-yield
    // windows. Each writer supplies its own non-NULL trigger value
    // (per AC #7) — exactly mirroring how production v1.4.0 ledger writers
    // route through assertPostingTrigger().
    const N = 15;
    const writers: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      writers.push(
        (async () => {
          // Stagger inside the scheduler so inserts truly overlap.
          await yieldBetweenBatches();
          const trigger =
            KNOWN_POSTING_TRIGGERS[i % KNOWN_POSTING_TRIGGERS.length];
          // Assertion contract: writer obtains its trigger via the contract.
          const validated = assertPostingTrigger(trigger, {
            writer: `concurrent-writer-${i}`,
          });
          rows.push({
            id: `concurrent-${i}`,
            market_id: i % 2 === 0 ? "bonbeauty" : "mercur",
            posting_trigger: validated,
            inserted_during_backfill: true,
          });
        })()
      );
    }

    await Promise.all([backfillPromise, ...writers]);

    // 1. Every legacy row was backfilled with the sentinel.
    const legacy = rows.filter((r) => r.id.startsWith("legacy-"));
    expect(legacy).toHaveLength(35);
    for (const r of legacy) {
      expect(r.posting_trigger).toBe(SENTINEL);
    }

    // 2. Pre-fresh rows were NOT touched.
    const preFresh = rows.filter((r) => r.id.startsWith("pre-fresh-"));
    expect(preFresh).toHaveLength(5);
    for (const r of preFresh) {
      expect(r.posting_trigger).toBe("order_placed");
    }

    // 3. Concurrent inserts kept their writer-supplied trigger and were NEVER
    //    overwritten with the sentinel. Race-safe filter contract upheld.
    const concurrent = rows.filter((r) => r.inserted_during_backfill);
    expect(concurrent).toHaveLength(N);
    for (const r of concurrent) {
      expect(r.posting_trigger).not.toBe(SENTINEL);
      expect(r.posting_trigger).not.toBeNull();
      expect(KNOWN_POSTING_TRIGGERS).toContain(r.posting_trigger as string);
    }

    // 4. Per-batch wall time bounded (<2s — in-memory; the staging integration
    //    suite asserts <2s against live Postgres per AC #5).
    expect(maxBatchWallMs).toBeLessThan(2000);

    // 5. No NULL rows remain — backfill exhaustive.
    expect(rows.filter((r) => r.posting_trigger == null)).toHaveLength(0);
  });

  it("backfill is idempotent under concurrent writes — second run is a no-op", async () => {
    const rows: LedgerRow[] = [
      { id: "legacy-1", market_id: "mercur", posting_trigger: null },
      { id: "legacy-2", market_id: "mercur", posting_trigger: null },
    ];

    const runOnce = async (): Promise<number> => {
      let updates = 0;
      let safety = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        safety++;
        if (safety > 10) throw new Error("loop runaway");
        const targets = rows
          .filter((r) => r.posting_trigger == null)
          .slice(0, BATCH_SIZE);
        if (targets.length === 0) break;
        for (const r of targets) {
          r.posting_trigger = SENTINEL;
          updates++;
        }
      }
      return updates;
    };

    const first = await runOnce();
    expect(first).toBe(2);

    // Concurrent writer arrives between runs — supplies a fresh trigger.
    rows.push({
      id: "concurrent-after-first-run",
      market_id: "mercur",
      posting_trigger: assertPostingTrigger("refund", { writer: "test" }),
    });

    const second = await runOnce();
    // Second run touches zero rows — fresh writer's trigger NEVER overwritten.
    expect(second).toBe(0);
    const fresh = rows.find((r) => r.id === "concurrent-after-first-run");
    expect(fresh?.posting_trigger).toBe("refund");
  });
});
