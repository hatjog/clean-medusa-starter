import type { MedusaContainer } from "@medusajs/framework/types";
import { validateShardChain, type AuditRow } from "../lib/audit-hash-chain";

/**
 * audit-hash-chain-validate — D-67 + ADR-078 daily validation job.
 *
 * Walks every (market_id, hour_bucket) shard of the audit tables, recomputes
 * the chain via `validateShardChain`, emits PostHog events, and raises Sentry
 * alerts on chain breakage or silence (>24h since last successful run).
 *
 * Sentry/PostHog wiring:
 *   - `audit.hash_chain.validation.pass` per shard (PostHog) + breadcrumb (Sentry).
 *   - `audit.hash_chain.validation.fail` per shard (PostHog) + capture HIGH (Sentry).
 *   - Cron heartbeat — Sentry monitors absence (alert if no `pass` event >24h).
 *     The Sentry monitor itself is configured via `gp-ops/runbooks/audit-job-silence-test.md`.
 *
 * Concurrency: Medusa job scheduler invokes this per its single-instance lock
 * (advisory lock). FM-67-8 — double-emit defended by Medusa scheduler primitive.
 *
 * STUB note (TODO(MEDUSA-2-SCHEDULED-JOB)): the exact Medusa 2 scheduled-job
 * registration API may differ in the Mercur fork. The export shape mirrors
 * `retention-personalization-stub.ts` (default-export handler + `config` named
 * export) which is the working pattern in this repo as of v1.4.0. Confirm
 * against `medusa-config.ts` job loader at integration-test time.
 *
 * Refs:
 *   - Story 1.1 scope item #6 (daily validation job)
 *   - architecture.md L1438 (`audit.hash_chain.validation.{pass,fail}` event)
 *   - PRD AC-AUDIT-CHAIN-VALIDATION-01, AC-AUDIT-1.1-04 silence detection
 */

export const SCHEDULE_NAME = "audit-hash-chain-validate" as const;
/** Daily 04:00 UTC — between European storefront low-traffic + before reporting. */
export const SCHEDULE_CRON = "0 4 * * *" as const;

/**
 * Audit tables to validate. Story 1.1 lands `voucher_pii_consent_audit` only;
 * future tables (e.g. `seller_status_change_audit` per Story 1.3) are added
 * to this list when their migrations land. The convention validator
 * (`validate_audit_table_convention.py`) ensures schema parity for each.
 */
export const AUDIT_TABLES_TO_VALIDATE = ["voucher_pii_consent_audit"] as const;

interface QueryRunner {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Medusa 2 `__pg_connection__` resolves to a Knex<any> instance which exposes
 * `.raw(sql, bindings)` — NOT `.query()`. Knex's binding parser only accepts
 * `?` (positional) or `:name` (named) placeholders; PostgreSQL native `$N` are
 * treated as literal text and trigger "Expected N bindings, saw 0".
 *
 * Mirrors the `resolveQueryRunner` pattern in `canary-baseline-rolling.ts`
 * (added by 7563432 fix(jobs): adapt canary baseline to knex connection).
 * Confirmed root cause in SB-4 fix (f78b59d) where the same `$N`→`?` rewrite
 * unblocked 6 API routes.
 *
 * SB-2 (v1.9.1 Wave G1) — scheduled job was crashing every tick because this
 * adapter was missing here and `query.query()` is not a function on a Knex
 * instance.
 */
interface KnexRawRunner {
  raw(
    sql: string,
    bindings?: unknown[]
  ): Promise<{ rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>;
}

interface PosthogClient {
  capture(args: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
}

interface SentryClient {
  addBreadcrumb(crumb: { category: string; message: string; level?: string; data?: unknown }): void;
  captureMessage(message: string, level?: "fatal" | "error" | "warning" | "info" | "debug"): void;
  setTag(key: string, value: string): void;
}

interface JobLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
}

function _resolveLogger(container: MedusaContainer | undefined): JobLogger {
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
    // resolve may throw in test mocks — fall through to console.
  }
  return fallback;
}

function _resolveOptional<T>(container: MedusaContainer | undefined, key: string): T | null {
  try {
    return (container?.resolve?.(key) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

const _isQueryRunner = (value: unknown): value is QueryRunner =>
  Boolean(value && typeof (value as QueryRunner).query === "function");

const _isKnexRawRunner = (value: unknown): value is KnexRawRunner =>
  Boolean(value && typeof (value as KnexRawRunner).raw === "function");

const _toKnexRawSql = (
  sql: string,
  params: unknown[] = []
): { sql: string; bindings: unknown[] } => {
  const bindings: unknown[] = [];
  const rewrittenSql = sql.replace(/\$(\d+)/g, (_match, index: string) => {
    const paramIndex = Number(index) - 1;
    bindings.push(params[paramIndex]);
    return "?";
  });

  return {
    sql: rewrittenSql,
    bindings: bindings.length > 0 ? bindings : params,
  };
};

const _normalizeRawRows = (
  result: Awaited<ReturnType<KnexRawRunner["raw"]>>
): Array<Record<string, unknown>> => {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.rows)) return result.rows;
  return [];
};

/**
 * Resolve a query runner from the Medusa container. Handles both the legacy
 * `.query(sql, params)` shape and the Medusa 2 Knex `__pg_connection__`
 * `.raw(sql, bindings)` shape (rewriting `$N` → `?`).
 *
 * Exported for unit-test parity with `canary-baseline-rolling#resolveQueryRunner`.
 */
export const resolveQueryRunner = (
  container: MedusaContainer | undefined
): QueryRunner | null => {
  const connection = _resolveOptional<unknown>(container, "__pg_connection__");

  if (_isQueryRunner(connection)) return connection;
  if (_isKnexRawRunner(connection)) {
    return {
      query: async (sql: string, params?: unknown[]) => {
        const raw = _toKnexRawSql(sql, params ?? []);
        const result = await connection.raw(raw.sql, raw.bindings);
        return { rows: _normalizeRawRows(result) };
      },
    };
  }

  return null;
};

interface ShardResult {
  table: string;
  marketId: string;
  hourBucket: string;
  rowsValidated: number;
  outcome: "pass" | "fail";
  breakageRowId?: string;
}

async function _listShards(
  query: QueryRunner,
  table: string
): Promise<Array<{ marketId: string; hourBucket: string }>> {
  // Hard-cap statement timeout per FM-67-6 (large shard query timeouts).
  await query.query("SET LOCAL statement_timeout = '60s'");
  const result = await query.query(
    `SELECT DISTINCT market_id, hour_bucket FROM ${table} ORDER BY market_id, hour_bucket`
  );
  return result.rows.map((r) => ({
    marketId: r.market_id as string,
    hourBucket: String(r.hour_bucket),
  }));
}

async function _loadShardRows(
  query: QueryRunner,
  table: string,
  marketId: string,
  hourBucket: string
): Promise<AuditRow[]> {
  const result = await query.query(
    `SELECT id, prev_row_hash, current_row_hash, payload
     FROM ${table}
     WHERE market_id = $1 AND hour_bucket = $2
     ORDER BY created_at ASC, id ASC`,
    [marketId, hourBucket]
  );
  return result.rows.map((r) => ({
    id: r.id as string,
    prev_row_hash: r.prev_row_hash as Buffer | null,
    current_row_hash: r.current_row_hash as Buffer,
    payload: r.payload,
  }));
}

async function _validateTable(
  table: string,
  query: QueryRunner,
  posthog: PosthogClient | null,
  sentry: SentryClient | null,
  logger: JobLogger
): Promise<{ shardsScanned: number; failures: ShardResult[] }> {
  const shards = await _listShards(query, table);
  const failures: ShardResult[] = [];

  for (const shard of shards) {
    const rows = await _loadShardRows(query, table, shard.marketId, shard.hourBucket);
    const breakage = validateShardChain(rows);

    const outcome: ShardResult["outcome"] = breakage === null ? "pass" : "fail";
    const eventName = `audit.hash_chain.validation.${outcome}`;
    const distinctId = `audit-job:${shard.marketId}`;
    const baseProps = {
      shard_market_id: shard.marketId,
      shard_hour_bucket: shard.hourBucket,
      table_name: table,
      rows_validated: rows.length,
    };

    if (breakage === null) {
      sentry?.addBreadcrumb({
        category: "audit.chain",
        level: "info",
        message: `${table} shard ${shard.marketId}/${shard.hourBucket} OK (${rows.length} rows)`,
      });
      posthog?.capture({ distinctId, event: eventName, properties: baseProps });
    } else {
      const props = { ...baseProps, breakage_row_id: breakage.rowId, breakage_index: breakage.index };
      sentry?.setTag("audit.severity", "high");
      sentry?.captureMessage(
        `audit_immutable_violation: chain breakage in ${table} ` +
          `shard=${shard.marketId}/${shard.hourBucket} row=${breakage.rowId} idx=${breakage.index}`,
        "error"
      );
      posthog?.capture({ distinctId, event: eventName, properties: props });
      failures.push({
        table,
        marketId: shard.marketId,
        hourBucket: shard.hourBucket,
        rowsValidated: rows.length,
        outcome,
        breakageRowId: breakage.rowId,
      });
      logger.error(
        `chain breakage in ${table}: shard=${shard.marketId}/${shard.hourBucket} ` +
          `row=${breakage.rowId} idx=${breakage.index}`
      );
    }
  }

  return { shardsScanned: shards.length, failures };
}

export default async function auditHashChainValidate(
  container: MedusaContainer
): Promise<void> {
  const logger = _resolveLogger(container);
  // SB-2 fix (v1.9.1 Wave G1): `__pg_connection__` in Medusa 2 resolves to a
  // Knex<any> instance which exposes `.raw()`, NOT `.query()`. `resolveQueryRunner`
  // adapts both shapes and rewrites PG-native `$N` placeholders → Knex `?`.
  // Without this adapter the scheduled job crashed every tick with
  // `query.query is not a function` (see SB-4 root-cause analysis in f78b59d).
  // PostHog + Sentry keys may differ per loader registration — fall back to
  // no-op if missing so the job stays test-runnable.
  const query = resolveQueryRunner(container);
  const posthog = _resolveOptional<PosthogClient>(container, "posthog");
  const sentry = _resolveOptional<SentryClient>(container, "sentry");

  if (!query) {
    logger.warn(
      "no DB connection resolved — skipping (TODO(MEDUSA-2-SCHEDULED-JOB) wire DB)"
    );
    return;
  }

  let totalShards = 0;
  const allFailures: ShardResult[] = [];
  for (const table of AUDIT_TABLES_TO_VALIDATE) {
    try {
      const { shardsScanned, failures } = await _validateTable(
        table,
        query,
        posthog,
        sentry,
        logger
      );
      totalShards += shardsScanned;
      allFailures.push(...failures);
    } catch (err) {
      // Fail-loud per project Sentry policy ([M1]). Re-emit and continue with
      // next table so one table's failure does not silence the others.
      logger.error(`error scanning ${table}`, err);
      sentry?.captureMessage(
        `audit-hash-chain-validate: error scanning ${table}: ${(err as Error)?.message}`,
        "error"
      );
    }
  }

  const summary =
    `${SCHEDULE_NAME} done: tables=${AUDIT_TABLES_TO_VALIDATE.length} ` +
    `shards=${totalShards} failures=${allFailures.length}`;
  logger.info(summary);

  if (allFailures.length > 0) {
    // Throw to signal scheduler-level failure (cron retry semantics) AFTER
    // events + breadcrumbs have been emitted. The throw is observable and
    // does not undo the per-shard PostHog events already sent.
    throw new Error(`${summary}; see Sentry for breakage details`);
  }
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
};
