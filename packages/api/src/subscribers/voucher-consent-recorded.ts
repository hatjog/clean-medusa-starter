import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

import type { VoucherPiiService } from "../modules/voucher-pii";

/**
 * voucher-consent-recorded — STORY-2-2 D-72 voucher delivery worker entry.
 *
 * Consumes `gp.voucher.consent_recorded.v1` events emitted by the consent API
 * after the synchronous chained tx commits, and runs the 5-step audit
 * consistency contract via `VoucherPiiService.executeDeliveryStep`.
 *
 * Static N=4 worker pool (per D-72) — the Medusa subscriber framework runs
 * this subscriber per-event with concurrency capped by the runtime; the
 * `VOUCHER_DELIVERY_WORKER_POOL_SIZE` env var (default 4) tunes pool size in
 * the loader.
 *
 * Failure semantics:
 *   - Step 1 audit-not-confirmed → DLQ (`dlq_audit_failed`) + Sentry HIGH
 *     + state=`error-audit-failed`. NO dispatch. NO event emission of
 *     `voucher.delivery.dispatched`.
 *   - Step 2 rate-limit → DLQ (`dlq_rate_limited`) + retry semantics handled
 *     by Medusa backoff schedule (per provider integration).
 *   - Step 3 provider failure → DLQ (`dlq_provider_failed`) + retry.
 *   - Step 4-5 succeed → `dispatched` outcome + chained audit row + event.
 */

interface ConsentRecordedPayload {
  request_id: string;
  market_id: string;
  consent_audit_id: string;
  recipient_pii_id: string;
  delivery_decision_id: string;
  order_id: string;
  outcome: string;
}

type LoggerLike = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string, error?: unknown) => void;
};

function resolveLogger(container: Record<string, unknown> | undefined): LoggerLike {
  const direct = container?.logger as LoggerLike | undefined;
  if (direct) return direct;
  const resolver = container?.resolve as ((k: string) => unknown) | undefined;
  if (typeof resolver === "function") {
    try {
      return (resolver("logger") as LoggerLike | undefined) ?? console;
    } catch {
      return console;
    }
  }
  return console;
}

function resolveVoucherPii(
  container: Record<string, unknown> | undefined
): VoucherPiiService | null {
  const resolver = container?.resolve as ((k: string) => unknown) | undefined;
  if (typeof resolver === "function") {
    try {
      return resolver("voucher_pii") as VoucherPiiService | null;
    } catch {
      return null;
    }
  }
  return (container?.voucher_pii as VoucherPiiService) ?? null;
}

async function onConsentRecorded({
  event,
  container,
}: SubscriberArgs<ConsentRecordedPayload>): Promise<void> {
  const logger = resolveLogger(container as unknown as Record<string, unknown>);

  // Defence: only act on `granted` outcomes; `audit_failed` is already a
  // terminal state — NEVER trigger delivery on a failed consent (R-NEW-6 R1 F4).
  if (event.data.outcome !== "granted") {
    logger.info?.(
      `[voucher-consent-recorded] skipping non-granted outcome=${event.data.outcome} ` +
        `consent_audit_id=${event.data.consent_audit_id}`
    );
    return;
  }

  const service = resolveVoucherPii(container as unknown as Record<string, unknown>);
  if (!service) {
    logger.warn?.(
      "[voucher-consent-recorded] VoucherPiiService not resolved — skipping " +
        "(TODO(MEDUSA-CONTAINER): wire voucher_pii loader)"
    );
    return;
  }

  try {
    const result = await service.executeDeliveryStep({
      consent_audit_id: event.data.consent_audit_id,
      market_id: event.data.market_id,
      recipient_id: event.data.recipient_pii_id,
      request_id: event.data.request_id,
      delivery_decision_id: event.data.delivery_decision_id,
      delivery_attempt_n: 0,
    });
    logger.info?.(
      `[voucher-consent-recorded] step done outcome=${result.outcome} ` +
        `consent_audit_id=${event.data.consent_audit_id} latency_ms=${result.latency_ms}`
    );
  } catch (err) {
    // FAIL-LOUD per project Sentry policy. The delivery decision row was
    // already updated to a DLQ outcome inside executeDeliveryStep (no silent
    // fallback). Re-throw so Medusa's DLQ infrastructure picks it up.
    logger.error?.(
      `[voucher-consent-recorded] error in 5-step contract consent_audit_id=` +
        `${event.data.consent_audit_id}: ${(err as Error)?.message ?? String(err)}`,
      err
    );
    throw err;
  }
}

export default onConsentRecorded;

export const config: SubscriberConfig = {
  event: "gp.voucher.consent_recorded.v1",
};
