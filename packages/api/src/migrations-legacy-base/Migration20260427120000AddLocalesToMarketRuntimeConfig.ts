import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * STORY-MIG-A — adds the optional `locales` JSONB column to the
 * `market_runtime_config` table per D-61 + D-55 + D-40 (additive minor v1.3 → v1.4).
 *
 * Legacy base-runtime migration surface.
 * This migration augments an existing `market_runtime_config` base table and is
 * kept outside the canonical app migration ledger because some local GP runtimes
 * do not materialize that table in the active `DATABASE_URL`.
 *
 * up():
 *   1. ADD COLUMN `locales jsonb NULL` (nullable during transition; v1.3 consumers
 *      keep working, forward-compat shim `getMarketLocales()` handles absence).
 *   2. Backfill via deterministic seed map keyed by `market_id` (5 v1.4.0 markets:
 *      bonbeauty, bonevent, bongarden, mercur, testmarketb).
 *
 * down():
 *   Explicit `ALTER TABLE market_runtime_config DROP COLUMN locales;` — NO `// TODO`
 *   placeholder (per Amelia post-mortem on Mercur fork v1.3.0 migration TODOs piling up).
 *
 * Refs:
 *   - architecture.md:822 (D-61 — MarketLocaleConfig v1.4.0)
 *   - architecture.md:816 (D-55 — locale enum [pl,en,ua,de])
 *   - architecture.md:801 (D-40 — additive minor schema bump)
 *   - _bmad-output/implementation-artifacts/v140/STORY-MIG-A-market-runtime-config-locales.md
 *
 * Backfill seed map MUST stay in sync with the runtime YAML fixtures under
 * `gp-ops/markets/{market-id}/config/{instance-id}/markets/{market-id}/market.yaml`
 * `locales` block. If you add a new market, append it here AND validate with
 * `python3 _grow/tools/validate_gp_runtime_config.py --root .`.
 */
export const LOCALES_BACKFILL_SEED: Record<
  string,
  { default: string; supported: string[]; fallback_chain?: string[] }
> = {
  bonbeauty: { default: "pl", supported: ["pl", "en"], fallback_chain: ["pl", "en"] },
  bonevent: { default: "pl", supported: ["pl"], fallback_chain: ["pl"] },
  bongarden: { default: "pl", supported: ["pl", "en"], fallback_chain: ["pl", "en"] },
  mercur: { default: "en", supported: ["en"], fallback_chain: ["en"] },
  testmarketb: { default: "en", supported: ["en"], fallback_chain: ["en"] },
};

export class Migration20260427120000AddLocalesToMarketRuntimeConfig extends Migration {
  async up(): Promise<void> {
    // 1. Add nullable JSONB column (transition-safe).
    this.addSql(
      'ALTER TABLE "market_runtime_config" ADD COLUMN IF NOT EXISTS "locales" jsonb NULL;'
    );

    // 2. Deterministic backfill per market_id. UPDATE … WHERE locales IS NULL keeps
    //    the migration idempotent if up() is replayed after partial completion (R3-AI-06
    //    rollback-partial scenario).
    for (const [marketId, locales] of Object.entries(LOCALES_BACKFILL_SEED)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(this.addSql as any)(
        `UPDATE "market_runtime_config" SET "locales" = ?::jsonb WHERE "market_id" = ? AND "locales" IS NULL;`,
        [JSON.stringify(locales), marketId]
      );
    }
  }

  async down(): Promise<void> {
    // EXPLICIT — no // TODO. Drop column; verified by integration test
    // `locales-roundtrip.test.ts` asserting column absence post-rollback.
    this.addSql(
      'ALTER TABLE "market_runtime_config" DROP COLUMN IF EXISTS "locales";'
    );
  }
}