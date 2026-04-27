import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"

import { NotImplementedError } from "../modules/gp-core/service"

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

type GpCoreServiceLike = {
  createEntitlement: (dto: unknown) => Promise<unknown>
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

function resolveGpCore(container: Record<string, unknown> | undefined): GpCoreServiceLike | null {
  const resolver = container?.resolve as ((key: string) => unknown) | undefined
  if (typeof resolver === "function") {
    try {
      return resolver("gp_core") as GpCoreServiceLike | null
    } catch {
      return null
    }
  }

  return (container?.gp_core as GpCoreServiceLike) ?? null
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

async function onOrderCompleted({ event, container }: SubscriberArgs<OrderPlacedPayload>): Promise<void> {
  const logger = resolveLogger(container as unknown as Record<string, unknown>)
  const payloadShape = detectPayloadShape(event.data)

  logger.info?.(`[gp_core] order.placed received — shape=${payloadShape}`)

  const orderIds = extractOrderIds(event.data)
  if (orderIds.length === 0) {
    logger.warn?.("[gp_core] order.placed — no order IDs in payload, skipping")
    return
  }

  // v2 sense-check (AC #5) — accessed via optional chaining + sensible
  // defaults so a v1 payload (no `mor`, no `recipient_locale`) does not throw.
  // The values are surfaced for entitlement composition; v1 paths still run
  // unchanged because every read is guarded by `?.` + nullish coalescing.
  const recipientLocale = event.data?.recipient_locale ?? null
  const messageLocale =
    event.data?.message_locale ?? event.data?.recipient_locale ?? null
  const isGift = event.data?.is_gift ?? recipientLocale !== null
  const voucherKind = event.data?.mor?.voucher_kind ?? "none"

  const gpCore = resolveGpCore(container as unknown as Record<string, unknown>)
  if (!gpCore) {
    logger.warn?.("[gp_core] order.placed — GpCoreService not available, skipping")
    return
  }

  for (const orderId of orderIds) {
    try {
      await gpCore.createEntitlement({
        order_id: orderId,
        // v2 fields — pass-through with v1-safe defaults (D-50 backward compat).
        recipient_locale: recipientLocale,
        message_locale: messageLocale,
        is_gift: isGift,
        voucher_kind: voucherKind,
      } as unknown)
      logger.info?.(`[gp_core] order.placed — entitlement created for order ${orderId}`)
    } catch (error) {
      if (error instanceof NotImplementedError) {
        logger.warn?.(`[gp_core] order.placed — createEntitlement stub (${error.message}), order ${orderId}`)
      } else {
        logger.error?.(`[gp_core] order.placed — error processing order ${orderId}: ${String(error)}`)
      }
    }
  }
}

export default onOrderCompleted

export const config: SubscriberConfig = {
  event: "order.placed",
}
