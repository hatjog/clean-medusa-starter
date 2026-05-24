import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * SB-3 (v1.9.1 Wave G1) — canary observability tables migration gap.
 *
 * Phase 5 e2e execution surfaced that the `canary-baseline-rolling` scheduled
 * job (cron `*\/5 * * * *`) crashes every tick because the three tables it
 * reads/writes never had a migration authored. Schemas are reverse-engineered
 * from the job's SQL surface plus the canary instrumentation contract in
 * `lib/instrumentation/posthog-canary.ts`:
 *
 *   - `canary_metric_events`  — append-only source of raw canary samples.
 *     Read by `_listActiveMarkets` and `_computeDistribution` over the
 *     24h-minus-5min window.
 *   - `canary_baseline_rolling` — UPSERT target for the rolling p50/p95/p99
 *     baseline. Composite UNIQUE on (market_id, metric_name,
 *     bucket_5min_start_utc) supports the `ON CONFLICT DO UPDATE` path.
 *   - `canary_deploy_meta` — single-row lookup for `isColdStart()` (D-68
 *     cold-start window flag). Defaults to "cold" when empty so the job
 *     never promotes a cold value to authoritative.
 *
 * The 7 canonical metric names live in
 * `lib/instrumentation/posthog-canary.ts#CANARY_METRIC_NAMES`. We store
 * `metric_name` as TEXT (not an enum) so adding a new metric only requires
 * the ADR amendment per `_grow/patterns/canary-metrics.md` — no migration.
 *
 * Source: phase5-e2e-execution-report.md (SB-3 row);
 *         architecture.md L436-448 (D-68 baseline contract);
 *         canary-baseline-rolling.ts (job SQL surface).
 *
 * Target database: gp_mercur (shared with Medusa core; canary lives alongside
 * the rest of the API tables, NOT in the gp_core schema, because PostHog
 * ingestion is keyed by Mercur market_id and we keep the OBS surface at the
 * top-level DB to avoid cross-schema joins from the rolling job).
 */
export class Migration20260524133524 extends Migration {
  async up(): Promise<void> {
    // --- canary_metric_events ----------------------------------------------
    // Append-only raw events. Indexed for the rolling job's
    //   WHERE market_id = $1 AND metric_name = $2
    //     AND timestamp >= now() - interval '24 hours'
    //     AND timestamp <  now() - interval '5 minutes'
    // scan, and for the `_listActiveMarkets` DISTINCT scan.
    this.addSql(`
      CREATE TABLE IF NOT EXISTS canary_metric_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'skipped', 'suppressed', 'info')),
        metric_name TEXT NOT NULL,
        metric_value DOUBLE PRECISION NOT NULL,
        is_cold_start BOOLEAN NOT NULL DEFAULT false,
        dimensions JSONB DEFAULT '{}',
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_canary_metric_events_market_metric_ts
        ON canary_metric_events (market_id, metric_name, timestamp DESC)
    `);
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_canary_metric_events_timestamp
        ON canary_metric_events (timestamp DESC)
    `);
    // Idempotency guard on the AR-25 request_id (canonical dedup key per
    // posthog-canary.ts L17). Partial — events that never set request_id
    // are filtered out so the IDX stays selective.
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_canary_metric_events_request_id_metric
        ON canary_metric_events (request_id, metric_name)
        WHERE request_id IS NOT NULL
    `);

    // --- canary_baseline_rolling -------------------------------------------
    // UPSERT target. UNIQUE (market_id, metric_name, bucket_5min_start_utc)
    // is the ON CONFLICT key used by `_persistDistribution`.
    this.addSql(`
      CREATE TABLE IF NOT EXISTS canary_baseline_rolling (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        market_id TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        bucket_5min_start_utc TIMESTAMPTZ NOT NULL,
        p50 DOUBLE PRECISION NOT NULL,
        p95 DOUBLE PRECISION NOT NULL,
        p99 DOUBLE PRECISION NOT NULL,
        sample_n INTEGER NOT NULL CHECK (sample_n >= 0),
        is_cold_start BOOLEAN NOT NULL DEFAULT true,
        computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_canary_baseline_rolling_market_metric_bucket
          UNIQUE (market_id, metric_name, bucket_5min_start_utc)
      )
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_canary_baseline_rolling_bucket
        ON canary_baseline_rolling (bucket_5min_start_utc DESC)
    `);
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_canary_baseline_rolling_market_metric
        ON canary_baseline_rolling (market_id, metric_name, bucket_5min_start_utc DESC)
    `);

    // --- canary_deploy_meta ------------------------------------------------
    // Tracks deploy boundaries for the D-68 cold-start window.
    // `isColdStart()` does `SELECT ... ORDER BY deployed_at DESC LIMIT 1`,
    // so we leave it un-truncated (history is useful for forensic replay).
    this.addSql(`
      CREATE TABLE IF NOT EXISTS canary_deploy_meta (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        release_version TEXT,
        git_sha TEXT,
        deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        notes TEXT
      )
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_canary_deploy_meta_deployed_at
        ON canary_deploy_meta (deployed_at DESC)
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS idx_canary_deploy_meta_deployed_at`);
    this.addSql(`DROP TABLE IF EXISTS canary_deploy_meta`);

    this.addSql(`DROP INDEX IF EXISTS idx_canary_baseline_rolling_market_metric`);
    this.addSql(`DROP INDEX IF EXISTS idx_canary_baseline_rolling_bucket`);
    this.addSql(`DROP TABLE IF EXISTS canary_baseline_rolling`);

    this.addSql(`DROP INDEX IF EXISTS uq_canary_metric_events_request_id_metric`);
    this.addSql(`DROP INDEX IF EXISTS idx_canary_metric_events_timestamp`);
    this.addSql(`DROP INDEX IF EXISTS idx_canary_metric_events_market_metric_ts`);
    this.addSql(`DROP TABLE IF EXISTS canary_metric_events`);
  }
}
