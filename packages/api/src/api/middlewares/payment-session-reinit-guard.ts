/**
 * payment-session-reinit-guard.ts — v1.16.0 Story 8.3 (FR-15, AD-18, NFR-4).
 *
 * `POST /store/payment-collections/:id/payment-sessions` runs Medusa's
 * `createPaymentSessionsWorkflow`, which DELETES the existing session and
 * creates a NEW PaymentIntent. After an interrupted 3DS return the buyer
 * retries the purchase; if the first PaymentIntent is already charged (or
 * still `processing`), a new PaymentIntent is a second charge for the same
 * purchase. This guard refuses that visibly:
 *
 *  - `409 payment_intent_in_flight` (+ `payment_intent_ids`) — retry must go
 *    through completion of the EXISTING intent (the PSP authority middleware
 *    lets a terminal intent complete), never through a new one;
 *  - `503 psp_status_unavailable` — the PSP state could not be read; without
 *    proof that nothing is charged no replacement is created (fail closed).
 *
 * Collections without a Stripe session pass through untouched.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { marketContextStorage } from "../../lib/market-context"
import { inFlightPaymentIntentIds } from "../../lib/payment/payment-charge-fact"
import {
  defaultReadQuery,
  defaultRetrievePaymentIntentStatusForMarket,
  type PspAuthorityReadQuery,
} from "./cart-completion-psp-authority"

export const COLLECTION_STRIPE_PAYMENT_INTENTS_SQL = `SELECT DISTINCT ps.data->>'id' AS payment_intent_id
  FROM payment_session ps
 WHERE ps.payment_collection_id = $1
   AND ps.deleted_at IS NULL
   AND ps.provider_id LIKE 'pp_stripe%'
   AND ps.data->>'id' LIKE 'pi\\_%'`

export const PAYMENT_SESSION_REINIT_REFUSED = "gp.payment_session.reinit_refused"

export type PaymentSessionReinitGuardDeps = {
  readQuery: PspAuthorityReadQuery
  retrievePaymentIntentStatus: (input: {
    scope: MedusaRequest["scope"]
    paymentIntentId: string
    marketId: string | null
  }) => Promise<string>
}

type LoggerLike = { warn?: (msg: string) => void }

function logger(scope: MedusaRequest["scope"]): LoggerLike {
  try {
    return (scope as unknown as { resolve: (k: string) => unknown }).resolve("logger") as LoggerLike
  } catch {
    return console
  }
}

export function createPaymentSessionReinitGuard(
  deps: PaymentSessionReinitGuardDeps = {
    readQuery: defaultReadQuery,
    retrievePaymentIntentStatus: defaultRetrievePaymentIntentStatusForMarket,
  }
) {
  return async function paymentSessionReinitGuard(
    req: MedusaRequest,
    res: MedusaResponse,
    next: (err?: unknown) => void
  ): Promise<void> {
    const collectionId = (req.params as Record<string, string> | undefined)?.id
    if (!collectionId) {
      next()
      return
    }
    let intentIds: string[]
    try {
      const rows = await deps.readQuery(req.scope, COLLECTION_STRIPE_PAYMENT_INTENTS_SQL, [collectionId])
      intentIds = rows
        .map(r => r.payment_intent_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    } catch (err) {
      next(err)
      return
    }
    if (intentIds.length === 0) {
      next()
      return
    }
    const marketId = marketContextStorage.getStore()?.market_id ?? null
    let statuses: string[]
    try {
      statuses = await Promise.all(
        intentIds.map(paymentIntentId =>
          deps.retrievePaymentIntentStatus({ scope: req.scope, paymentIntentId, marketId })
        )
      )
    } catch (err) {
      logger(req.scope).warn?.(
        `${PAYMENT_SESSION_REINIT_REFUSED} collection=${collectionId} cause=psp_status_unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      res.status(503).json({
        type: "psp_status_unavailable",
        code: "psp_status_unavailable",
        message: "Payment status could not be verified; a new payment is not created",
      })
      return
    }
    const inFlight = inFlightPaymentIntentIds(intentIds, statuses)
    if (inFlight.length > 0) {
      logger(req.scope).warn?.(
        `${PAYMENT_SESSION_REINIT_REFUSED} collection=${collectionId} cause=payment_intent_in_flight intents=${inFlight.join(",")}`
      )
      res.status(409).json({
        type: "payment_intent_in_flight",
        code: "payment_intent_in_flight",
        message: "An existing payment is charged or in progress; complete it instead of paying again",
        payment_intent_ids: inFlight,
      })
      return
    }
    next()
  }
}

export const paymentSessionReinitGuardMiddleware = createPaymentSessionReinitGuard()
