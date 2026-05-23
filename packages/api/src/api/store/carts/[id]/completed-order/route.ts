/**
 * GET /store/carts/:id/completed-order
 *
 * Read-only bridge for guest checkout completion. Mercur's cart completion can
 * return an order_group without embedding child order ids, while the storefront
 * handoff needs the concrete order id for confirmation/payment-status routes.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

export const AUTHENTICATE = false

type CompletedOrderRow = {
  order_id: string
  order_group_id: string | null
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const cartId = (req.params as { id?: string }).id

  if (!cartId) {
    res.status(400).json({ type: "invalid_request", message: "Cart ID is required" })
    return
  }

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  const row = await db<CompletedOrderRow>("order_cart as oc")
    .select({
      order_id: "o.id",
      order_group_id: "og.id",
    })
    .join({ o: "order" }, "o.id", "oc.order_id")
    .leftJoin({ ogo: "order_group_order" }, "ogo.order_id", "o.id")
    .leftJoin({ og: "order_group" }, "og.id", "ogo.order_group_id")
    .where("oc.cart_id", cartId)
    .whereNull("oc.deleted_at")
    .whereNull("o.deleted_at")
    .orderBy("o.created_at", "desc")
    .first()

  if (!row?.order_id) {
    res.status(404).json({ type: "not_found", message: "Completed order not found" })
    return
  }

  res.json({
    order_id: row.order_id,
    order_group_id: row.order_group_id ?? null,
  })
}
