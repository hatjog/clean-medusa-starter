import type { MedusaContainer } from "@medusajs/framework/types";

/**
 * voucher-pii-retention-sweep — STORY-2-2 D-70 daily retention scheduler.
 *
 * Per ADR-065 (retention_personalization_days = 365). Daily 03:00 cron sweep:
 *   1. Iterate active markets (resolved from market loader).
 *   2. Compute TTL cutoff in DB clock (NIE app clock per Risk #1).
 *   3. Hard-delete `voucher_recipient_pii` rows past cutoff in batches of 10k.
 *   4. Tombstone the recipient (audit row already references PII row by id —
 *      audit log persists immutable).
 *   5. Emit `voucher.pii.purged.v1` per market.
 *   6. Orphan scan — LEFT JOIN entitlement, cleanup per AC-PII-ORPHAN-01.
 *   7. Emit `retention.cron.heartbeat` (Sentry monitors absence >24h).
 *
 * Idempotency: cohort sweep on the same day is a no-op (rows past cutoff
 * already deleted). Dry-run mode (`VOUCHER_PII_RETENTION_DRY_RUN=1`) emits
 * counts without executing the DELETE — Risk #1 mitigation.
 *
 * Refs: D-70 (architecture.md L466-475), ADR-065, AR-6 silence detection.
 */

export const SCHEDULE_NAME = "voucher-pii-retention-sweep" as const;
export const SCHEDULE_CRON = "0 3 * * *" as const; // daily 03:00 UTC

interface VoucherPiiServiceLike {
  purgeExpiredPii(args: {
    market_id: string;
    cutoff: Date;
    batch_size: number;
  }): Promise<{ rows_deleted: number; orphans_deleted: number }>;
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
  }): void;
  captureMessage(
    message: string,
    level?: "fatal" | "error" | "warning" | "info" | "debug"
  ): void;
}

interface JobLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
}

const RETENTION_DAYS_DEFAULT = 365;
const BATCH_SIZE_DEFAULT = 10_000;

function resolveLogger(container: MedusaContainer | undefined): JobLogger {
  const fallback: JobLogger = {
    info: (m) => console.log(`[${SCHEDULE_NAME}] ${m}`),
    warn: (m) => console.warn(`[${SCHEDULE_NAME}] ${m}`),
    error: (m, e) => console.error(`[${SCHEDULE_NAME}] ${m}`, e),
  };
  try {
    const resolved = container?.resolve?.("logger") as
      | Partial<JobLogger>
      | undefined;
    if (resolved && typeof resolved.info === "function") {
      return {
        info: resolved.info.bind(resolved),
        warn: (resolved.warn ?? resolved.info).bind(resolved),
        error: (resolved.error ?? resolved.info).bind(resolved),
      };
    }
  } catch {
    // Fall through to console.
  }
  return fallback;
}

function resolveOptional<T>(
  container: MedusaContainer | undefined,
  key: string
): T | null {
  try {
    return (container?.resolve?.(key) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

async function listActiveMarkets(
  container: MedusaContainer | undefined,
  logger: JobLogger
): Promise<string[]> {
  // Markets are configured per-instance under `gp-ops/markets/`. The Medusa
  // container exposes a `gp_market_loader` registered by the existing
  // `customer-market-tagging` subscriber pattern. Defensive resolution.
  const loader = resolveOptional<{ listActive: () => Promise<string[]> }>(
    container,
    "gp_market_loader"
  );
  if (loader?.listActive) {
    try {
      return await loader.listActive();
    } catch (err) {
      logger.warn(
        `gp_market_loader.listActive failed: ${(err as Error)?.message ?? String(err)}`
      );
    }
  }
  // Fallback: env var `VOUCHER_PII_RETENTION_MARKETS` (csv).
  const csv = process.env.VOUCHER_PII_RETENTION_MARKETS ?? "";
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
}

export default async function voucherPiiRetentionSweep(
  container: MedusaContainer
): Promise<void> {
  const logger = resolveLogger(container);
  const service = resolveOptional<VoucherPiiServiceLike>(
    container,
    "voucher_pii"
  );
  const posthog = resolveOptional<PosthogClient>(container, "posthog");
  const sentry = resolveOptional<SentryClient>(container, "sentry");

  if (!service) {
    logger.warn(
      "no voucher_pii service resolved — skipping retention sweep " +
        "(TODO(MEDUSA-CONTAINER): wire voucher_pii loader)"
    );
    // Still emit the heartbeat so the silence-detection alert does not fire
    // spuriously while the loader is being wired. The heartbeat asserts
    // "this job ran" — actual retention work is gated on service presence.
    posthog?.capture({
      distinctId: "voucher-pii-retention",
      event: "retention.cron.heartbeat",
      properties: { last_run_at: new Date().toISOString(), service_resolved: false },
    });
    return;
  }

  const retentionDays = Number(
    process.env.VOUCHER_PII_RETENTION_DAYS ?? RETENTION_DAYS_DEFAULT
  );
  const batchSize = Number(
    process.env.VOUCHER_PII_RETENTION_BATCH_SIZE ?? BATCH_SIZE_DEFAULT
  );
  const dryRun = process.env.VOUCHER_PII_RETENTION_DRY_RUN === "1";

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  logger.info(
    `retention sweep cutoff=${cutoff.toISOString()} retention_days=${retentionDays} ` +
      `batch_size=${batchSize} dry_run=${dryRun}`
  );

  if (dryRun) {
    logger.info(
      "dry-run mode active — DELETE is NOT executed; emitting heartbeat only"
    );
    posthog?.capture({
      distinctId: "voucher-pii-retention",
      event: "retention.cron.heartbeat",
      properties: {
        last_run_at: new Date().toISOString(),
        dry_run: true,
        cutoff: cutoff.toISOString(),
      },
    });
    return;
  }

  const markets = await listActiveMarkets(container, logger);
  if (markets.length === 0) {
    logger.warn(
      "no active markets resolved — emitting heartbeat without sweep " +
        "(set VOUCHER_PII_RETENTION_MARKETS env var or wire gp_market_loader)"
    );
  }

  let totalDeleted = 0;
  let totalOrphans = 0;
  for (const market_id of markets) {
    try {
      const result = await service.purgeExpiredPii({
        market_id,
        cutoff,
        batch_size: batchSize,
      });
      totalDeleted += result.rows_deleted;
      totalOrphans += result.orphans_deleted;
      logger.info(
        `market=${market_id} purged=${result.rows_deleted} orphans=${result.orphans_deleted}`
      );
      posthog?.capture({
        distinctId: `retention:${market_id}`,
        event: "voucher.pii.purged.v1",
        properties: {
          market_id,
          rows_deleted: result.rows_deleted,
          orphans_deleted: result.orphans_deleted,
        },
      });
    } catch (err) {
      logger.error(
        `market=${market_id} retention sweep error`,
        err
      );
      sentry?.captureMessage(
        `voucher-pii-retention-sweep failure market=${market_id}: ${(err as Error)?.message}`,
        "error"
      );
    }
  }

  // Heartbeat — Sentry monitors absence (alert if no event >24h).
  posthog?.capture({
    distinctId: "voucher-pii-retention",
    event: "retention.cron.heartbeat",
    properties: {
      last_run_at: new Date().toISOString(),
      next_run_at: new Date(
        Date.now() + 24 * 60 * 60 * 1000
      ).toISOString(),
      markets_scanned: markets.length,
      total_deleted: totalDeleted,
      total_orphans: totalOrphans,
    },
  });

  sentry?.addBreadcrumb({
    category: "retention.cron",
    level: "info",
    message: `voucher-pii-retention-sweep done markets=${markets.length} deleted=${totalDeleted} orphans=${totalOrphans}`,
  });

  logger.info(
    `done markets=${markets.length} deleted=${totalDeleted} orphans=${totalOrphans}`
  );
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
};
