import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { MedusaRequest } from "@medusajs/framework/http"

export type OrderModuleLike = {
  retrieveOrder: (id: string, options?: Record<string, unknown>) => Promise<{
    id?: string
    customer_id?: string | null
    payment_status?: string | null
    status?: string | null
    created_at?: string | Date | null
    sales_channel_id?: string | null
  } | null>
}

export type RetrievedOrder = Awaited<ReturnType<OrderModuleLike["retrieveOrder"]>>

type KnexLike = {
  raw: (sql: string, bindings?: ReadonlyArray<unknown>) => Promise<{ rows?: unknown[] }>
}

export function resolveOrderModule(req: MedusaRequest): OrderModuleLike {
  return req.scope.resolve(Modules.ORDER) as OrderModuleLike
}

export async function resolveOrderByCartId(
  req: MedusaRequest,
  cartId: string
): Promise<string | null> {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as KnexLike
  try {
    const result = await db.raw(
      `
        SELECT id
        FROM "order"
        WHERE cart_id = ?
          AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [cartId]
    )
    const row = result.rows?.[0] as Record<string, unknown> | undefined
    return typeof row?.id === "string" ? row.id : null
  } catch {
    return null
  }
}

export async function retrieveOrderByStatusIdentifier(
  req: MedusaRequest,
  orderModule: OrderModuleLike,
  statusIdentifier: string
): Promise<RetrievedOrder> {
  const options = {
    select: ["id", "customer_id", "payment_status", "status", "created_at", "sales_channel_id"],
  }
  const directOrder = await orderModule.retrieveOrder(statusIdentifier, options)
  if (directOrder) {
    return directOrder
  }

  const resolvedOrderId = await resolveOrderByCartId(req, statusIdentifier)
  if (!resolvedOrderId || resolvedOrderId === statusIdentifier) {
    return null
  }

  return orderModule.retrieveOrder(resolvedOrderId, options)
}
