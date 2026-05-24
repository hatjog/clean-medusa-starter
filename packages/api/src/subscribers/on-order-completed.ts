import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

/**
 * Cross-version OrderPlaced payload shape (STORY-MIG-B AC #5 — D-50 backward
 * compatibility rule).
 *
 * The subscriber accepts:
 *   1. Mercur Medusa payload — `order_ids: string[]`
 *   2. Standard MedusaJS payload — `id: string`
 *   3. v2 envelope payload — `order_id: string` plus the v2 fields
 *      (`mor`, `recipient_locale`, `message_locale`, `is_gift`).
 *
 * All v2-specific fields are optional + accessed via optional chaining with
 * sensible defaults so a v1 payload arriving at a v2-aware subscriber does
 * not crash. The cross-version regression matrix in
 * `__tests__/subscribers/orderplaced-cross-version.test.ts` exercises both
 * directions.
 */
type OrderPlacedPayload = {
  order_ids?: string[]
  id?: string
  order_id?: string
  recipient_locale?: string | null
  message_locale?: string | null
  is_gift?: boolean
  mor?: {
    sale_mor?: "operator" | "vendor"
    service_mor?: "operator" | "vendor"
    mor_policy_version?: string
    voucher_kind?: "SPV" | "MPV" | "none"
    breakage_policy_snapshot?: Record<string, unknown> | null
  } | null
}

function resolveLogger(container: Record<string, unknown> | undefined): LoggerLike {
  const direct = container?.logger as LoggerLike | undefined
  if (direct) {
    return direct
  }

  const resolver = container?.resolve as ((key: string) => unknown) | undefined
  if (typeof resolver === "function") {
    try {
      return (resolver("logger") as LoggerLike | undefined) ?? console
    } catch {
      return console
    }
  }

  return console
}

function extractOrderIds(data: OrderPlacedPayload): string[] {
  if (Array.isArray(data.order_ids) && data.order_ids.length > 0) {
    return data.order_ids
  }

  if (typeof data.id === "string" && data.id.length > 0) {
    return [data.id]
  }

  // v2 envelope: payload.order_id is the canonical order identifier per the
  // frozen `order_placed.v2.schema.json`.
  if (typeof data.order_id === "string" && data.order_id.length > 0) {
    return [data.order_id]
  }

  return []
}

/**
 * Detect the payload shape for telemetry / branching. The `v2` shape is
 * identified by the presence of v2-only fields (`mor`, `recipient_locale`,
 * etc.). Optional chaining is used so a v1 payload never crashes here.
 */
function detectPayloadShape(data: OrderPlacedPayload): string {
  if (Array.isArray(data.order_ids)) {
    return "mercur"
  }
  if (typeof data.id === "string") {
    return "standard"
  }
  if (typeof data.order_id === "string") {
    // Cheap discriminator: v2 always carries `mor` snapshot.
    if (data?.mor !== undefined) {
      return "v2"
    }
    return "v1-envelope"
  }
  return "unknown"
}

/**
 * v1.9.0 wf5 H-8 / CC-1 F-CC1-001 (ra-E9 carry-out, DEC-A Option 2):
 *
 * This subscriber is now a NO-OP marker. The previous implementation called
 * `gpCore.createEntitlement(...)` which throws `NotImplementedError` and was
 * caught in a try/catch that logged a misleading "createEntitlement stub"
 * warn — that same log line misled the Wave-B agent in v1.8.0 into
 * reimplementing 787 lines of code in the wrong ADR-052 deprecation layer
 * (legacy gp_core System 1) instead of ADR-099 Layer 4 (voucher module
 * `entitlement_instance`). Recovery cost ~30h once and the failure mode
 * survives validators/tests — so the call (and the warn) are removed
 * entirely. Entitlement creation is owned by:
 *
 *   - Live capture: `subscribers/stripe-payment-audit.ts` → Path Y workflow →
 *     `issueEntitlementsForAllLineItems` (ADR-099 Layer 4, ADR-118 Path Y).
 *   - Webhook-before-order race recovery: `on-order-placed-stripe-retry.ts`
 *     (v1.9.0 wf5 ra-E1 carry-out, ADR-107 §Etap-2).
 *
 * The subscriber is retained as a doc breadcrumb so future agents reading
 * `order.placed` event flow find this comment instead of re-walking the
 * Wave-B reasoning chain. Removing the file entirely would also work but
 * the explicit no-op is a stronger signal.
 *
 * See: ADR-052 (gp_core voucher operations deprecation), ADR-099 (4-layer
 * entitlement model), ADR-118 (Path Y subscriber pattern).
 */
async function onOrderCompleted({ event, container }: SubscriberArgs<OrderPlacedPayload>): Promise<void> {
  const logger = resolveLogger(container as unknown as Record<string, unknown>)
  const payloadShape = detectPayloadShape(event.data)
  const orderIds = extractOrderIds(event.data)

  logger.info?.(
    `[on-order-completed] order.placed received — shape=${payloadShape} ` +
      `order_count=${orderIds.length} — entitlement creation owned by voucher ` +
      `module via Path Y stripe-payment-audit subscriber (ADR-052 + ADR-099 + ` +
      `ADR-118); this subscriber is intentionally a no-op marker.`
  )
}

export default onOrderCompleted

export const config: SubscriberConfig = {
  event: "order.placed",
}
