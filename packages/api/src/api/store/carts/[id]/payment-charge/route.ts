/**
 * GET /store/carts/:id/payment-charge — v1.16.0 Story 8.3 (FR-15, AD-18, ADR-233).
 *
 * Read-only answer to "was the money taken?" for an interrupted 3DS return.
 * The PaymentIntents of the cart are read from Stripe on the backend; the
 * storefront never decides this from `redirect_status`. A failed read is
 * `charge: "unknown"` (HTTP 200 with a named reason), never `not_charged`.
 * The cart id is the bearer (same convention as `completed-order`).
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { marketContextStorage } from "../../../../../lib/market-context"
import { classifyPaymentCharge } from "../../../../../lib/payment/payment-charge-fact"
import {
  CART_HAS_ORDER_SQL,
  CART_STRIPE_PAYMENT_INTENTS_SQL,
  defaultReadQuery,
  defaultRetrievePaymentIntentStatusForMarket,
  type PspAuthorityReadQuery,
} from "../../../../middlewares/cart-completion-psp-authority"

export const AUTHENTICATE = false

export type PaymentChargeReadDeps = {
  readQuery: PspAuthorityReadQuery
  retrievePaymentIntentStatus: typeof defaultRetrievePaymentIntentStatusForMarket
}

type LoggerLike = { warn: (msg: string) => void }

function resolveLogger(req: MedusaRequest): LoggerLike {
  try {
    return (req.scope.resolve("logger") as LoggerLike | undefined) ?? console
  } catch {
    return console
  }
}

export async function handlePaymentChargeRead(
  req: MedusaRequest,
  res: MedusaResponse,
  deps: PaymentChargeReadDeps = {
    readQuery: defaultReadQuery,
    retrievePaymentIntentStatus: defaultRetrievePaymentIntentStatusForMarket,
  }
): Promise<void> {
  const cartId = (req.params as { id?: string }).id
  if (!cartId || !cartId.startsWith("cart_")) {
    res.status(400).json({ code: "cart_id_invalid", message: "cart id required" })
    return
  }
  let intentIds: string[]
  let orderExists: boolean
  try {
    orderExists = (await deps.readQuery(req.scope, CART_HAS_ORDER_SQL, [cartId])).length > 0
    intentIds = (await deps.readQuery(req.scope, CART_STRIPE_PAYMENT_INTENTS_SQL, [cartId]))
      .map(r => r.payment_intent_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  } catch (err) {
    // Story 8.3 fix R-4: unauthenticated route — the DB error detail goes to the
    // logger (error name/message only, no query parameters), never to the body.
    resolveLogger(req).warn(
      `[payment-charge] charge_read_failed cart=${cartId} error=${
        err instanceof Error ? `${err.name}: ${err.message}` : "non_error_thrown"
      }`
    )
    res.status(503).json({
      charge: "unknown",
      reason: "charge_read_failed",
      code: "charge_read_failed",
      message: "charge read failed",
    })
    return
  }
  const marketId = marketContextStorage.getStore()?.market_id ?? null
  let statuses: string[] | null
  try {
    statuses = await Promise.all(
      intentIds.map(paymentIntentId =>
        deps.retrievePaymentIntentStatus({ scope: req.scope, paymentIntentId, marketId })
      )
    )
  } catch {
    statuses = null
  }
  const { charge, reason } = classifyPaymentCharge(statuses)
  res.status(200).json({
    cart_id: cartId,
    charge,
    reason,
    order_exists: orderExists,
    payment_intent_ids: intentIds,
  })
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  await handlePaymentChargeRead(req, res)
}
