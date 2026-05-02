import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

import type { VoucherPiiService } from "../modules/voucher-pii";

/**
 * voucher-withdrawal-immediate — STORY-2-2 D-66 symmetric path.
 *
 * Consumes `gp.voucher.consent_withdrawn.v1` events. Per Socratic finding
 * §retention-symmetry, three convergent paths land here:
 *   - immediate (user click) — audit `consent.withdrawn` triggers fast-path
 *     purge <60s.
 *   - scheduled (TTL expiry) — daily cron sweep emits the event after
 *     purging.
 *   - dlq_ttl — DLQ entry expires past TTL → retention sweep cleans it up.
 *
 * Subscriber's job: ensure PII row is tombstoned + audit row written + any
 * in-flight dispatch aborted via idempotency guard.
 */

interface ConsentWithdrawnPayload {
  request_id: string;
  market_id: string;
  consent_audit_id: string;
  order_id: string;
  withdrawal_path?: "immediate" | "scheduled_ttl" | "dlq_ttl";
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

async function onWithdrawal({
  event,
  container,
}: SubscriberArgs<ConsentWithdrawnPayload>): Promise<void> {
  const logger = resolveLogger(container as unknown as Record<string, unknown>);
  const service = resolveVoucherPii(
    container as unknown as Record<string, unknown>
  );
  if (!service) {
    logger.warn?.(
      "[voucher-withdrawal-immediate] VoucherPiiService not resolved — skipping"
    );
    return;
  }

  try {
    const result = await service.recordWithdrawalTransaction({
      market_id: event.data.market_id,
      order_id: event.data.order_id,
      consent_audit_id: event.data.consent_audit_id,
      request_id: event.data.request_id,
      withdrawal_path: event.data.withdrawal_path ?? "immediate",
    });
    logger.info?.(
      `[voucher-withdrawal-immediate] withdrawn consent_audit_id=` +
        `${event.data.consent_audit_id} aborted=${result.in_flight_dispatch_aborted} ` +
        `latency_ms=${result.latency_ms}`
    );
  } catch (err) {
    logger.error?.(
      `[voucher-withdrawal-immediate] error consent_audit_id=` +
        `${event.data.consent_audit_id}: ${(err as Error)?.message ?? String(err)}`,
      err
    );
    throw err;
  }
}

export default onWithdrawal;

export const config: SubscriberConfig = {
  event: "gp.voucher.consent_withdrawn.v1",
};
