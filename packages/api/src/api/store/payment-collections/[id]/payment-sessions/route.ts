import { createPaymentSessionsWorkflow } from "@medusajs/core-flows"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { refetchEntity } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  extractCheckoutIdempotencyKey,
  resolvePaymentSessionForCheckoutIdempotency,
} from "../../../../../lib/payment/checkout-idempotency"

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

type PaymentSessionBody = {
  provider_id: string
  data?: Record<string, unknown>
}

function readCartHash(data: Record<string, unknown> | undefined): string | null {
  const raw = data?.gp_checkout_cart_hash
  return typeof raw === "string" && raw.trim() ? raw.trim() : null
}

async function refetchPaymentCollection(
  id: string,
  scope: MedusaRequest["scope"],
  fields: string[]
) {
  return refetchEntity({
    entity: "payment_collection",
    idOrFilter: id,
    scope,
    fields,
  })
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

export const POST = async (
  req: MedusaRequest<PaymentSessionBody>,
  res: MedusaResponse
): Promise<void> => {
  const paymentCollectionId = req.params.id
  const { provider_id, data } = req.body
  const idempotencyKey = extractCheckoutIdempotencyKey(req.headers)
  const cartHash = readCartHash(data)

  const runCoreWorkflow = async () => {
    const workflowInput = {
      payment_collection_id: paymentCollectionId,
      provider_id,
      customer_id: (req as unknown as { auth_context?: { actor_id?: string } })
        .auth_context?.actor_id,
      data,
      context: {
        ...(data?.context && typeof data.context === "object" ? data.context : {}),
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        ...(idempotencyKey ? { gp_checkout_idempotency_uuid: idempotencyKey } : {}),
        ...(cartHash ? { gp_checkout_cart_hash: cartHash } : {}),
      },
    }

    const { result } = await createPaymentSessionsWorkflow(req.scope).run({
      input: workflowInput,
    })
    return result
  }

  if (idempotencyKey && cartHash) {
    const { client, release } = await resolvePgClient(req.scope)
    try {
      await resolvePaymentSessionForCheckoutIdempotency(client, {
        payment_collection_id: paymentCollectionId,
        idempotency_uuid: idempotencyKey,
        cart_hash: cartHash,
        createSession: runCoreWorkflow,
        getSessionId: (session) => session.id,
      })
    } finally {
      await release()
    }
  } else {
    await runCoreWorkflow()
  }

  const paymentCollection = await refetchPaymentCollection(
    paymentCollectionId,
    req.scope,
    req.queryConfig.fields
  )

  res.status(200).json({
    payment_collection: paymentCollection,
  })
}
