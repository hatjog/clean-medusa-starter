import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"
import { z } from "zod"

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
  info: (message: string, context?: Record<string, unknown>) => void
  warn?: (message: string, context?: Record<string, unknown>) => void
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

// Fallback adapter for environments where the container does not expose a
// shared `rate_limit_token_bucket` (eg. dev/test runs without redis).
// Tests inject their own adapter via the scope resolver so each suite gets
// explicit control over bucket state.
const FALLBACK_RATE_LIMITER = new InMemoryTokenBucketAdapter()

const RevokeBodySchema = z
  .object({
    confirm: z.literal(true),
    current_session: z.boolean().optional(),
  })
  .strict()

function resolveDb(req: MedusaRequest): Knex | null {
  try {
    return req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  } catch {
    return null
  }
}

function resolveLogger(req: MedusaRequest): LoggerLike {
  try {
    const resolved = req.scope.resolve("logger") as LoggerLike | undefined
    if (resolved && typeof resolved.info === "function") {
      return resolved
    }
  } catch {
    // fall through to console
  }
  return console as unknown as LoggerLike
}

function resolveRateLimiter(req: MedusaRequest): RateLimitAdapter {
  try {
    const resolved = req.scope.resolve("rate_limit_token_bucket") as
      | RateLimitAdapter
      | undefined
    return typeof resolved?.consume === "function"
      ? resolved
      : FALLBACK_RATE_LIMITER
  } catch {
    return FALLBACK_RATE_LIMITER
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

function recordAudit(
  req: MedusaRequest,
  input: {
    outcome: RevokeAuditOutcome
    jti: string
    seller_id: string
    current_session_revoke?: boolean
    subject_seller_id_hashed?: string | null
  }
): void {
  // `info` is required on LoggerLike — no optional chain so a missing
  // method is a loud failure instead of a silent audit drop.
  resolveLogger(req).info("[magic-link-revoke] audit", {
    event: "magic_link_revoke",
    actor_type: "vendor",
    seller_id: input.seller_id,
    token_jti: input.jti,
    outcome: input.outcome,
    current_session_revoke: input.current_session_revoke ?? false,
    // Always emit the key (null when not applicable) so dashboards can
    // rely on a stable envelope schema regardless of outcome.
    subject_seller_id_hashed: input.subject_seller_id_hashed ?? null,
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

  // Require seller authentication before exposing JTI validity status.
  if (!sellerId) {
    res.status(401).json({ code: "UNAUTHORIZED" })
    return
  }

  if (!isValidMagicLinkJti(jti)) {
    recordAudit(req, {
      outcome: "rejected_jti_invalid",
      jti,
      seller_id: sellerId,
    })
    res.status(400).json({ code: "INVALID_JTI" })
    return
  }

  // Strict body validation: rejects non-boolean fields and extraneous keys.
  // Body check sits BEFORE rate-limit consume so a `{confirm:false}` spam
  // from an authenticated bystander cannot DoS the legit owner's bucket.
  const parsedBody = RevokeBodySchema.safeParse(req.body)
  if (!parsedBody.success) {
    res.status(400).json({ code: "CONFIRM_REQUIRED" })
    return
  }
  const currentSessionRevoke = parsedBody.data.current_session === true

  const rateLimit = await consumeRateLimit(req, jti)
  if (!rateLimit.allowed) {
    recordAudit(req, {
      outcome: "rejected_rate_limited",
      jti,
      seller_id: sellerId,
      current_session_revoke: currentSessionRevoke,
    })
    // Express alias on MedusaResponse — typed, no defensive cast needed.
    res.set("Retry-After", String(rateLimit.retry_after_seconds))
    res.status(429).json({
      code: "RATE_LIMITED",
      retry_after_seconds: rateLimit.retry_after_seconds,
    })
    return
  }

  const db = resolveDb(req)
  if (!db) {
    res.status(503).json({ code: "PG_POOL_UNAVAILABLE" })
    return
  }

  const lookup = await lookupSellerJti(db, jti)
  const subjectSellerId = lookup.subject_seller_id

  // ADR-112 constant-time invariant: always run the SHA-256 hash so the
  // `found:false` and `found:true,mismatch` paths share identical CPU work
  // before branching on the outcome. Hash output is only surfaced in the
  // cross-tenant audit envelope; otherwise the computed value is discarded.
  const hashedSubject = hashSellerId(subjectSellerId ?? "")
  const matchedOwner = lookup.found && subjectSellerId === sellerId

  if (!matchedOwner) {
    const isCrossTenant =
      lookup.found && subjectSellerId !== null && subjectSellerId !== sellerId
    recordAudit(req, {
      outcome: isCrossTenant ? "rejected_cross_tenant" : "rejected_jti_invalid",
      jti,
      seller_id: sellerId,
      current_session_revoke: currentSessionRevoke,
      // PII minimisation: only expose hashed subject for true cross-tenant
      // attempts; jti_not_found uses the audit-envelope null sentinel.
      subject_seller_id_hashed: isCrossTenant ? hashedSubject : null,
    })
    // Story D-117 SSOT explicitly enumerates both reasons; the constant-time
    // mitigation lives in the CPU path above (always-on hash), not in the
    // response body — operators need the distinct reason to triage support
    // tickets vs cross-tenant probes.
    res.status(403).json({
      reason: isCrossTenant ? "cross_tenant" : "jti_not_found",
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
