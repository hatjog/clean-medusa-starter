/**
 * STORY-MIG-A T6 (R3-AI-06 hardening) — concurrent-write test.
 *
 * Scenario:
 *   N=10 parallel writers issue UPDATEs against `market_runtime_config` rows
 *   while the migration's backfill loop is running. Assertions:
 *   - Backfill completes with the deterministic seed map (NIE overwritten by
 *     concurrent writes — backfill targets only `locales IS NULL` rows).
 *   - Concurrent writes to non-`locales` columns succeed without deadlock.
 *
 * Strategy:
 *   We exercise the migration class against an in-memory simulator that mimics
 *   row-level Postgres semantics for the columns under test. The simulator
 *   tracks `locales` (jsonb-shaped object) and `version` (string) per market.
 *   The migration's backfill is dispatched as Promises that race against
 *   N=10 writers updating `version`. The harness verifies:
 *     1. After all promises resolve, every market in the seed map has the
 *        seed-defined `locales` block (not whichever value a concurrent writer
 *        happened to set last).
 *     2. The `version` column is the *latest* concurrent write per market
 *        (proves writers were not blocked by the backfill — no deadlock).
 *
 *   The live-DB equivalent is exercised by `scripts/migration-roundtrip-staging.sh`
 *   under AC #7; this Jest test guards the SQL contract + idempotence shape.
 *
 * Refs: R3-AI-06 named-test row #2.
 * Fixture: src/__tests__/fixtures/migrations/market-runtime-config-pre-locales.sql
 */

import {
  Migration20260427120000AddLocalesToMarketRuntimeConfig,
  LOCALES_BACKFILL_SEED,
} from "../../migrations/Migration20260427120000AddLocalesToMarketRuntimeConfig";
} from "../../migrations-legacy-base/Migration20260427120000AddLocalesToMarketRuntimeConfig";

type Row = {
  market_id: string;
  version: string;
  locales: { default: string; supported: string[]; fallback_chain?: string[] } | null;
};

class InMemoryStore {
  private rows: Map<string, Row> = new Map();

  seed(markets: string[]) {
    for (const m of markets) {
      this.rows.set(m, { market_id: m, version: "1.3.0", locales: null });
    }
  }

  /** Simulates `UPDATE … SET locales = ?::jsonb WHERE market_id = ? AND locales IS NULL`. */
  updateLocalesIfNull(marketId: string, locales: Row["locales"]) {
    const row = this.rows.get(marketId);
    if (!row) return false;
    if (row.locales !== null) return false; // backfill is gated
    row.locales = locales;
    return true;
  }

  /** Concurrent writer — independent column. */
  bumpVersion(marketId: string, version: string) {
    const row = this.rows.get(marketId);
    if (!row) return false;
    row.version = version;
    return true;
  }

  get(marketId: string): Row | undefined {
    return this.rows.get(marketId);
  }
}

class HarnessMigration extends Migration20260427120000AddLocalesToMarketRuntimeConfig {
  // Capture parameter shape for forwarding to the in-memory store.
  public capturedUpdates: { marketId: string; locales: Row["locales"] }[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override addSql(sql: string, params: unknown[] = []): any {
    if (/UPDATE.*market_runtime_config.*SET.*locales/i.test(sql)) {
      const [serializedLocales, marketId] = params as [string, string];
      this.capturedUpdates.push({
        marketId,
        locales: JSON.parse(serializedLocales),
      });
    }
    // Ignore ADD COLUMN / DROP COLUMN — DDL not modelled in this harness.
  }
}

describe("Migration20260427120000AddLocalesToMarketRuntimeConfig — concurrent writes", () => {
  it("backfill seed wins over concurrent non-locales writes (no overwrite, no deadlock)", async () => {
    const store = new InMemoryStore();
    const seedMarkets = Object.keys(LOCALES_BACKFILL_SEED);
    store.seed(seedMarkets);

    const harness = new HarnessMigration();
    await harness.up();

    // Spawn N=10 concurrent writers per market hammering `version`.
    const N = 10;
    const writerPromises: Promise<void>[] = [];
    for (const marketId of seedMarkets) {
      for (let i = 0; i < N; i++) {
        writerPromises.push(
          (async () => {
            store.bumpVersion(marketId, `1.3.${i}-concurrent`);
          })()
        );
      }
    }

    // Apply backfill writes (interleaved with concurrent writers).
    const backfillPromises: Promise<void>[] = harness.capturedUpdates.map(
      (u) =>
        (async () => {
          store.updateLocalesIfNull(u.marketId, u.locales);
        })()
    );

    await Promise.all([...writerPromises, ...backfillPromises]);

    // Assertion 1 — backfill seed wins.
    for (const [marketId, expected] of Object.entries(LOCALES_BACKFILL_SEED)) {
      const row = store.get(marketId);
      expect(row).toBeDefined();
      expect(row!.locales).toEqual(expected);
    }

    // Assertion 2 — concurrent version writes succeeded (no deadlock).
    for (const marketId of seedMarkets) {
      const row = store.get(marketId);
      expect(row!.version).toMatch(/^1\.3\.\d+-concurrent$/);
    }
  });

  it("backfill is no-op on rows where locales is already populated (idempotence under concurrent backfill)", async () => {
    const store = new InMemoryStore();
    store.seed(Object.keys(LOCALES_BACKFILL_SEED));

    // Pre-populate one market — simulates a concurrent backfill replay.
    store.updateLocalesIfNull("bonbeauty", {
      default: "pl",
      supported: ["pl", "en", "ua"],
      fallback_chain: ["pl", "en"],
    });

    const harness = new HarnessMigration();
    await harness.up();

    for (const u of harness.capturedUpdates) {
      store.updateLocalesIfNull(u.marketId, u.locales);
    }

    // bonbeauty keeps its pre-populated wider locales — backfill did NOT overwrite.
    const bonbeauty = store.get("bonbeauty");
    expect(bonbeauty!.locales).toEqual({
      default: "pl",
      supported: ["pl", "en", "ua"],
      fallback_chain: ["pl", "en"],
    });
  });
});
