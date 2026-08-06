/**
 * GET /store/carts/:id/completed-order
 *
 * Read-only bridge for guest checkout completion. Mercur's cart completion can
 * return an order_group without embedding child order ids, while the storefront
 * handoff needs the concrete order ids for confirmation/payment-status routes.
 *
 * ── v1.15.0 Story 3.6 (FR-7, AD-16) — this bridge carries CARDINALITY ────────
 * A multi-seller cart produces ONE order PER SELLER. Until v1.15.0 this handler
 * ended its query with `.orderBy("o.created_at","desc").first()`, so a two-seller
 * purchase was reported to the storefront as a single order and the buyer was
 * shown one of her two orders with nothing indicating the other existed.
 *
 * The upstream boundary is measured, not assumed: `OrderGroupDTO`
 * (`@mercurjs/types/dist/order-group/common.d.ts:1-11`) has NO `orders` field —
 * only `seller_count` — and Medusa's `StoreCompleteCartResponse`
 * (`@medusajs/types/dist/http/cart/store/responses.d.ts:36-47`) carries a single
 * `order`. Child order ids are therefore NOT reachable from the completion
 * response, which is exactly why the collection has to be built HERE.
 *
 * Response shape: `orders: [{ order_id, order_group_id }, ...]` — the whole set.
 * `order_id` / `order_group_id` remain at the top level as a BACKWARD-COMPAT
 * drill-down for storefront builds deployed before this change (the two repos
 * are separate submodules and can be deployed out of step). Per AD-16 this is a
 * legitimate reduction only because the surface it sits on (`orders`) shows the
 * WHOLE set — it is a drill-down, not a truncation, and it is named as such.
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
  // AD-16: `orderBy` here orders the COLLECTION for a stable, reproducible
  // response — it does not select an element. Ascending by creation time so the
  // first seller's order stays first across repeated reads.
  const rows = await db<CompletedOrderRow>("order_cart as oc")
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
    .orderBy("o.created_at", "asc")
    .orderBy("o.id", "asc")

  const orders = rows
    .filter((row) => typeof row.order_id === "string" && row.order_id.length > 0)
    .map((row) => ({
      order_id: row.order_id,
      order_group_id: row.order_group_id ?? null,
    }))

  if (orders.length === 0) {
    res.status(404).json({ type: "not_found", message: "Completed order not found" })
    return
  }

  res.json({
    orders,
    order_count: orders.length,
    // Backward-compat drill-down (see file header). NOT a reduction of the
    // contract: `orders` above carries the whole set.
    order_id: orders[0].order_id,
    order_group_id: orders[0].order_group_id,
  })
}
