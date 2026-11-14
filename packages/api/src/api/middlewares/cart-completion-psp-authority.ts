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
 *     the cart id is held on a DEDICATED `pg.Client` (opened from the
 *     database URL, NOT borrowed from the shared `PG_CONNECTION` Knex pool
 *     the saga itself needs) until the completion handler ends the response.
 *     Fix round 1 (review 8.2): borrowing from the saga pool let ~10 parallel
 *     completions exhaust it (Medusa default `pool.max` = 10) while each
 *     saga waited for a connection — deadlock until `acquireTimeout`.
 *     The lock is taken only once a Stripe session is established; a failed
 *     unlock destroys the connection (named log) instead of reusing it; a
 *     client disconnect (`close`) does NOT release the fence while the saga
 *     still runs — only the handler ending the response (or a named ceiling).
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
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { Client as PgClient } from "pg"
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

export type PspAuthorityConnection = {
  client: QueryClient
  /** `destroy: true` = the session may still hold the lock; never reuse it. */
  release: (opts?: { destroy?: boolean }) => void | Promise<void>
}

type LoggerLike = { error?: (msg: string) => void; warn?: (msg: string) => void }

export type PspAuthorityDeps = {
  acquireConnection: (scope: MedusaRequest["scope"]) => Promise<PspAuthorityConnection | null>
  retrievePaymentIntentStatus: (input: {
    scope: MedusaRequest["scope"]
    paymentIntentId: string
    marketId: string | null
  }) => Promise<string>
  /** Ceiling for a fence whose client disconnected before the handler ended. */
  orphanLockCeilingMs?: number
}

/** Advisory lock key namespace; hashed with the cart id inside PostgreSQL. */
export const CART_COMPLETE_LOCK_NAMESPACE = "gp.cart_complete:"

export const TRY_LOCK_SQL =
  "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked"
export const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked"

/** Named log events of the fence lifecycle. */
export const PSP_AUTHORITY_UNLOCK_FAILED = "gp.cart_complete.unlock_failed"
export const PSP_AUTHORITY_ORPHAN_CEILING = "gp.cart_complete.orphan_lock_ceiling"

/** Default ceiling (ms) after a client disconnect; saga normally ends far earlier. */
export const DEFAULT_ORPHAN_LOCK_CEILING_MS = 10 * 60 * 1000

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

/**
 * Database URL for the dedicated fence connection: the same database the
 * framework uses (`projectConfig.databaseUrl`), falling back to the env.
 */
export function resolveFenceDatabaseUrl(scope: MedusaRequest["scope"]): string | null {
  try {
    const config = (scope as unknown as { resolve: (k: string) => unknown }).resolve(
      ContainerRegistrationKeys.CONFIG_MODULE
    ) as { projectConfig?: { databaseUrl?: unknown } } | undefined
    const url = config?.projectConfig?.databaseUrl
    if (typeof url === "string" && url.length > 0) return url
  } catch {
    // CONFIG_MODULE not registered in this scope: fall through to the env value.
    return process.env.DATABASE_URL || null
  }
  return process.env.DATABASE_URL || null
}

/**
 * Dedicated connection OUTSIDE the saga pool. One short-lived `pg.Client`
 * per completion: it cannot starve `PG_CONNECTION`, and ending it always
 * drops any session lock with it (so `destroy` and normal release coincide).
 */
export async function openDedicatedPgConnection(
  connectionString: string
): Promise<PspAuthorityConnection> {
  const client = new PgClient({ connectionString })
  await client.connect()
  let ended = false
  return {
    client: client as unknown as QueryClient,
    release: async () => {
      if (ended) return
      ended = true
      await client.end().catch(() => {
        // Ending a broken socket: PostgreSQL drops the session (and its locks).
        client.removeAllListeners()
      })
    },
  }
}

export async function defaultAcquireConnection(
  scope: MedusaRequest["scope"]
): Promise<PspAuthorityConnection | null> {
  const url = resolveFenceDatabaseUrl(scope)
  if (!url) return null
  return openDedicatedPgConnection(url)
}

const defaultDeps: PspAuthorityDeps = {
  acquireConnection: defaultAcquireConnection,
  retrievePaymentIntentStatus: defaultRetrievePaymentIntentStatus,
}

function resolveLogger(scope: MedusaRequest["scope"]): LoggerLike {
  try {
    return (scope as unknown as { resolve: (k: string) => unknown }).resolve("logger") as LoggerLike
  } catch {
    return console
  }
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
  const ceilingMs = deps.orphanLockCeilingMs ?? DEFAULT_ORPHAN_LOCK_CEILING_MS
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

    let handle: PspAuthorityConnection | null = null
    try {
      handle = await deps.acquireConnection(req.scope)
    } catch {
      handle = null
    }
    if (!handle) {
      refuse(res, 503, "psp_authority_unavailable", "Cart completion authority unavailable")
      return
    }
    const conn = handle

    const lockKey = `${CART_COMPLETE_LOCK_NAMESPACE}${cartId}`
    let locked = false
    let released = false
    const releaseAll = async () => {
      if (released) return
      released = true
      let destroy = false
      if (locked) {
        try {
          await conn.client.query(UNLOCK_SQL, [lockKey])
        } catch (err) {
          destroy = true
          resolveLogger(req.scope).error?.(
            `${PSP_AUTHORITY_UNLOCK_FAILED} cart=${cartId}: ${
              err instanceof Error ? err.message : String(err)
            } — connection destroyed, not reused`
          )
        }
      }
      try {
        await conn.release(destroy ? { destroy: true } : undefined)
      } catch (err) {
        resolveLogger(req.scope).error?.(
          `${PSP_AUTHORITY_UNLOCK_FAILED} cart=${cartId}: release failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }

    try {
      const completed = await conn.client.query(CART_HAS_ORDER_SQL, [cartId])
      if (completed.rows.length > 0) {
        // Idempotent path: existing order, no PSP read, no fence.
        await releaseAll()
        next()
        return
      }
      const sessions = await conn.client.query(CART_STRIPE_PAYMENT_INTENTS_SQL, [cartId])
      const intentIds = sessions.rows
        .map(row => row.payment_intent_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
      if (intentIds.length === 0) {
        // No Stripe session: other providers keep their path, no lock taken.
        await releaseAll()
        next()
        return
      }

      const lockRows = await conn.client.query(TRY_LOCK_SQL, [lockKey])
      locked = lockRows.rows[0]?.locked === true
      if (!locked) {
        await releaseAll()
        refuse(res, 409, "completion_in_progress", "Cart completion already in progress")
        return
      }

      // Re-check under the fence: a concurrent saga may have just finished.
      const completedUnderLock = await conn.client.query(CART_HAS_ORDER_SQL, [cartId])
      if (completedUnderLock.rows.length === 0) {
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
    } catch (err) {
      await releaseAll()
      next(err)
      return
    }

    // Hold the fence until the completion handler (or the error handler) ends
    // the response — that is after the saga. `res.end` is called even when the
    // client already disconnected, so `close` alone does not release; it only
    // arms a named ceiling in case the handler never ends the response.
    const resAny = res as unknown as {
      end?: (...args: unknown[]) => unknown
      on: (event: string, cb: () => void) => unknown
    }
    const originalEnd = resAny.end
    if (typeof originalEnd === "function") {
      resAny.end = function patchedEnd(this: unknown, ...args: unknown[]) {
        const out = originalEnd.apply(this, args)
        void releaseAll()
        return out
      }
    }
    resAny.on("finish", () => void releaseAll())
    resAny.on("close", () => {
      if (released) return
      const timer = setTimeout(() => {
        if (released) return
        resolveLogger(req.scope).warn?.(
          `${PSP_AUTHORITY_ORPHAN_CEILING} cart=${cartId}: handler did not end the response within ${ceilingMs}ms after client disconnect — releasing fence`
        )
        void releaseAll()
      }, ceilingMs)
      ;(timer as { unref?: () => void }).unref?.()
    })
    next()
  }
}

export const cartCompletionPspAuthorityMiddleware = createCartCompletionPspAuthorityMiddleware()
