/**
 * STORY-MIG-A T3.4 — Roundtrip up → down → up integration test.
 *
 * Strategy:
 *   The Mercur fork's Mikro-ORM migrations are normally executed against a live
 *   Postgres via `yarn medusa migrations run`. This unit test exercises the
 *   migration class structure and SQL contract WITHOUT requiring a live DB by
 *   recording every `addSql()` call into a buffer and asserting the emitted
 *   SQL graph. Roundtrip semantics (column present after up, absent after down,
 *   present again after second up) are verified at the SQL contract level —
 *   the live-DB roundtrip is the gate enforced in AC #7 (staging script
 *   `scripts/migration-roundtrip-staging.sh`).
 *
 * Refs: AC #5, AC #6, AC #7, R3-AI-06 named-test row #1.
 * Fixture: src/__tests__/fixtures/migrations/market-runtime-config-pre-locales.sql
 */

import {
  Migration20260427120000AddLocalesToMarketRuntimeConfig,
  LOCALES_BACKFILL_SEED,
} from "../../migrations/Migration20260427120000AddLocalesToMarketRuntimeConfig";

type RecordedSql = { sql: string; params: unknown[] };

class RecordingMigration extends Migration20260427120000AddLocalesToMarketRuntimeConfig {
  public recorded: RecordedSql[] = [];

  // Override Mikro-ORM's protected `addSql` to capture the emitted SQL graph
  // instead of buffering it for a live driver. The cast to `any` is scoped to
  // the test harness only — the production class is unmodified.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override addSql(sql: string, params: unknown[] = []): any {
    this.recorded.push({ sql, params });
  }

  reset() {
    this.recorded = [];
  }
}

describe("Migration20260427120000AddLocalesToMarketRuntimeConfig — roundtrip", () => {
  let migration: RecordingMigration;

  beforeEach(() => {
    migration = new RecordingMigration();
  });

  it("up() emits ADD COLUMN locales jsonb (nullable, idempotent)", async () => {
    await migration.up();

    const addColumn = migration.recorded.find((r) =>
      /ALTER TABLE.*ADD COLUMN.*locales.*jsonb/i.test(r.sql)
    );
    expect(addColumn).toBeDefined();
    expect(addColumn?.sql).toMatch(/IF NOT EXISTS/i);
    expect(addColumn?.sql.toLowerCase()).toContain("null");
  });

  it("up() emits one backfill UPDATE per market in the seed map", async () => {
    await migration.up();

    const updates = migration.recorded.filter((r) =>
      /UPDATE.*market_runtime_config.*SET.*locales/i.test(r.sql)
    );
    const expectedMarkets = Object.keys(LOCALES_BACKFILL_SEED);

    expect(updates.length).toBe(expectedMarkets.length);
    const observedMarkets = updates.map((u) => u.params[1]).sort();
    expect(observedMarkets).toEqual([...expectedMarkets].sort());
  });

  it("up() backfill is idempotent — every UPDATE is gated by `locales IS NULL`", async () => {
    await migration.up();
    const updates = migration.recorded.filter((r) =>
      /UPDATE.*market_runtime_config/i.test(r.sql)
    );
    for (const u of updates) {
      // Match `locales IS NULL` allowing for SQL identifier quoting around `locales`.
      expect(u.sql).toMatch(/locales"?\s+IS\s+NULL/i);
    }
  });

  it("up() seeds D-55-enum-valid locale tags only", async () => {
    const ALLOWED = new Set(["pl", "en", "ua", "de"]);
    for (const [, locales] of Object.entries(LOCALES_BACKFILL_SEED)) {
      expect(ALLOWED.has(locales.default)).toBe(true);
      for (const tag of locales.supported) {
        expect(ALLOWED.has(tag)).toBe(true);
      }
      expect(locales.supported).toContain(locales.default);
    }
  });

  it("down() emits explicit DROP COLUMN locales (no // TODO placeholder)", async () => {
    await migration.down();

    const dropColumn = migration.recorded.find((r) =>
      /ALTER TABLE.*DROP COLUMN.*locales/i.test(r.sql)
    );
    expect(dropColumn).toBeDefined();
    expect(dropColumn?.sql).toMatch(/IF EXISTS/i);
  });

  it("down() does NOT contain TODO/FIXME markers (R3-AI-06 hardening)", async () => {
    await migration.down();
    const allDownSql = migration.recorded.map((r) => r.sql).join("\n");
    expect(allDownSql).not.toMatch(/TODO|FIXME/i);
  });

  it("up → down → up roundtrip emits ADD on the second up (column reappears)", async () => {
    await migration.up();
    const firstUpAddCount = migration.recorded.filter((r) =>
      /ADD COLUMN.*locales/i.test(r.sql)
    ).length;
    expect(firstUpAddCount).toBe(1);

    migration.reset();
    await migration.down();
    const dropCount = migration.recorded.filter((r) =>
      /DROP COLUMN.*locales/i.test(r.sql)
    ).length;
    expect(dropCount).toBe(1);

    migration.reset();
    await migration.up();
    const secondUpAddCount = migration.recorded.filter((r) =>
      /ADD COLUMN.*locales/i.test(r.sql)
    ).length;
    expect(secondUpAddCount).toBe(1);
  });
});
