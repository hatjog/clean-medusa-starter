import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "knex";

import { runInSystemMarketContext } from "../lib/system-market-context";
import {
  formatRetentionCarrierLog,
  runRecipientRetentionForMarket,
} from "../modules/voucher-pii/recipient-retention-runtime";
import { resolveRetentionMarkets } from "../modules/voucher-pii/recipient-retention-markets";
import {
  emptyRetentionJobRun,
  retentionErrorCode,
  type RetentionJobRun,
} from "./voucher-pii-retention-sweep";

/**
 * voucher-pii-orphan-cleanup — STORY-2-2 D-70 orphan PII detection.
 *
 * Runs the orphan-row scan as a separate hourly job (in addition to the daily
 * sweep's orphan pass). Per AC-PII-ORPHAN-01, an orphan = `voucher_recipient_pii`
 * row whose `entitlement_id` no longer resolves (entitlement deleted but PII
 * row persists). Hourly cadence catches storefront-driven entitlement
 * deletions promptly without waiting for the daily sweep.
 *
 * The actual SQL lives in the VoucherPiiPort adapter (`cleanupOrphans`); this
 * job just invokes the port and emits observability events.
 */

export const SCHEDULE_NAME = "voucher-pii-orphan-cleanup" as const;
export const SCHEDULE_CRON = "0 * * * *" as const; // hourly



interface JobLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
}

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
    // fallthrough
  }
  return fallback;
}

/**
 * v1.16.0 Story 11.6 (DW-15-360 `scope_extension_6_5`): wcześniej job wołał
 * `voucher_pii.purgeExpiredPii` (klucz nierejestrowany w runtime — martwe
 * wiring) z pustym „sentinel” rynkiem, czyli BEZ kontekstu rynku: pod hookiem
 * RLS taka praca jest odmową. Teraz: te same rynki co sweep dzienny
 * (projekcja gp-config instancji, fix R-1; env = zawężenie), `runInSystemMarketContext`, rola
 * `medusa_store`; cutoff = epoch, więc składowe terminowe są no-opem, a liczy
 * się wyłącznie `voucher_recipient_pii.orphans`.
 */
export default async function voucherPiiOrphanCleanup(
  container: MedusaContainer
): Promise<RetentionJobRun> {
  const logger = resolveLogger(container);
  const run = emptyRetentionJobRun();
  let db: Knex | null = null;
  try {
    db = (container?.resolve?.(ContainerRegistrationKeys.PG_CONNECTION) as Knex | undefined) ?? null;
  } catch (err) {
    logger.error("GP_RECIPIENT_RETENTION_NO_PG_CONNECTION: orphan cleanup NOT executed", err);
    return run;
  }
  if (!db) {
    logger.error("GP_RECIPIENT_RETENTION_NO_PG_CONNECTION: orphan cleanup NOT executed");
    return run;
  }
  const resolution = await resolveRetentionMarkets({ logger });
  run.markets = resolution.markets;
  run.markets_source = resolution.source;
  run.alarms.narrowing_rejected = resolution.narrowing_rejected.length;
  if (resolution.no_markets) {
    run.alarms.no_markets = 1;
    return run;
  }
  const pg = db;
  await runInSystemMarketContext(
    {
      markets: resolution.markets,
      instanceId: process.env.GP_INSTANCE_ID,
      origin: { surface: "job", name: SCHEDULE_NAME },
      logger,
    },
    async (market_id) => {
      try {
        const result = await runRecipientRetentionForMarket(pg, {
          market_id,
          cutoff: new Date(0),
          batch_size: 10_000,
        });
        run.results.push(result);
        logger.info(formatRetentionCarrierLog(result));
      } catch (err) {
        const code = retentionErrorCode(err);
        run.markets_failed += 1;
        run.failures.push({ market_id, error_code: code });
        logger.error(`market=${market_id} orphan cleanup error error_code=${code}`, err);
      }
    }
  );
  return run;
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
};
