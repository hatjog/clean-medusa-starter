import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import {
  PostgresMagicLinkStore,
  isValidMagicLinkJti,
} from "../../../../../lib/auth/magic-link-revocation"
import {
  hashSellerId,
  lookupSellerJti,
} from "../../../../../lib/auth/magic-link-seller-scope"
import { InMemoryTokenBucketAdapter } from "../../../../../lib/rate-limit-token-bucket"

type VendorAuthContext = {
  actor_id?: string
  actor_type?: string
}

type RevokeAuditOutcome =
  | "revoked"
  | "rejected_cross_tenant"
  | "rejected_jti_invalid"
  | "rejected_rate_limited"

type LoggerLike = {
  info?: (message: string, context?: Record<string, unknown>) => void
  warn?: (message: string, context?: Record<string, unknown>) => void
}

type ResponseWithHeaders = MedusaResponse & {
  setHeader?: (name: string, value: string) => void
}

type RateLimitAdapter = {
  consume(args: {
    bucket_key: string
    bucket_size: number
    refill_per_min: number
  }): Promise<{ allowed: boolean; retry_after_ms: number }>
}

const RATE_LIMIT_BUCKET_SIZE = 3
const RATE_LIMIT_REFILL_PER_MIN = 3
const RATE_LIMIT_PREFIX = "magic-link-revoke:jti:"

let rateLimiter = new InMemoryTokenBucketAdapter()

export function __setMagicLinkRevokeRateLimiterForTests(
  adapter: InMemoryTokenBucketAdapter
): void {
  rateLimiter = adapter
}

function resolveDb(req: MedusaRequest): Knex | null {
  try {
    return req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  } catch {
    return null
  }
}

function resolveLogger(req: MedusaRequest): LoggerLike {
  try {
    return (req.scope.resolve("logger") as LoggerLike | undefined) ?? console
  } catch {
    return console
  }
}

function resolveRateLimiter(req: MedusaRequest): RateLimitAdapter {
  try {
    const resolved = req.scope.resolve("rate_limit_token_bucket") as
      | RateLimitAdapter
      | undefined
    return typeof resolved?.consume === "function" ? resolved : rateLimiter
  } catch {
    return rateLimiter
  }
}

function resolveSellerId(req: MedusaRequest): string | null {
  const authContext = (req as MedusaRequest & { auth_context?: VendorAuthContext })
    .auth_context
  if (authContext?.actor_type !== "seller") {
    return null
  }

  const actorId = authContext.actor_id?.trim()
  return actorId || null
}

function resolveBody(req: MedusaRequest): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {}
}

function recordAudit(
  req: MedusaRequest,
  input: {
    outcome: RevokeAuditOutcome
    jti: string
    seller_id: string
    current_session_revoke?: boolean
    subject_seller_id_hashed?: string
  }
): void {
  resolveLogger(req).info?.("[magic-link-revoke] audit", {
    event: "magic_link_revoke",
    actor_type: "vendor",
    seller_id: input.seller_id,
    token_jti: input.jti,
    outcome: input.outcome,
    current_session_revoke: input.current_session_revoke ?? false,
    subject_seller_id_hashed: input.subject_seller_id_hashed,
  })
}

async function consumeRateLimit(
  req: MedusaRequest,
  jti: string
): Promise<{
  allowed: boolean
  retry_after_seconds: number
}> {
  const result = await resolveRateLimiter(req).consume({
    bucket_key: `${RATE_LIMIT_PREFIX}${jti}`,
    bucket_size: RATE_LIMIT_BUCKET_SIZE,
    refill_per_min: RATE_LIMIT_REFILL_PER_MIN,
  })

  return {
    allowed: result.allowed,
    retry_after_seconds: Math.max(1, Math.ceil(result.retry_after_ms / 1000)),
  }
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const jti = (req.params as { jti?: string })?.jti ?? ""
  const sellerId = resolveSellerId(req)

  if (!isValidMagicLinkJti(jti)) {
    if (sellerId) {
      recordAudit(req, {
        outcome: "rejected_jti_invalid",
        jti,
        seller_id: sellerId,
      })
    }
    res.status(400).json({ code: "INVALID_JTI" })
    return
  }

  if (!sellerId) {
    res.status(401).json({ code: "UNAUTHORIZED" })
    return
  }

  const rateLimit = await consumeRateLimit(req, jti)
  if (!rateLimit.allowed) {
    recordAudit(req, {
      outcome: "rejected_rate_limited",
      jti,
      seller_id: sellerId,
    })
    const responseWithHeaders = res as ResponseWithHeaders
    responseWithHeaders.setHeader?.(
      "Retry-After",
      String(rateLimit.retry_after_seconds)
    )
    res.status(429).json({
      code: "RATE_LIMITED",
      retry_after_seconds: rateLimit.retry_after_seconds,
    })
    return
  }

  const body = resolveBody(req)
  if (body.confirm !== true) {
    res.status(400).json({ code: "CONFIRM_REQUIRED" })
    return
  }

  const db = resolveDb(req)
  if (!db) {
    res.status(503).json({ code: "PG_POOL_UNAVAILABLE" })
    return
  }

  const currentSessionRevoke = body.current_session === true
  const lookup = await lookupSellerJti(db, jti)
  const subjectSellerId = lookup.subject_seller_id
  const rejectedOutcome =
    lookup.found && subjectSellerId !== sellerId
      ? "rejected_cross_tenant"
      : "rejected_jti_invalid"

  if (!lookup.found || subjectSellerId !== sellerId) {
    recordAudit(req, {
      outcome: rejectedOutcome,
      jti,
      seller_id: sellerId,
      current_session_revoke: currentSessionRevoke,
      subject_seller_id_hashed:
        subjectSellerId && subjectSellerId !== sellerId
          ? hashSellerId(subjectSellerId)
          : undefined,
    })
    res.status(403).json({
      reason:
        rejectedOutcome === "rejected_cross_tenant"
          ? "cross_tenant"
          : "jti_not_found",
    })
    return
  }

  const store = new PostgresMagicLinkStore(db)
  await store.revokeJti({
    token_jti: jti,
    reason: "seller_revoke",
    revoked_by: sellerId,
    actor_type: "seller",
  })

  const revokedAt = new Date().toISOString()
  recordAudit(req, {
    outcome: "revoked",
    jti,
    seller_id: sellerId,
    current_session_revoke: currentSessionRevoke,
  })
  res.status(200).json({ revoked_at: revokedAt })
}
