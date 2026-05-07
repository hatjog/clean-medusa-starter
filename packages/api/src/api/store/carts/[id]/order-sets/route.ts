/**
 * GET /store/carts/:id/order-sets
 *
 * Story v160-cleanup-12e — order_set projector on read boundary (AR45).
 * Story v160-cleanup-15e — CRIT-1 fix: replaced env-literal flag read with
 *   singleton `getFlagState` from feature-flag-tri-state (single oracle).
 *
 * When multi_vendor_pdp flag is "on" or "shadow", returns per-vendor
 * line-item splits computed from the cart's line items using
 * `metadata.selected_seller_id`. This is a pure read projection — no DB
 * write occurs. Write-side order_set rows are created by Mercur's
 * `completeCartWithSplitOrdersWorkflow` at cart completion.
 *
 * Flag OFF or single-vendor cart: returns empty splits array (AC4 compliance).
 *
 * Response shape:
 * {
 *   order_set_splits: VendorSplit[]
 * }
 *
 * VendorSplit:
 * {
 *   seller_id: string
 *   seller_name: string | null
 *   seller_handle: string | null
 *   subtotal: number        // sum of (unit_price * quantity) for this seller's items
 *   item_count: number
 * }
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import { marketContextStorage } from "../../../../../lib/market-context"
import { getFlagState } from "../../../../../lib/feature-flag-tri-state"

type CartLineItemRow = {
  id: string
  unit_price: string | number
  quantity: number
  metadata: Record<string, unknown> | null
}

type SellerRow = {
  id: string
  name: string
  handle: string
}

export type VendorSplit = {
  seller_id: string
  seller_name: string | null
  seller_handle: string | null
  subtotal: number
  item_count: number
}

/**
 * GET handler: compute per-vendor splits for a cart.
 *
 * No auth required — same as /store/carts/:id (public cart by ID).
 * Caller (storefront) should only expose to the cart owner via cookie-based
 * cart ID.
 */
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  // story v160-cleanup-27h: ALS extract for cart market isolation (TF-47).
  // If ALS context is set and cart.sales_channel_id differs from ctx.sales_channel_id,
  // return 404 fail-closed (AC7). NOTE: the `cart` table does NOT have a `market_id`
  // column — multi-tenant cart isolation is enforced via `sales_channel_id`
  // (see `cartMarketGuardMiddleware` in api/middlewares.ts which uses the same
  // mapping). Review fix H1: prior code queried `cart.market_id` which would 500
  // at runtime with `column "market_id" does not exist`.
  const ctx = marketContextStorage.getStore()
  const market_id = ctx?.market_id ?? null
  const sales_channel_id = ctx?.sales_channel_id ?? null

  const cartId = (req.params as Record<string, string>).id
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex

  // Uses singleton oracle (feature-flag-tri-state) NOT env literal — CRIT-1 fix.
  const flagState = await getFlagState("multi_vendor_pdp", db)
  if (flagState !== "on") {
    res.json({ order_set_splits: [] })
    return
  }

  // Cart market isolation: assert cart.sales_channel_id === ALS sales_channel_id
  // (fail-closed 404 on mismatch). `cartMarketGuardMiddleware` already enforces
  // this on /store/carts*; this in-handler check is defense-in-depth so the
  // route is safe even if middleware ordering changes.
  if (sales_channel_id) {
    const cartRow = await db<{ sales_channel_id: string | null }>("cart")
      .select(["sales_channel_id"])
      .where("id", cartId)
      .whereNull("deleted_at")
      .first()
    if (!cartRow || cartRow.sales_channel_id !== sales_channel_id) {
      res.status(404).json({ type: "not_found", message: "Cart not found" })
      return
    }
  }
  // Reference market_id for diagnostics (kept in scope for future per-market logic).
  void market_id

  // Load cart line items with metadata
  const lineItems = await db<CartLineItemRow>("cart_line_item")
    .select(["id", "unit_price", "quantity", "metadata"])
    .where("cart_id", cartId)
    .whereNull("deleted_at")

  if (lineItems.length === 0) {
    res.json({ order_set_splits: [] })
    return
  }

  // Group line items by seller_id from metadata
  const splitMap = new Map<string, { subtotal: number; item_count: number }>()

  for (const item of lineItems) {
    const metadata = item.metadata as Record<string, unknown> | null
    const sellerId =
      typeof metadata?.selected_seller_id === "string"
        ? metadata.selected_seller_id
        : null

    if (!sellerId) continue

    const unitPrice = Number(item.unit_price)
    const quantity = Number(item.quantity)
    const lineTotal = unitPrice * quantity

    const existing = splitMap.get(sellerId)
    if (existing) {
      existing.subtotal += lineTotal
      existing.item_count += 1
    } else {
      splitMap.set(sellerId, { subtotal: lineTotal, item_count: 1 })
    }
  }

  if (splitMap.size === 0) {
    res.json({ order_set_splits: [] })
    return
  }

  // Resolve seller names + handles in one query
  const sellerIds = Array.from(splitMap.keys())
  const sellers = await db<SellerRow>("seller")
    .select(["id", "name", "handle"])
    .whereIn("id", sellerIds)
    .whereNull("deleted_at")

  const sellerByIdMap = new Map(sellers.map((s) => [s.id, s]))

  const splits: VendorSplit[] = Array.from(splitMap.entries()).map(
    ([sellerId, agg]) => {
      const seller = sellerByIdMap.get(sellerId)
      return {
        seller_id: sellerId,
        seller_name: seller?.name ?? null,
        seller_handle: seller?.handle ?? null,
        subtotal: agg.subtotal,
        item_count: agg.item_count,
      }
    },
  )

  res.json({ order_set_splits: splits })
}
