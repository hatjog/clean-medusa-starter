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
 *
 * The scalar also keeps its PRE-3.6 SEMANTICS (newest order of the cart), not
 * just its shape — see the comment at the response site. Backward compatibility
 * that preserves the field name while changing which row it points at is not
 * backward compatibility.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

export const AUTHENTICATE = false

type CompletedOrderRow = {
  order_id: string
  order_group_id: string | null
  status: string | null
}

type PaymentStatusRow = {
  order_id: string
  payment_status: string | null
}

/**
 * v1.16.0 Story 8.6 (FR-17, AD-16, NFR-7) — terminal state PER ORDER.
 *
 * "Order accepted" must mean the same thing for the whole purchase. An order
 * is terminal for the confirmation when it is not draft/canceled/awaiting an
 * action AND none of its live payment collections is still open or failed.
 * An order without a payment collection has nothing to wait for on the money
 * side (named here, not assumed elsewhere).
 */
export const NON_TERMINAL_ORDER_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "canceled",
  "requires_action",
])
/**
 * v1.16.0 Story 8.6 review-fix (MEDIUM, round 1/2): payment side is classified
 * by an ALLOW-list ("money settled"), never by a deny-list. A deny-list was
 * fail-open: `partially_authorized` (set by @medusajs/payment 2.14.2
 * `maybeUpdatePaymentCollection_` when 0 < authorized < amount — exactly the
 * N sessions/PIs case, and Mercur split orders share ONE cart collection) and
 * any future status counted as terminal.
 *
 * - `authorized`: authorized amount >= collection amount — the whole purchase
 *   amount is held by the PSP; nothing is open on the money side.
 * - `completed`: captured amount >= collection amount — money fully captured.
 *
 * Deliberately NOT terminal:
 * - `partially_authorized`: part of the amount still has no authorization.
 * - `partially_captured`: Medusa 2.14.2 never writes it from the collection
 *   maintenance; if it appears, the captured part is < amount and nothing
 *   proves the rest is authorized — fail closed.
 * - `not_paid`, `awaiting`, `requires_action`, `canceled`, `failed`: open or
 *   dead money.
 * - anything else (unknown / future status, null): unknown ⇒ not terminal.
 */
export const TERMINAL_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  "authorized",
  "completed",
])

export type OrderTerminalReason =
  | "terminal"
  | "order_status_non_terminal"
  | "payment_status_non_terminal"
  | "payment_status_unknown"

/** Statuses known to be non-terminal; used only to NAME the reason. */
const KNOWN_NON_TERMINAL_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  "not_paid",
  "awaiting",
  "requires_action",
  "canceled",
  "failed",
  "partially_authorized",
  "partially_captured",
])

export function classifyOrderTerminal(
  status: string | null,
  paymentStatuses: ReadonlyArray<string | null>
): { terminal: boolean; reason: OrderTerminalReason } {
  if (typeof status === "string" && NON_TERMINAL_ORDER_STATUSES.has(status)) {
    return { terminal: false, reason: "order_status_non_terminal" }
  }
  for (const ps of paymentStatuses) {
    if (typeof ps === "string" && TERMINAL_PAYMENT_STATUSES.has(ps)) continue
    return {
      terminal: false,
      reason:
        typeof ps === "string" && KNOWN_NON_TERMINAL_PAYMENT_STATUSES.has(ps)
          ? "payment_status_non_terminal"
          : "payment_status_unknown",
    }
  }
  return { terminal: true, reason: "terminal" }
}

export function isOrderTerminal(
  status: string | null,
  paymentStatuses: ReadonlyArray<string | null>
): boolean {
  return classifyOrderTerminal(status, paymentStatuses).terminal
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
      status: "o.status",
    })
    .join({ o: "order" }, "o.id", "oc.order_id")
    .leftJoin({ ogo: "order_group_order" }, "ogo.order_id", "o.id")
    .leftJoin({ og: "order_group" }, "og.id", "ogo.order_group_id")
    .where("oc.cart_id", cartId)
    .whereNull("oc.deleted_at")
    .whereNull("o.deleted_at")
    .orderBy("o.created_at", "asc")
    .orderBy("o.id", "asc")

  const liveRows = rows.filter(
    (row) => typeof row.order_id === "string" && row.order_id.length > 0
  )

  if (liveRows.length === 0) {
    res.status(404).json({ type: "not_found", message: "Completed order not found" })
    return
  }

  const receivedIds = liveRows.map((row) => row.order_id)

  // Story 8.6 (AC2): the EXPECTED set of the order-set is read from the order
  // group(s) of this cart — independently of `order_cart` — so the consumer
  // compares two SETS OF IDS, not a count with itself. A cart without a group
  // (single seller) expects exactly what it produced.
  const groupRows = await db<{ order_id: string }>("order_group_order as ogo")
    .distinct({ order_id: "ogo.order_id" })
    .join({ og: "order_group" }, "og.id", "ogo.order_group_id")
    .join({ o: "order" }, "o.id", "ogo.order_id")
    .whereNull("o.deleted_at")
    .whereNull("ogo.deleted_at")
    // Story 8.3 (DW-15-344 p.2): a soft-deleted group or a soft-deleted
    // membership in ANOTHER group must not pull foreign orders into the set.
    .whereNull("og.deleted_at")
    .where((q) => {
      q.where("og.cart_id", cartId).orWhereIn(
        "og.id",
        db("order_group_order")
          .select("order_group_id")
          .whereIn("order_id", receivedIds)
          .whereNull("deleted_at")
      )
    })
    .orderBy("ogo.order_id", "asc")
  const groupIds = groupRows.map((row) => row.order_id)
  const expectedIds = groupIds.length > 0 ? groupIds : [...receivedIds]

  const paymentRows = await db<PaymentStatusRow>("order_payment_collection as opc")
    .select({ order_id: "opc.order_id", payment_status: "pc.status" })
    .join({ pc: "payment_collection" }, "pc.id", "opc.payment_collection_id")
    .whereIn("opc.order_id", receivedIds)
    .whereNull("opc.deleted_at")
    .whereNull("pc.deleted_at")
  const paymentStatusesByOrder = new Map<string, Array<string | null>>()
  for (const row of paymentRows) {
    const list = paymentStatusesByOrder.get(row.order_id) ?? []
    list.push(row.payment_status ?? null)
    paymentStatusesByOrder.set(row.order_id, list)
  }

  const orders = liveRows.map((row) => {
    const paymentStatuses = paymentStatusesByOrder.get(row.order_id) ?? []
    return {
      order_id: row.order_id,
      order_group_id: row.order_group_id ?? null,
      status: row.status ?? null,
      payment_statuses: paymentStatuses,
      ...(() => {
        const c = classifyOrderTerminal(row.status ?? null, paymentStatuses)
        return { terminal: c.terminal, terminal_reason: c.reason }
      })(),
    }
  })

  // Open = expected but not produced for this cart, OR produced but not terminal.
  const receivedSet = new Set(receivedIds)
  const openIds = [
    ...expectedIds.filter((id) => !receivedSet.has(id)),
    ...orders.filter((order) => !order.terminal).map((order) => order.order_id),
  ]
  const expectedSet = new Set(expectedIds)
  const setsEqual =
    expectedSet.size === receivedSet.size && [...receivedSet].every((id) => expectedSet.has(id))

  // Backward-compat drill-down (see file header). NOT a reduction of the
  // contract: `orders` above carries the whole set.
  //
  // v1.15.0 Story 3.6 review-fix (LOW): the scalar keeps its PRE-3.6 MEANING.
  // Before this story the handler ended with `.orderBy("o.created_at","desc").first()`,
  // so `order_id` was the NEWEST order of the cart. Sorting the collection
  // ascending (for a stable, reproducible `orders`) and then taking `orders[0]`
  // silently flipped the scalar to the OLDEST order — a semantic change for
  // every pre-v1.15.0 storefront build, which is precisely the consumer this
  // scalar exists for. The two repos are separate submodules and deploy out of
  // step, so that consumer is real, not hypothetical.
  //
  // Collection order stays ascending; the scalar is taken from the END.
  const backwardCompatNewest = orders[orders.length - 1]

  res.json({
    orders,
    order_count: orders.length,
    expected_order_ids: expectedIds,
    open_order_ids: Array.from(new Set(openIds)),
    purchase_state: setsEqual && openIds.length === 0 ? "complete" : "incomplete",
    order_id: backwardCompatNewest.order_id,
    order_group_id: backwardCompatNewest.order_group_id,
  })
}
