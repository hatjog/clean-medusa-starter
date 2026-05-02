import type { MedusaContainer } from "@medusajs/framework/types";

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

interface VoucherPiiServiceLike {
  purgeExpiredPii(args: {
    market_id: string;
    cutoff: Date;
    batch_size: number;
  }): Promise<{ rows_deleted: number; orphans_deleted: number }>;
}

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

function resolveService(
  container: MedusaContainer | undefined
): VoucherPiiServiceLike | null {
  try {
    return (
      (container?.resolve?.("voucher_pii") as VoucherPiiServiceLike | undefined) ??
      null
    );
  } catch {
    return null;
  }
}

export default async function voucherPiiOrphanCleanup(
  container: MedusaContainer
): Promise<void> {
  const logger = resolveLogger(container);
  const service = resolveService(container);
  if (!service) {
    logger.warn(
      "voucher_pii service not resolved — skipping orphan cleanup " +
        "(TODO(MEDUSA-CONTAINER): wire voucher_pii loader)"
    );
    return;
  }

  // The orphan-cleanup helper on the port runs cross-market — pass a sentinel
  // that the adapter recognises as "all markets" via the bypass code path
  // (cutoff is unused for orphan-only invocations; rows_deleted will be 0
  // for the time-window purge component).
  const sentinelMarket = process.env.VOUCHER_PII_ORPHAN_MARKET ?? "";
  if (!sentinelMarket) {
    logger.info("orphan cleanup invoked across-markets via service.purgeExpiredPii");
  }
  try {
    const result = await service.purgeExpiredPii({
      market_id: sentinelMarket,
      cutoff: new Date(0), // far past — purge component is a no-op
      batch_size: 10_000,
    });
    logger.info(`orphan cleanup orphans_deleted=${result.orphans_deleted}`);
  } catch (err) {
    logger.error("orphan cleanup error", err);
  }
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
};
