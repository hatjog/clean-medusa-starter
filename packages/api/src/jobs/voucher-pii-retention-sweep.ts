import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "knex";

import { runInSystemMarketContext } from "../lib/system-market-context";
import {
  formatRetentionCarrierLog,
  runRecipientRetentionForMarket,
  type RecipientRetentionResult,
} from "../modules/voucher-pii/recipient-retention-runtime";

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

// (v1.16.0 Story 11.6: VoucherPiiServiceLike usunięty — job nie zależy od klucza voucher_pii.)

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

/**
 * v1.16.0 Story 11.6 — wykonawca per rynek wstrzykiwalny (seam testowy).
 * Produkcyjnie: `runRecipientRetentionForMarket` na `PG_CONNECTION` (rola
 * `medusa_store`, kontekst rynku z ALS). Wcześniej job zależał od klucza
 * `voucher_pii`, którego Medusa 2.13 nie rejestruje (loadery `src/loaders/`
 * nie są odkrywane) — przebieg kończył się `warn` bez sweepu (martwe wiring).
 */
export type RetentionForMarketRunner = (args: {
  market_id: string;
  cutoff: Date;
  batch_size: number;
}) => Promise<RecipientRetentionResult>;

function resolveRunner(
  container: MedusaContainer | undefined,
  logger: JobLogger
): RetentionForMarketRunner | null {
  const injected = resolveOptional<RetentionForMarketRunner>(
    container,
    "voucher_pii_retention_runner"
  );
  if (typeof injected === "function") return injected;
  const db = resolveOptional<Knex>(container, ContainerRegistrationKeys.PG_CONNECTION);
  if (!db) {
    logger.error(
      "GP_RECIPIENT_RETENTION_NO_PG_CONNECTION: PG_CONNECTION not resolved — retention sweep NOT executed"
    );
    return null;
  }
  return (args) => runRecipientRetentionForMarket(db, args);
}

export default async function voucherPiiRetentionSweep(
  container: MedusaContainer
): Promise<RecipientRetentionResult[]> {
  const logger = resolveLogger(container);
  const posthog = resolveOptional<PosthogClient>(container, "posthog");
  const sentry = resolveOptional<SentryClient>(container, "sentry");

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
    return [];
  }

  const runner = resolveRunner(container, logger);
  const markets = await listActiveMarkets(container, logger);
  if (markets.length === 0) {
    logger.warn(
      "GP_RECIPIENT_RETENTION_NO_MARKETS: no active markets resolved — heartbeat without sweep " +
        "(set VOUCHER_PII_RETENTION_MARKETS env var; gp_market_loader is not registered in runtime)"
    );
  }

  const results: RecipientRetentionResult[] = [];
  let failures = 0;
  if (runner && markets.length > 0) {
    await runInSystemMarketContext(
      {
        markets,
        instanceId: process.env.GP_INSTANCE_ID,
        origin: { surface: "job", name: SCHEDULE_NAME },
        logger,
      },
      async (market_id) => {
        try {
          const result = await runner({ market_id, cutoff, batch_size: batchSize });
          results.push(result);
          logger.info(formatRetentionCarrierLog(result));
          posthog?.capture({
            distinctId: `retention:${market_id}`,
            event: "voucher.pii.purged.v1",
            properties: { market_id, carriers: result.carriers },
          });
        } catch (err) {
          failures += 1;
          const code = (err as { error_code?: string })?.error_code ?? (err as Error)?.name;
          logger.error(`market=${market_id} retention sweep error error_code=${code}`, err);
          sentry?.captureMessage(
            `voucher-pii-retention-sweep failure market=${market_id} error_code=${code}`,
            "error"
          );
        }
      }
    );
  }

  posthog?.capture({
    distinctId: "voucher-pii-retention",
    event: "retention.cron.heartbeat",
    properties: {
      last_run_at: new Date().toISOString(),
      next_run_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      markets_scanned: markets.length,
      markets_failed: failures,
      runner_resolved: runner !== null,
    },
  });

  sentry?.addBreadcrumb({
    category: "retention.cron",
    level: "info",
    message: `voucher-pii-retention-sweep done markets=${markets.length} failed=${failures}`,
  });

  logger.info(`done markets=${markets.length} failed=${failures}`);
  return results;
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
};
