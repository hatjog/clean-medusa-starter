import { createPaymentSessionsWorkflow } from "@medusajs/core-flows"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { refetchEntity } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { marketContextStorage } from "../../../../../../../lib/market-context"
import {
  PaymentRetryConflictError,
  refreshPaymentSessionForRetry,
  type CreateRetrySessionInput,
  type PaymentRetryRefreshResult,
} from "../../../../../../../lib/payment/retry-refresh"

export const AUTHENTICATE = false

type PgClient = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Promise<{ rows: T[]; rowCount?: number | null }>
  release?: () => void
}

type PgPool = {
  connect: () => Promise<PgClient>
}

type KnexLike = {
  client?: {
    acquireConnection: () => Promise<{
      query: <T = Record<string, unknown>>(
        sql: string,
        params?: ReadonlyArray<unknown>
      ) => Promise<{ rows: T[]; rowCount?: number | null }>
    }>
    releaseConnection: (connection: unknown) => Promise<void>
  }
}

type AuthenticatedMedusaRequest = MedusaRequest & {
  auth_context?: {
    actor_id?: string
  }
}

type LoggerLike = {
  warn?: (message: string) => void
  error?: (message: string) => void
}

function resolveLogger(req: MedusaRequest): LoggerLike {
  try {
    return (req.scope.resolve("logger") as LoggerLike | undefined) ?? console
  } catch {
    return console
  }
}

async function resolvePgClient(
  scope: MedusaRequest["scope"]
): Promise<{ client: PgClient; release: () => Promise<void> }> {
  try {
    const pool = scope.resolve("__pg_pool__") as PgPool
    const client = await pool.connect()
    return {
      client,
      release: async () => client.release?.(),
    }
  } catch {
    const db = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as KnexLike
    if (!db.client?.acquireConnection || !db.client.releaseConnection) {
      throw new Error("PG_CONNECTION cannot provide a raw PostgreSQL connection")
    }

    const connection = await db.client.acquireConnection()
    return {
      client: connection,
      release: async () => {
        await db.client?.releaseConnection(connection)
      },
    }
  }
}

async function refetchPaymentCollection(
  id: string,
  scope: MedusaRequest["scope"],
  fields: string[] | undefined
) {
  return refetchEntity({
    entity: "payment_collection",
    idOrFilter: id,
    scope,
    fields: fields ?? ["*", "*payment_sessions", "+payment_sessions.data"],
  })
}

function extractClientSecret(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const object = value as Record<string, unknown>
  const data = object.data
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const clientSecret = (data as Record<string, unknown>).client_secret
    return typeof clientSecret === "string" && clientSecret.trim() ? clientSecret : null
  }
  return null
}

function serializeConflict(err: PaymentRetryConflictError) {
  return {
    type: err.code,
    message: err.publicMessage,
    retryable: false,
  }
}

export const POST = async (
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> => {
  const paymentCollectionId = req.params.id
  const customerId = (req as AuthenticatedMedusaRequest).auth_context?.actor_id
  const logger = resolveLogger(req)

  if (!paymentCollectionId || paymentCollectionId.trim().length === 0) {
    res.status(400).json({
      type: "invalid_request",
      message: "Payment collection ID is required",
    })
    return
  }

  if (!customerId) {
    res.status(401).json({
      type: "unauthorized",
      message: "Customer authentication required",
    })
    return
  }

  const marketContext = marketContextStorage.getStore()
  const { client, release } = await resolvePgClient(req.scope)
  let refreshResult: PaymentRetryRefreshResult<unknown>

  try {
    refreshResult = await refreshPaymentSessionForRetry(client, {
      paymentCollectionId,
      customerId,
      salesChannelId: marketContext?.sales_channel_id,
      createSession: async ({
        currentSession,
        idempotencyKey,
        retryCount,
      }: CreateRetrySessionInput) => {
        // v1.9.0 wf5 H-5 / F-CC1-006 fix: canonical Stripe provider id is
        // `pp_stripe` (matches `GP/config/gp-dev/markets/bonbeauty/market.yaml`
        // psp_provider_id and the resolver/storefront constants). The legacy
        // `pp_stripe_stripe` was a Mercur 2 / Medusa 2.13 naming hypothesis
        // disproven during Story 1.3 — using it as a fallback would create
        // an unregistered-provider AwilixResolutionError (C4 violation) on
        // null provider_id. Falling back to `pp_stripe` keeps the retry path
        // aligned with what `medusa-config.ts` registers + the additional
        // explicit log surfaces a data-corruption signal (null provider_id
        // on a session should not happen in normal operation).
        const providerId = currentSession.provider_id
        if (!providerId) {
          logger.warn?.(
            `[payment-retry-refresh] payment_session_id=${currentSession.id} ` +
              `has null provider_id — falling back to canonical 'pp_stripe' ` +
              `but this is a data-corruption signal; investigate`
          )
        }
        const { result } = await createPaymentSessionsWorkflow(req.scope).run({
          input: {
            payment_collection_id: paymentCollectionId,
            provider_id: providerId ?? "pp_stripe",
            customer_id: customerId,
            data: {
              gp_payment_retry: true,
              gp_previous_payment_session_id: currentSession.id,
            },
            context: {
              idempotency_key: idempotencyKey,
              gp_payment_retry: true,
              gp_payment_retry_count: retryCount,
              gp_payment_retry_idempotency_key: idempotencyKey,
              gp_previous_payment_session_id: currentSession.id,
            },
          },
        })
        return result
      },
    })
  } catch (err) {
    if (err instanceof PaymentRetryConflictError) {
      res.status(err.status).json(serializeConflict(err))
      return
    }

    const error = err as Error
    logger.error?.(`[payment-retry-refresh] failed class=${error.name}`)
    res.status(503).json({
      type: "service_unavailable",
      message: "Payment retry is temporarily unavailable",
    })
    return
  } finally {
    await release()
  }

  const paymentCollection = await refetchPaymentCollection(
    paymentCollectionId,
    req.scope,
    req.queryConfig?.fields
  )

  res.status(200).json({
    payment_collection: paymentCollection,
    payment_session: refreshResult.payment_session,
    client_secret: extractClientSecret(refreshResult.payment_session),
    retry: {
      retry_count: refreshResult.retry_count,
      idempotency_key: refreshResult.idempotency_key,
      payment_session_id: refreshResult.payment_session_id,
      previous_payment_session_id: refreshResult.previous_payment_session_id,
    },
  })
}
