import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import {
  PostgresMagicLinkStore,
  isValidMagicLinkJti,
} from "../../../../../lib/auth/magic-link-revocation"
import { extractActorIdOrThrow } from "../../../../../lib/capability-check"

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
  const jti = (req.params as { jti?: string })?.jti ?? ""
  if (!isValidMagicLinkJti(jti)) {
    res.status(400).json({
      code: "INVALID_JTI",
      message: "jti must be a valid UUID",
    })
    return
  }

  let adminUserId: string
  try {
    adminUserId = extractActorIdOrThrow(req)
  } catch {
    res.status(401).json({
      code: "UNAUTHORIZED",
      message: "Valid admin session required",
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
  await store.revokeJti({
    token_jti: jti,
    reason: "admin_revoke",
    revoked_by: adminUserId,
  })

  res.status(200).json({ success: true })
}
