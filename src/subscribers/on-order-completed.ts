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

type OrderPlacedPayload = {
  order_ids?: string[]
  id?: string
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

  return []
}

async function onOrderCompleted({ event, container }: SubscriberArgs<OrderPlacedPayload>): Promise<void> {
  const logger = resolveLogger(container as unknown as Record<string, unknown>)
  const payloadShape = event.data.order_ids ? "mercur" : event.data.id ? "standard" : "unknown"

  logger.info?.(`[gp_core] order.placed received — shape=${payloadShape}`)

  const orderIds = extractOrderIds(event.data)
  if (orderIds.length === 0) {
    logger.warn?.("[gp_core] order.placed — no order IDs in payload, skipping")
    return
  }

  const gpCore = resolveGpCore(container as unknown as Record<string, unknown>)
  if (!gpCore) {
    logger.warn?.("[gp_core] order.placed — GpCoreService not available, skipping")
    return
  }

  for (const orderId of orderIds) {
    try {
      await gpCore.createEntitlement({ order_id: orderId } as unknown)
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
