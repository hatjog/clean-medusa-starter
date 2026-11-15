import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "knex";

import { runInSystemMarketContext } from "../lib/system-market-context";
import { SWEEP_GAP_LOOKBACK_MS } from "./voucher-delivery-reconciliation-sweep";
import {
  resolveRetentionMarkets,
  type RetentionMarketsResolution,
} from "../modules/voucher-pii/recipient-retention-markets";
import {
  formatRetentionCarrierLog,
  runRecipientRetentionForMarket,
  type RecipientRetentionResult,
} from "../modules/voucher-pii/recipient-retention-runtime";

/**
 * voucher-pii-retention-sweep — STORY-2-2 D-70 daily retention scheduler.
 *
 * Per ADR-065 (retention_personalization_days = 365). Daily 03:00 cron sweep:
 *   1. Iterate markets from the instance gp-config projection (11.6 fix R-1,
 *      `recipient-retention-markets.ts`); env = explicit narrowing only.
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
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * v1.16.0 Story 11.6 (fix R-4): od 11.6 cutoff steruje redakcją
 * `order_line_item.metadata`, `cart_line_item.metadata` i `notification.data`
 * żywych zamówień, więc termin musi być ostro dłuższy niż horyzont jedynego
 * silnika retry (`SWEEP_GAP_LOOKBACK_MS`, import — nie kopia) z zapasem.
 */
export const RETRY_HORIZON_DAYS = Math.ceil(SWEEP_GAP_LOOKBACK_MS / DAY_MS);
export const RETENTION_DAYS_MARGIN_DAYS = 7;
export const RETENTION_DAYS_MIN = RETRY_HORIZON_DAYS + RETENTION_DAYS_MARGIN_DAYS;
export const RETENTION_TERM_INVALID_ERROR_CODE = "GP_RECIPIENT_RETENTION_TERM_INVALID" as const;

export type RetentionTermValidation =
  | { ok: true; days: number }
  | { ok: false; error_code: typeof RETENTION_TERM_INVALID_ERROR_CODE; reason: "not_integer" | "below_retry_horizon"; raw: string };

export function validateRetentionDays(raw: string | undefined): RetentionTermValidation {
  const text = raw === undefined || raw.trim() === "" ? String(RETENTION_DAYS_DEFAULT) : raw.trim();
  if (!/^\d+$/.test(text)) {
    return { ok: false, error_code: RETENTION_TERM_INVALID_ERROR_CODE, reason: "not_integer", raw: text };
  }
  const days = Number(text);
  if (!Number.isSafeInteger(days) || days < RETENTION_DAYS_MIN) {
    return { ok: false, error_code: RETENTION_TERM_INVALID_ERROR_CODE, reason: "below_retry_horizon", raw: text };
  }
  return { ok: true, days };
}

/** Wynik przebiegu joba — liczniki per rynek i nazwane alarmy (bez PII). */
export type RetentionJobRun = {
  results: RecipientRetentionResult[];
  markets: string[];
  markets_source: RetentionMarketsResolution["source"] | null;
  markets_failed: number;
  failures: Array<{ market_id: string; error_code: string }>;
  alarms: {
    no_markets: number;
    term_invalid: number;
    narrowing_rejected: number;
  };
  term_refusal: Extract<RetentionTermValidation, { ok: false }> | null;
};

export function emptyRetentionJobRun(): RetentionJobRun {
  return {
    results: [],
    markets: [],
    markets_source: null,
    markets_failed: 0,
    failures: [],
    alarms: { no_markets: 0, term_invalid: 0, narrowing_rejected: 0 },
    term_refusal: null,
  };
}

export function retentionErrorCode(err: unknown): string {
  return (err as { error_code?: string })?.error_code ?? (err as Error)?.name ?? "unknown";
}
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
): Promise<RetentionJobRun> {
  const logger = resolveLogger(container);
  const posthog = resolveOptional<PosthogClient>(container, "posthog");
  const sentry = resolveOptional<SentryClient>(container, "sentry");
  const run = emptyRetentionJobRun();

  const term = validateRetentionDays(process.env.VOUCHER_PII_RETENTION_DAYS);
  if (!term.ok) {
    run.term_refusal = term;
    run.alarms.term_invalid = 1;
    logger.error(
      `${term.error_code}: VOUCHER_PII_RETENTION_DAYS='${term.raw}' refused (reason=${term.reason}, ` +
        `min=${RETENTION_DAYS_MIN} = retry horizon ${RETRY_HORIZON_DAYS} d + margin ${RETENTION_DAYS_MARGIN_DAYS} d) — nothing redacted`
    );
    sentry?.captureMessage(`${SCHEDULE_NAME} ${term.error_code} reason=${term.reason}`, "error");
    return run;
  }
  const retentionDays = term.days;
  const batchSize = Number(
    process.env.VOUCHER_PII_RETENTION_BATCH_SIZE ?? BATCH_SIZE_DEFAULT
  );
  const dryRun = process.env.VOUCHER_PII_RETENTION_DRY_RUN === "1";

  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
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
    return run;
  }

  const runner = resolveRunner(container, logger);
  const resolution = await resolveRetentionMarkets({
    logger,
    injectedLoader: resolveOptional<{ listActive: () => Promise<string[]> }>(container, "gp_market_loader"),
  });
  run.markets = resolution.markets;
  run.markets_source = resolution.source;
  run.alarms.narrowing_rejected = resolution.narrowing_rejected.length;
  if (resolution.no_markets) {
    run.alarms.no_markets = 1;
    sentry?.captureMessage(
      `${SCHEDULE_NAME} ${resolution.no_markets.error_code} reason=${resolution.no_markets.reason}`,
      "error"
    );
  }
  const markets = resolution.markets;

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
          run.results.push(result);
          logger.info(formatRetentionCarrierLog(result));
          posthog?.capture({
            distinctId: `retention:${market_id}`,
            event: "voucher.pii.purged.v1",
            properties: { market_id, carriers: result.carriers },
          });
        } catch (err) {
          const code = retentionErrorCode(err);
          run.markets_failed += 1;
          run.failures.push({ market_id, error_code: code });
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
      next_run_at: new Date(Date.now() + DAY_MS).toISOString(),
      markets_scanned: markets.length,
      markets_failed: run.markets_failed,
      markets_source: resolution.source,
      no_markets_alarm: run.alarms.no_markets,
      runner_resolved: runner !== null,
    },
  });

  sentry?.addBreadcrumb({
    category: "retention.cron",
    level: "info",
    message: `voucher-pii-retention-sweep done markets=${markets.length} failed=${run.markets_failed}`,
  });

  logger.info(`done markets=${markets.length} failed=${run.markets_failed} source=${resolution.source}`);
  return run;
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
};
