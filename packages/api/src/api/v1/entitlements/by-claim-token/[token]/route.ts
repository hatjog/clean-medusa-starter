/**
 * GET /api/v1/entitlements/by-claim-token/:token — v1.9.0 Wave F6 / HIGH-04.
 *
 * Resolves a public claim_token to entitlement + voucher metadata for the
 * `apps/web/src/app/claim/[claim_token]/page.tsx` SSR fetch. Reads from the
 * Layer 4 entitlement profile path (`entitlement_instance` in gp_mercur) per
 * ADR-099 — NOT the deprecated `gp_core.entitlements` table (ADR-052).
 *
 * Before this story the route existed only in `apps/web` as a proxy with a
 * fixture fallback for `GP_TEST_MODE=1`; production traffic 404'd. See
 * `cc-2-voucher-coherence-findings.md` HIGH-4 + `epic-2-cross-review-findings.md`
 * HIGH-04.
 *
 * Security contract:
 *   - Public endpoint (AUTHENTICATE = false).
 *   - Rate-limited per IP (shared token bucket with /store/vouchers/:code/claim).
 *   - Constant-time response floor (200 ms) prevents enumeration of valid vs
 *     invalid claim_token UUIDs.
 *   - AR45: no recipient PII in response body. Only fields needed by the SSR
 *     OG-card variants (status, voucher_code optional, salon name/phone/address,
 *     face_value_minor, currency, expires_at) are projected.
 *   - Revoked claim_token (claim_token_revoked_at IS NOT NULL) is treated the
 *     same as a missing token (404 + neutral 200ms floor) per DD-17B intent.
 *
 * Response shape mirrors `apps/web/src/app/claim/[claim_token]/page.tsx`
 * `ClaimPageData` so the existing SSR component does not need to change.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { consumeClaimToken } from "../../../../../lib/voucher-claim-rate-limit"

export const AUTHENTICATE = false

/** Minimum response latency floor in ms (anti-enumeration constant-time). */
const RESPONSE_FLOOR_MS = 200

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function padToFloor(startedAt: number): Promise<void> {
  const elapsed = Date.now() - startedAt
  if (elapsed < RESPONSE_FLOOR_MS) {
    await delay(RESPONSE_FLOOR_MS - elapsed)
  }
}

function resolveIp(req: MedusaRequest): string {
  const forwarded = req.headers["x-forwarded-for"]
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim()
  return req.socket?.remoteAddress ?? "unknown"
}

type Db = {
  raw: (sql: string, params?: unknown[]) => Promise<unknown>
}

function rowsFromResult(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  const maybeRows = (result as { rows?: unknown }).rows
  return Array.isArray(maybeRows) ? (maybeRows as Record<string, unknown>[]) : []
}

const CLAIM_TOKEN_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type ClaimPagePayload = {
  status: string
  voucher_code: string | null
  product_name: string | null
  product_image_url: string | null
  salon_name: string | null
  salon_phone: string | null
  salon_address: string | null
  face_value_minor: number
  currency: string
  expires_at: string | null
}

function projectClaimPagePayload(row: Record<string, unknown>): ClaimPagePayload {
  const policySnapshot = (row.policy_snapshot ?? {}) as Record<string, unknown>
  const seller = (policySnapshot.seller ?? {}) as Record<string, unknown>
  const product = (policySnapshot.product ?? {}) as Record<string, unknown>
  const currency =
    (typeof policySnapshot.currency === "string" ? policySnapshot.currency : null) ??
    (typeof row.currency === "string" ? (row.currency as string) : null) ??
    "PLN"
  const amount =
    typeof policySnapshot.amount_minor === "number"
      ? (policySnapshot.amount_minor as number)
      : typeof row.face_value_minor === "number"
        ? (row.face_value_minor as number)
        : 0
  const expiresAt = row.expires_at as Date | string | null | undefined
  const expiresAtIso =
    expiresAt instanceof Date
      ? expiresAt.toISOString()
      : typeof expiresAt === "string" && expiresAt
        ? new Date(expiresAt).toISOString()
        : null

  // F6 / Story 2.16 AR45 boundary: voucher_code is surfaced because the
  // post-claim variant of `ClaimPageState` needs it for the salon-redemption
  // flow display. It is NOT recipient PII (it is a market-scoped token already
  // exposed via the claim URL). All recipient-side PII (email, phone, buyer
  // name) is intentionally omitted.
  return {
    status: typeof row.state === "string" ? (row.state as string) : "ACTIVE",
    voucher_code: typeof row.voucher_code === "string" ? (row.voucher_code as string) : null,
    product_name:
      typeof product.name === "string"
        ? (product.name as string)
        : typeof row.product_title === "string"
          ? (row.product_title as string)
          : null,
    product_image_url:
      typeof product.image_url === "string" ? (product.image_url as string) : null,
    salon_name:
      typeof seller.name === "string"
        ? (seller.name as string)
        : typeof row.seller_name === "string"
          ? (row.seller_name as string)
          : null,
    salon_phone: typeof seller.phone === "string" ? (seller.phone as string) : null,
    salon_address: typeof seller.address === "string" ? (seller.address as string) : null,
    face_value_minor: amount,
    currency,
    expires_at: expiresAtIso,
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const startedAt = Date.now()
  const token = (req.params as { token?: string })?.token ?? ""
  const ip = resolveIp(req)

  // --- Rate limit ---
  const rl = consumeClaimToken(ip)
  if (!rl.allowed) {
    await padToFloor(startedAt)
    res.setHeader("Retry-After", String(rl.retryAfterSec))
    res.status(429).json({
      type: "rate_limited",
      message: "Too many claim-token lookups. Please retry after the indicated delay.",
      retry_after: rl.retryAfterSec,
    })
    return
  }

  // --- Token shape validation (must look like a UUID to spare DB I/O on
  // garbage probes). Constant-time floor still applies so the response shape
  // does not leak whether the token shape was rejected.
  if (!token || !CLAIM_TOKEN_REGEX.test(token)) {
    await padToFloor(startedAt)
    res.status(404).json({ type: "not_found", message: "Claim token not found." })
    return
  }

  // --- DB lookup ---
  let db: Db | null = null
  try {
    db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Db
  } catch {
    db = null
  }
  if (!db) {
    await padToFloor(startedAt)
    res.status(503).json({
      type: "service_unavailable",
      message: "Database connection unavailable.",
    })
    return
  }

  // F6 / HIGH-04 — read from Layer 4 (entitlement_instance + voucher join).
  // claim_token lives ONLY on entitlement_instance after migration
  // 1778926200000_add_claim_token_to_entitlement_instance.ts. The voucher join
  // (LEFT) backfills product_title / seller_handle for the rendering layer.
  //
  // SB-4 NOTE (v1.9.0): Knex `db.raw()` accepts `?` (positional) or `:name`
  // (named) bindings only — PostgreSQL `$N` placeholders trigger
  // `Expected N bindings, saw 0`. Use `?` here and across all
  // PG_CONNECTION-backed API routes.
  const result = await db.raw(
    `SELECT ei.id,
            ei.state,
            ei.policy_snapshot,
            ei.expires_at,
            ei.claim_token_revoked_at,
            v.code AS voucher_code,
            v.product_title,
            v.seller_name,
            v.value_minor AS face_value_minor,
            v.currency_code AS currency
       FROM entitlement_instance ei
       LEFT JOIN voucher v ON v.code = (ei.policy_snapshot->>'voucher_code')
      WHERE ei.claim_token = ?::uuid
      LIMIT 1`,
    [token]
  )

  const row = rowsFromResult(result)[0]
  if (!row || row.claim_token_revoked_at) {
    await padToFloor(startedAt)
    res.status(404).json({ type: "not_found", message: "Claim token not found." })
    return
  }

  const payload = projectClaimPagePayload(row)
  await padToFloor(startedAt)
  res.status(200).json(payload)
}
