import type { MedusaContainer } from "@medusajs/framework/types";
import { CANARY_METRIC_NAMES, type CanaryMetricName } from "../lib/instrumentation/posthog-canary";

/**
 * canary-baseline-rolling — D-68 + AC-CANARY-1.4-02 rolling-window baseline job.
 *
 * Runs every 5min via Medusa job scheduler. Per market × metric, queries the
 * PostHog SQL warehouse for the prior **24h window MINUS the current 5min slice**,
 * computes p50 / p95 / p99, and UPSERTs into the `canary_baseline_rolling` table.
 *
 * Cold-start contract (D-68 + Risk #1):
 *   - First 24h post-deploy → computation runs but persists with
 *     `is_cold_start=true`. The pre-runtime-ON staging+UAT measurement is the
 *     authoritative seed (committed to `specs/releases/v1.5.0/canary-baseline.yaml`).
 *   - After 24h → `is_cold_start=false`; rolling baseline is authoritative.
 *
 * Concurrency: Medusa scheduler enforces single-instance via DB advisory lock
 * (FM-71-6 — double-emit defended).
 *
 * Clock skew (FM-71-2): the 24h-5min window uses PostHog warehouse `now()`
 * NOT app `Date.now()` to avoid app-clock drift breaking the slice exclusion.
 *
 * @see _bmad-output/planning-artifacts/architecture.md L436-448 (D-68)
 * @see _bmad-output/implementation-artifacts/v150/STORY-1-4-CANARY-INSTRUMENTATION.md
 * @see GP/backend/src/jobs/audit-hash-chain-validate.ts (Story 1.1 job pattern)
 */

export const SCHEDULE_NAME = "canary-baseline-rolling" as const;
/** Every 5 minutes — pinned by AC-CANARY-1.4-02 (rolling 24h-5min window). */
export const SCHEDULE_CRON = "*/5 * * * *" as const;

/** Window: 24h trailing minus the current 5min slice (FM-71-2 clock-skew safe). */
export const WINDOW_24H_MINUS_5MIN_SQL =
  "interval '24 hours'" as const;
export const CURRENT_SLICE_EXCLUSION_SQL = "interval '5 minutes'" as const;

/** Cold-start window post-deploy. Read by `is_cold_start` flag. */
export const COLD_START_DURATION_MS = 24 * 60 * 60 * 1000; // 24h

/** Distribution captured per metric per market per 5min bucket. */
export interface BaselineDistribution {
  market_id: string;
  metric_name: CanaryMetricName;
  bucket_5min_start_utc: string; // ISO8601
  p50: number;
  p95: number;
  p99: number;
  sample_n: number;
  is_cold_start: boolean;
}

interface QueryRunner {
  query(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

interface PosthogClient {
  capture(args: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }): void;
}

interface SentryClient {
  addBreadcrumb(crumb: {
    category: string;
    message: string;
    level?: string;
    data?: unknown;
  }): void;
  captureMessage(
    message: string,
    level?: "fatal" | "error" | "warning" | "info" | "debug"
  ): void;
  setTag(key: string, value: string): void;
}

interface JobLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
}

const _resolveLogger = (container: MedusaContainer | undefined): JobLogger => {
  const fallback: JobLogger = {
    info: (m) => console.log(`[${SCHEDULE_NAME}] ${m}`),
    warn: (m) => console.warn(`[${SCHEDULE_NAME}] ${m}`),
    error: (m, e) => console.error(`[${SCHEDULE_NAME}] ${m}`, e),
  };
  try {
    const resolved = container?.resolve?.("logger") as Partial<JobLogger> | undefined;
    if (resolved && typeof resolved.info === "function" && typeof resolved.error === "function") {
      return {
        info: resolved.info.bind(resolved),
        warn: (resolved.warn ?? resolved.info).bind(resolved),
        error: resolved.error.bind(resolved),
      };
    }
  } catch {
    // resolve may throw in mocks — fall through.
  }
  return fallback;
};

const _resolveOptional = <T>(container: MedusaContainer | undefined, key: string): T | null => {
  try {
    return (container?.resolve?.(key) as T | undefined) ?? null;
  } catch {
    return null;
  }
};

/**
 * Compute the 24h-minus-5min window boundaries from the PostHog warehouse
 * `now()` (NOT app clock — FM-71-2 clock-skew safe). Returned in ISO8601 UTC.
 */
export const computeWindow = async (
  query: QueryRunner
): Promise<{ window_start_utc: string; window_end_utc: string; current_slice_start_utc: string }> => {
  const result = await query.query(
    `SELECT
       (now() - interval '24 hours')::timestamptz AS window_start,
       (now() - interval '5 minutes')::timestamptz AS window_end,
       date_trunc('minute', now() - interval '5 minutes')::timestamptz AS current_slice_start`
  );
  const row = result.rows[0] ?? {};
  return {
    window_start_utc: String(row.window_start ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    window_end_utc: String(row.window_end ?? new Date(Date.now() - 5 * 60 * 1000).toISOString()),
    current_slice_start_utc: String(row.current_slice_start ?? new Date().toISOString()),
  };
};

/**
 * Determine whether a metric is in cold-start mode (first 24h post-deploy).
 * Source of truth: `canary_deploy_meta.deployed_at` table column. If the
 * table is unavailable, defaults to `is_cold_start=true` (safe — won't
 * promote a cold value to authoritative).
 */
export const isColdStart = async (query: QueryRunner): Promise<boolean> => {
  try {
    const result = await query.query(
      `SELECT (now() - deployed_at) < interval '24 hours' AS is_cold
       FROM canary_deploy_meta
       ORDER BY deployed_at DESC
       LIMIT 1`
    );
    if (result.rows.length === 0) return true;
    return Boolean(result.rows[0].is_cold);
  } catch {
    return true;
  }
};

/**
 * Compute p50/p95/p99 for a (market, metric) tuple over the 24h-5min window.
 * Returns null if the window has zero events for that tuple.
 */
const _computeDistribution = async (
  query: QueryRunner,
  marketId: string,
  metric: CanaryMetricName
): Promise<{ p50: number; p95: number; p99: number; sample_n: number } | null> => {
  // Hard-cap statement timeout per FM-67-6 large-shard-query pattern.
  await query.query("SET LOCAL statement_timeout = '60s'");
  const result = await query.query(
    `SELECT
       percentile_disc(0.50) WITHIN GROUP (ORDER BY metric_value) AS p50,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY metric_value) AS p95,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY metric_value) AS p99,
       count(*) AS sample_n
     FROM canary_metric_events
     WHERE market_id = $1
       AND metric_name = $2
       AND timestamp >= now() - interval '24 hours'
       AND timestamp < now() - interval '5 minutes'`,
    [marketId, metric]
  );
  const row = result.rows[0];
  if (!row || row.sample_n === null || Number(row.sample_n) === 0) return null;
  return {
    p50: Number(row.p50),
    p95: Number(row.p95),
    p99: Number(row.p99),
    sample_n: Number(row.sample_n),
  };
};

const _persistDistribution = async (
  query: QueryRunner,
  dist: BaselineDistribution
): Promise<void> => {
  await query.query(
    `INSERT INTO canary_baseline_rolling
       (market_id, metric_name, bucket_5min_start_utc, p50, p95, p99, sample_n, is_cold_start, computed_at)
     VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, now())
     ON CONFLICT (market_id, metric_name, bucket_5min_start_utc)
     DO UPDATE SET
       p50 = EXCLUDED.p50,
       p95 = EXCLUDED.p95,
       p99 = EXCLUDED.p99,
       sample_n = EXCLUDED.sample_n,
       is_cold_start = EXCLUDED.is_cold_start,
       computed_at = EXCLUDED.computed_at`,
    [
      dist.market_id,
      dist.metric_name,
      dist.bucket_5min_start_utc,
      dist.p50,
      dist.p95,
      dist.p99,
      dist.sample_n,
      dist.is_cold_start,
    ]
  );
};

/**
 * List markets that have any canary events in the last 24h. Returned as a
 * deduplicated string array, ordered.
 */
const _listActiveMarkets = async (query: QueryRunner): Promise<string[]> => {
  const result = await query.query(
    `SELECT DISTINCT market_id
     FROM canary_metric_events
     WHERE timestamp >= now() - interval '24 hours'
     ORDER BY market_id`
  );
  return result.rows.map((r) => String(r.market_id));
};

export default async function canaryBaselineRolling(
  container: MedusaContainer
): Promise<void> {
  const logger = _resolveLogger(container);
  const query = _resolveOptional<QueryRunner>(container, "__pg_connection__");
  const posthog = _resolveOptional<PosthogClient>(container, "posthog");
  const sentry = _resolveOptional<SentryClient>(container, "sentry");

  if (!query) {
    logger.warn(
      "no DB connection resolved — skipping (TODO(MEDUSA-2-SCHEDULED-JOB) wire DB)"
    );
    return;
  }

  let totalUpserts = 0;
  let totalSkippedEmpty = 0;
  let coldStart = true;
  try {
    coldStart = await isColdStart(query);
    const window = await computeWindow(query);
    const markets = await _listActiveMarkets(query);

    for (const marketId of markets) {
      for (const metric of CANARY_METRIC_NAMES) {
        try {
          const dist = await _computeDistribution(query, marketId, metric);
          if (!dist) {
            totalSkippedEmpty += 1;
            continue;
          }
          await _persistDistribution(query, {
            market_id: marketId,
            metric_name: metric,
            bucket_5min_start_utc: window.current_slice_start_utc,
            p50: dist.p50,
            p95: dist.p95,
            p99: dist.p99,
            sample_n: dist.sample_n,
            is_cold_start: coldStart,
          });
          totalUpserts += 1;
          posthog?.capture({
            distinctId: `canary-job:${marketId}`,
            event: "canary.baseline.rolling.persisted",
            properties: {
              market_id: marketId,
              metric_name: metric,
              p50: dist.p50,
              p95: dist.p95,
              p99: dist.p99,
              sample_n: dist.sample_n,
              is_cold_start: coldStart,
              window_start_utc: window.window_start_utc,
              window_end_utc: window.window_end_utc,
            },
          });
        } catch (err) {
          // Fail-loud per project Sentry policy [M1] — re-emit and continue.
          logger.error(
            `error computing baseline market=${marketId} metric=${metric}`,
            err
          );
          sentry?.setTag("canary.severity", "warning");
          sentry?.captureMessage(
            `canary-baseline-rolling: error market=${marketId} metric=${metric}: ${(err as Error)?.message}`,
            "warning"
          );
        }
      }
    }

    sentry?.addBreadcrumb({
      category: "canary.baseline",
      level: "info",
      message: `${SCHEDULE_NAME} done: markets=${markets.length} upserts=${totalUpserts} empty=${totalSkippedEmpty} cold_start=${coldStart}`,
    });
  } catch (err) {
    logger.error(`fatal error`, err);
    sentry?.setTag("canary.severity", "high");
    sentry?.captureMessage(
      `canary-baseline-rolling: fatal: ${(err as Error)?.message}`,
      "error"
    );
    throw err;
  }

  logger.info(
    `${SCHEDULE_NAME} done: upserts=${totalUpserts} empty=${totalSkippedEmpty} cold_start=${coldStart}`
  );
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
};
