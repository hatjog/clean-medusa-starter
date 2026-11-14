/**
 * cart-completion-psp-authority.ts (middleware) — v1.16.0 Story 8.2
 * (FR-15, AD-18, ADR-233, DW-15-236).
 *
 * `POST /store/carts/:id/complete` on the 3DS return path used to be gated
 * by two carriers that prove nothing:
 *   * `redirect_status=succeeded` in the storefront URL — browser input;
 *   * a process-local `Map` in the storefront — invisible to a second worker
 *     and gone after a restart.
 *
 * ADR-233 moves both decisions to the backend, which owns the Stripe secret
 * and the database:
 *
 *  1. PSP authority. Before completion we READ the PaymentIntent from Stripe
 *     with the market secret. Only `succeeded` / `requires_capture` let the
 *     request through. Anything else is a VISIBLE refusal
 *     (`409 payment_not_terminal`), never a silent pass. A Stripe read that
 *     fails is `503 psp_status_unavailable` — no finalization without proof.
 *  2. Cross-instance fence. A session-level PostgreSQL advisory lock keyed by
 *     the cart id is held on a dedicated connection for the whole request.
 *     A second concurrent `complete` for the same cart — from ANY process —
 *     gets `409 completion_in_progress` instead of a second saga.
 *  3. Durable idempotency. Once the cart has a live order (`order_cart`
 *     link), the request passes straight to the framework handler, which
 *     returns the existing order; the PSP is not consulted again. The
 *     durable key is therefore the cart id and its `order_cart` row in the
 *     database — it survives restarts, unlike the storefront `Map`. No new
 *     table: migrations in this batch belong to Story 3.3 (D-35 p.16).
 *
 * Carts without a Stripe payment session are untouched (other providers keep
 * their existing path).
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { marketContextStorage } from "../../lib/market-context"
import type { MarketId } from "../../lib/secrets/index"
import { acquireFreshPgConnection } from "../../lib/payment/stripe-payment-intent-transport"
import {
  DEFAULT_MARKET_ID,
  resolveMarketStripeCredentials,
  resolveSecretsAdapter,
  type MaybeSecretsCradle,
} from "../../modules/payment-stripe-multi-market/resolve-stripe-options"

/** PaymentIntent states that prove the money side is settled for completion. */
export const PSP_TERMINAL_SUCCESS_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "requires_capture",
])

export type PspAuthorityRefusal =
  | "payment_not_terminal"
  | "psp_status_unavailable"
  | "completion_in_progress"
  | "psp_authority_unavailable"

type QueryClient = {
  query: (
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Promise<{ rows: Array<Record<string, unknown>> }>
}

export type PspAuthorityDeps = {
  acquireConnection: (scope: MedusaRequest["scope"]) => Promise<{
    client: QueryClient
    release: () => void
  } | null>
  retrievePaymentIntentStatus: (input: {
    scope: MedusaRequest["scope"]
    paymentIntentId: string
    marketId: string | null
  }) => Promise<string>
}

/** Advisory lock key namespace; hashed with the cart id inside PostgreSQL. */
export const CART_COMPLETE_LOCK_NAMESPACE = "gp.cart_complete:"

export const TRY_LOCK_SQL =
  "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked"
export const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked"

export const CART_HAS_ORDER_SQL = `SELECT 1
  FROM order_cart oc
  JOIN "order" o ON o.id = oc.order_id AND o.deleted_at IS NULL
 WHERE oc.cart_id = $1 AND oc.deleted_at IS NULL
 LIMIT 1`

export const CART_STRIPE_PAYMENT_INTENTS_SQL = `SELECT DISTINCT ps.data->>'id' AS payment_intent_id
  FROM cart_payment_collection cpc
  JOIN payment_session ps
    ON ps.payment_collection_id = cpc.payment_collection_id
   AND ps.deleted_at IS NULL
 WHERE cpc.cart_id = $1
   AND cpc.deleted_at IS NULL
   AND ps.provider_id LIKE 'pp_stripe%'
   AND ps.data->>'id' LIKE 'pi\\_%'`

async function defaultRetrievePaymentIntentStatus(input: {
  scope: MedusaRequest["scope"]
  paymentIntentId: string
  marketId: string | null
}): Promise<string> {
  const adapter = resolveSecretsAdapter(
    ((input.scope as unknown as { cradle?: MaybeSecretsCradle }).cradle ??
      {}) as MaybeSecretsCradle
  )
  const marketId = (input.marketId ?? DEFAULT_MARKET_ID) as MarketId
  const { apiKey } = await resolveMarketStripeCredentials(adapter, marketId)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const StripeCtor = require("stripe").default || require("stripe")
  const stripe = new StripeCtor(apiKey)
  const intent = (await stripe.paymentIntents.retrieve(input.paymentIntentId)) as {
    status?: unknown
  }
  return typeof intent?.status === "string" ? intent.status : "unknown"
}

const defaultDeps: PspAuthorityDeps = {
  acquireConnection: scope =>
    acquireFreshPgConnection(scope) as ReturnType<PspAuthorityDeps["acquireConnection"]>,
  retrievePaymentIntentStatus: defaultRetrievePaymentIntentStatus,
}

function refuse(
  res: MedusaResponse,
  status: number,
  type: PspAuthorityRefusal,
  message: string
): void {
  res.status(status).json({ type, code: type, message })
}

export function createCartCompletionPspAuthorityMiddleware(deps: PspAuthorityDeps = defaultDeps) {
  return async function cartCompletionPspAuthorityMiddleware(
    req: MedusaRequest,
    res: MedusaResponse,
    next: (err?: unknown) => void
  ): Promise<void> {
    const cartId = (req.params as Record<string, string> | undefined)?.id
    if (!cartId) {
      next()
      return
    }

    let handle: Awaited<ReturnType<PspAuthorityDeps["acquireConnection"]>> = null
    try {
      handle = await deps.acquireConnection(req.scope)
    } catch {
      handle = null
    }
    if (!handle) {
      refuse(res, 503, "psp_authority_unavailable", "Cart completion authority unavailable")
      return
    }

    const lockKey = `${CART_COMPLETE_LOCK_NAMESPACE}${cartId}`
    let locked = false
    let released = false
    const releaseAll = async () => {
      if (released) return
      released = true
      try {
        if (locked) {
          await handle!.client.query(UNLOCK_SQL, [lockKey])
        }
      } catch {
        /* connection is released below; PostgreSQL drops session locks with it */
      } finally {
        handle!.release()
      }
    }

    try {
      const lockRows = await handle.client.query(TRY_LOCK_SQL, [lockKey])
      locked = lockRows.rows[0]?.locked === true
      if (!locked) {
        await releaseAll()
        refuse(res, 409, "completion_in_progress", "Cart completion already in progress")
        return
      }

      const completed = await handle.client.query(CART_HAS_ORDER_SQL, [cartId])
      if (completed.rows.length === 0) {
        const sessions = await handle.client.query(CART_STRIPE_PAYMENT_INTENTS_SQL, [cartId])
        const intentIds = sessions.rows
          .map(row => row.payment_intent_id)
          .filter((id): id is string => typeof id === "string" && id.length > 0)

        if (intentIds.length > 0) {
          const marketId = marketContextStorage.getStore()?.market_id ?? null
          let statuses: string[]
          try {
            statuses = await Promise.all(
              intentIds.map(paymentIntentId =>
                deps.retrievePaymentIntentStatus({ scope: req.scope, paymentIntentId, marketId })
              )
            )
          } catch {
            await releaseAll()
            refuse(res, 503, "psp_status_unavailable", "Payment status could not be verified")
            return
          }
          if (!statuses.some(status => PSP_TERMINAL_SUCCESS_STATUSES.has(status))) {
            await releaseAll()
            refuse(res, 409, "payment_not_terminal", "Payment is not confirmed by the provider")
            return
          }
        }
      }
    } catch (err) {
      await releaseAll()
      next(err)
      return
    }

    // Hold the fence for the whole completion saga; release on any end.
    res.on("finish", () => void releaseAll())
    res.on("close", () => void releaseAll())
    next()
  }
}

export const cartCompletionPspAuthorityMiddleware = createCartCompletionPspAuthorityMiddleware()
