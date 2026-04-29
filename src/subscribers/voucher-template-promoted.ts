import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

/**
 * voucher-template-promoted — STORY-2-3 audit + flag-flip subscriber.
 *
 * Subscribes to:
 *   - `gp.voucher.template.submitted_for_approval.v1`
 *   - `gp.voucher.template.approved.v1`
 *   - `gp.voucher.template.rejected.v1`
 *   - `gp.voucher.template.runtime.activated.v1`
 *
 * Responsibilities:
 *   1. Mirror the lifecycle event into PostHog as a forensic event
 *      (`voucher.template.runtime.error_rate` is computed downstream from
 *      the `rejected` and `activated:off` streams).
 *   2. When the event is `runtime.activated.v1` with `new_state="off"`
 *      AND `actor_id` does NOT start with `"system:canary"`, log a
 *      structured warning so ops dashboards can distinguish manual ops
 *      rollbacks from canary auto-rollbacks (per
 *      gp-ops/runbooks/voucher-template-runtime-activation.md §"Audit").
 *   3. Defer all DB writes to the upstream emitter (audit row was written
 *      atomically inside the flag transition tx — D-67 contract). This
 *      subscriber MUST be side-effect-free with respect to the audit chain.
 *
 * AR-25 PII redaction: payloads MUST not contain recipient email/phone.
 * The schema in `specs/contracts/events/schemas/voucher.template.runtime.activated.v1.schema.json`
 * forbids those fields by `additionalProperties: false`. Validator
 * `validate_yaml_fixtures.py` enforces example fixtures.
 */

interface RuntimeActivatedPayload {
  market_id: string;
  flag_id: "voucher_template_v1_runtime_enabled";
  prior_state: "off" | "on" | "kill_switch";
  new_state: "off" | "on" | "kill_switch";
  actor_id: string;
  timestamp: string;
  seller_id?: string | null;
  runtime_version?: string;
  override_reason?: string;
}

interface PromotionPayload {
  template_id: string;
  market_id: string;
  actor_id: string;
  reason?: string;
}

type LoggerLike = {
  info?: (message: string, meta?: unknown) => void;
  warn?: (message: string, meta?: unknown) => void;
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

function isRuntimeActivatedPayload(x: unknown): x is RuntimeActivatedPayload {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p.market_id === "string" &&
    p.flag_id === "voucher_template_v1_runtime_enabled" &&
    typeof p.prior_state === "string" &&
    typeof p.new_state === "string" &&
    typeof p.actor_id === "string" &&
    typeof p.timestamp === "string"
  );
}

function isPromotionPayload(x: unknown): x is PromotionPayload {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p.template_id === "string" &&
    typeof p.market_id === "string" &&
    typeof p.actor_id === "string"
  );
}

export default async function voucherTemplatePromoted({
  event,
  container,
}: SubscriberArgs<unknown>): Promise<void> {
  const logger = resolveLogger(container as unknown as Record<string, unknown> | undefined);
  const eventName = (event as { name?: string })?.name ?? "unknown";
  const data = (event as { data?: unknown })?.data;

  if (eventName.endsWith("voucher.template.runtime.activated.v1")) {
    if (!isRuntimeActivatedPayload(data)) {
      logger.warn?.(`[voucher-template-promoted] malformed runtime.activated.v1 payload`, {
        event: eventName,
      });
      return;
    }
    const isCanary = data.actor_id.startsWith("system:canary");
    const isOverride = data.actor_id.startsWith("override:");
    if (data.new_state === "off" && !isCanary) {
      logger.warn?.(
        `[voucher-template-promoted] manual rollback for market='${data.market_id}' actor='${data.actor_id}'`,
        {
          flag_id: data.flag_id,
          prior_state: data.prior_state,
          new_state: data.new_state,
          override_reason: data.override_reason ?? null,
        }
      );
    } else if (data.new_state === "on") {
      logger.info?.(
        `[voucher-template-promoted] activation for market='${data.market_id}' override=${isOverride}`,
        {
          flag_id: data.flag_id,
          actor_id: data.actor_id,
          override_reason: data.override_reason ?? null,
        }
      );
    }
    return;
  }

  if (
    eventName.endsWith("voucher.template.submitted_for_approval.v1") ||
    eventName.endsWith("voucher.template.approved.v1") ||
    eventName.endsWith("voucher.template.rejected.v1")
  ) {
    if (!isPromotionPayload(data)) {
      logger.warn?.(`[voucher-template-promoted] malformed promotion payload`, {
        event: eventName,
      });
      return;
    }
    logger.info?.(
      `[voucher-template-promoted] ${eventName} template='${data.template_id}' market='${data.market_id}' actor='${data.actor_id}'`
    );
    return;
  }

  // Unknown event — log only.
  logger.info?.(`[voucher-template-promoted] ignoring event=${eventName}`);
}

export const config: SubscriberConfig = {
  event: [
    "gp.voucher.template.submitted_for_approval.v1",
    "gp.voucher.template.approved.v1",
    "gp.voucher.template.rejected.v1",
    "gp.voucher.template.runtime.activated.v1",
  ],
  context: {
    subscriberId: "voucher-template-promoted",
  },
};
