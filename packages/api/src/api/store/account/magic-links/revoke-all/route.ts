import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import { PostgresMagicLinkStore } from "../../../../../lib/auth/magic-link-revocation"
import { marketContextStorage } from "../../../../../lib/market-context"

type AuthenticatedRequest = MedusaRequest & {
  auth_context?: {
    actor_id?: string
  }
}

function resolveCustomerId(req: MedusaRequest): string | null {
  const customerId = (req as AuthenticatedRequest).auth_context?.actor_id
  return typeof customerId === "string" && customerId.trim()
    ? customerId.trim()
    : null
}

function resolveDb(req: MedusaRequest): Knex | null {
  try {
    return req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  } catch {
    return null
  }
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const customerId = resolveCustomerId(req)
  if (!customerId) {
    res.status(401).json({
      code: "UNAUTHORIZED",
      message: "Authenticated customer session required",
    })
    return
  }

  const db = resolveDb(req)
  if (!db) {
    res.status(503).json({
      code: "PG_POOL_UNAVAILABLE",
      message: "Database connection unavailable",
    })
    return
  }

  const store = new PostgresMagicLinkStore(db)
  await store.revokePendingForCustomer({
    customer_id: customerId,
    market_id: marketContextStorage.getStore()?.market_id ?? null,
    reason: "user_revoke",
    revoked_by: customerId,
  })

  res.status(200).json({ success: true })
}
