/**
 * STORY-MIG-A R3-AI-06 named-test row #4 — rollback after partial backfill.
 *
 * Scenario:
 *   The migration up() crashes mid-backfill (e.g. transient DB error after 3/5
 *   markets are populated). Operator runs down() to rollback the partial state.
 *   Assertion: down() drops the column unconditionally (`IF EXISTS`), regardless
 *   of how many rows were populated by the failed up() — no orphaned partial state
 *   survives.
 *
 * Strategy:
 *   We simulate a partial-backfill state by recording up() SQL, then injecting
 *   a synthetic crash after the K-th UPDATE. We then run down() and assert the
 *   DROP COLUMN SQL is emitted unconditionally — i.e. the rollback path does not
 *   depend on tracking which rows were already backfilled.
 *
 * Refs: R3-AI-06 named-test row #4.
 * Fixture: src/__tests__/fixtures/migrations/market-runtime-config-pre-locales.sql
 */

import {
  Migration20260427120000AddLocalesToMarketRuntimeConfig,
  LOCALES_BACKFILL_SEED,
} from "../../migrations/Migration20260427120000AddLocalesToMarketRuntimeConfig";
} from "../../migrations-legacy-base/Migration20260427120000AddLocalesToMarketRuntimeConfig";

type RecordedSql = { sql: string; params: unknown[] };

class CrashingMigration extends Migration20260427120000AddLocalesToMarketRuntimeConfig {
  public recorded: RecordedSql[] = [];
  public crashAfter = Number.POSITIVE_INFINITY;
  private updateCount = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override addSql(sql: string, params: unknown[] = []): any {
    if (/UPDATE.*market_runtime_config/i.test(sql)) {
      this.updateCount++;
      if (this.updateCount > this.crashAfter) {
        throw new Error(
          `Synthetic crash injected after ${this.crashAfter} backfill UPDATEs`
        );
      }
    }
    this.recorded.push({ sql, params });
  }

  reset() {
    this.recorded = [];
    this.updateCount = 0;
  }
}

describe("Migration20260427120000AddLocalesToMarketRuntimeConfig — rollback after partial backfill", () => {
  it("up() partial state is recoverable via down() (DROP COLUMN unconditional)", async () => {
    const migration = new CrashingMigration();
    const totalMarkets = Object.keys(LOCALES_BACKFILL_SEED).length;
    expect(totalMarkets).toBeGreaterThanOrEqual(5);

    // Simulate crash after 3 of 5 backfills.
    migration.crashAfter = 3;

    let upError: unknown = undefined;
    try {
      await migration.up();
    } catch (err) {
      upError = err;
    }

    expect(upError).toBeDefined();
    expect((upError as Error).message).toMatch(/Synthetic crash/);

    // At this point we have ADD COLUMN + 3 UPDATEs recorded — partial state.
    const updatesBeforeCrash = migration.recorded.filter((r) =>
      /UPDATE.*market_runtime_config/i.test(r.sql)
    ).length;
    expect(updatesBeforeCrash).toBe(3);

    // Run down() — must succeed and emit DROP COLUMN regardless.
    migration.reset();
    migration.crashAfter = Number.POSITIVE_INFINITY;
    await migration.down();

    const dropColumn = migration.recorded.find((r) =>
      /ALTER TABLE.*DROP COLUMN.*locales/i.test(r.sql)
    );
    expect(dropColumn).toBeDefined();
    expect(dropColumn?.sql).toMatch(/IF EXISTS/i);
  });

  it("down() emits no UPDATE / DELETE — pure DDL rollback (no row mutation needed)", async () => {
    const migration = new CrashingMigration();
    await migration.down();

    const rowMutations = migration.recorded.filter((r) =>
      /UPDATE|DELETE/i.test(r.sql)
    );
    expect(rowMutations).toHaveLength(0);
  });

  it("re-running up() after down() succeeds (idempotent recovery path)", async () => {
    const migration = new CrashingMigration();

    // First up() crashes after 2.
    migration.crashAfter = 2;
    await expect(migration.up()).rejects.toThrow(/Synthetic crash/);

    // down() recovers.
    migration.reset();
    migration.crashAfter = Number.POSITIVE_INFINITY;
    await migration.down();

    // Second up() runs to completion.
    migration.reset();
    await migration.up();

    const updates = migration.recorded.filter((r) =>
      /UPDATE.*market_runtime_config/i.test(r.sql)
    );
    expect(updates.length).toBe(Object.keys(LOCALES_BACKFILL_SEED).length);
  });
});
