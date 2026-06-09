/**
 * POST /api/v1/entitlements/claim — v1.9.0 Wave F6 / HIGH-04 + CC-2 #1.
 *
 * Public claim acceptance endpoint backing the `apps/web/src/app/claim/...`
 * recipient page. Resolves a public claim_token to the Layer 4
 * `entitlement_instance` row (gp_mercur), transitions it from ISSUED → ACTIVE
 * if needed, and surfaces a redirect target so the apps/web SSR can render the
 * success state.
 *
 * Why this exists:
 *   Pre-F6 the route was a fixture in apps/web (`GP_TEST_MODE=1`); live
 *   recipient traffic 404'd. See `cc-2-voucher-coherence-findings.md` HIGH-4 +
 *   `epic-2-cross-review-findings.md` HIGH-04.
 *
 * Security contract:
 *   - Public endpoint (AUTHENTICATE = false).
 *   - Rate-limited per IP (shared bucket with GET /by-claim-token + the legacy
 *     `/store/vouchers/:code/claim` route).
 *   - Constant-time response floor (200 ms) — enumeration safety.
 *   - Token shape validation rejects garbage before DB I/O.
 *   - Idempotent: replaying the same claim_token returns 200 / redirect with
 *     the same entitlement_id, no double mutation.
 *   - Revoked tokens (claim_token_revoked_at set) treated as 404.
 *
 * Body: `{ claim_token: string }` (JSON or form-url-encoded).
 *
 * Response:
 *   - 200: `{ data: { entitlement_id, state, claim_token } }`
 *   - 303: Redirect to `/claim/{token}` for HTML form flows.
 *   - 404: token unknown / revoked.
 *   - 410: terminal state (REFUNDED / VOIDED / EXPIRED).
 *   - 429: rate-limited.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { consumeClaimToken } from "../../../../lib/voucher-claim-rate-limit"
import {
  EXPIRED_CLAIM_LINK_GONE_BODY,
  isClaimTokenExpired,
  isClaimTokenTtlEnforced,
  resolveClaimTokenTtlHours,
} from "../../../../lib/voucher-claim-magic-link-ttl"
import {
  EntitlementInstanceState,
  assertTransition,
} from "../../../../modules/voucher/models/entitlement"

export const AUTHENTICATE = false

const RESPONSE_FLOOR_MS = 200

const CLAIM_TOKEN_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const TERMINAL_TOKEN_STATES: ReadonlySet<EntitlementInstanceState> = new Set([
  EntitlementInstanceState.REFUNDED,
  EntitlementInstanceState.VOIDED,
  EntitlementInstanceState.EXPIRED,
  EntitlementInstanceState.CLOSED,
])

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

function extractClaimToken(req: MedusaRequest): string {
  const body = (req.body ?? {}) as Record<string, unknown>
  const raw = body.claim_token
  if (typeof raw === "string") return raw.trim()
  return ""
}

function shouldRedirect(req: MedusaRequest): boolean {
  const accept = (req.headers["accept"] ?? "") as string
  const contentType = (req.headers["content-type"] ?? "") as string
  return (
    contentType.includes("application/x-www-form-urlencoded") ||
    accept.includes("text/html")
  )
}

type PgPoolLike = {
  connect: () => Promise<PgClientLike>
}
type PgClientLike = {
  query: <T = Record<string, unknown>>(
    sql: string,
    values?: ReadonlyArray<unknown>
  ) => Promise<{ rows: T[]; rowCount?: number | null }>
  release?: () => void
}
type KnexLike = {
  raw: (
    sql: string,
    bindings?: ReadonlyArray<unknown>
  ) => Promise<{ rows?: unknown[]; rowCount?: number | null } | unknown[]>
  transaction: <T>(handler: (trx: KnexLike) => Promise<T>) => Promise<T>
}

function isPgPool(value: unknown): value is PgPoolLike {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as PgPoolLike).connect === "function"
  )
}

async function withTransaction<T>(
  req: MedusaRequest,
  handler: (client: PgClientLike) => Promise<T>
): Promise<T | null> {
  let db: unknown = null
  try {
    db = req.scope.resolve("__pg_pool__")
  } catch {
    try {
      db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    } catch {
      db = null
    }
  }
  if (!db) return null

  if (isPgPool(db)) {
    const client = await db.connect()
    try {
      await client.query("BEGIN")
      const result = await handler(client)
      await client.query("COMMIT")
      return result
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw err
    } finally {
      client.release?.()
    }
  }

  const knex = db as KnexLike
  return knex.transaction(async (trx) =>
    handler({
      query: async <T = Record<string, unknown>>(
        sql: string,
        values: ReadonlyArray<unknown> = []
      ) => {
        const bindings: unknown[] = []
        const text = sql.replace(/\$(\d+)/g, (_m, idx: string) => {
          bindings.push(values[Number(idx) - 1])
          return "?"
        })
        const result = await trx.raw(text, bindings)
        if (Array.isArray(result)) {
          return { rows: result as T[], rowCount: result.length }
        }
        const rows = (result.rows ?? []) as T[]
        return { rows, rowCount: result.rowCount ?? rows.length }
      },
    })
  )
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const startedAt = Date.now()
  const ip = resolveIp(req)

  // --- Rate limit ---
  const rl = consumeClaimToken(ip)
  if (!rl.allowed) {
    await padToFloor(startedAt)
    res.setHeader("Retry-After", String(rl.retryAfterSec))
    res.status(429).json({
      type: "rate_limited",
      message: "Too many claim attempts. Please retry after the indicated delay.",
      retry_after: rl.retryAfterSec,
    })
    return
  }

  const token = extractClaimToken(req)
  if (!token || !CLAIM_TOKEN_REGEX.test(token)) {
    await padToFloor(startedAt)
    res.status(400).json({
      type: "invalid_request",
      message: "claim_token is required and must be a valid UUID",
    })
    return
  }

  // Story 7.4 / ADR-138 DEC-1 — egzekucja TTL magic-linka voucher-claim.
  const ttlEnforced = isClaimTokenTtlEnforced()

  let result: {
    id: string
    state: EntitlementInstanceState
    transitioned: boolean
    expired?: boolean
  } | null
  try {
    result = await withTransaction(req, async (client) => {
      // F6 HIGH-09: pre-check INSIDE the FOR UPDATE lock to close the TOCTOU
      // race between unlocked existence check and locked transition.
      const lockRes = await client.query<{
        id: string
        state: string
        revoked_at: Date | string | null
        issued_at: Date | string | null
        market_id: string | null
      }>(
        `SELECT id, state, claim_token_revoked_at AS revoked_at,
                claim_token_issued_at AS issued_at, market_id
           FROM entitlement_instance
          WHERE claim_token = $1::uuid
          FOR UPDATE`,
        [token]
      )
      if (lockRes.rows.length === 0 || lockRes.rows[0].revoked_at) {
        return null
      }
      const row = lockRes.rows[0]
      const currentState = row.state as EntitlementInstanceState

      // TTL magic-linka: wygasły link NIE może zainicjować nowego claimu
      // (ISSUED → ACTIVE) ⇒ 410 (Gone). Stany terminalne (poniżej) i
      // idempotentny replay ACTIVE zachowują dotychczasową semantykę.
      if (
        currentState === EntitlementInstanceState.ISSUED &&
        isClaimTokenExpired({
          issuedAt: row.issued_at,
          ttlHours: resolveClaimTokenTtlHours(row.market_id),
          enforced: ttlEnforced,
        })
      ) {
        return { id: row.id, state: currentState, transitioned: false, expired: true }
      }

      if (TERMINAL_TOKEN_STATES.has(currentState)) {
        return { id: row.id, state: currentState, transitioned: false }
      }

      // Idempotent: already ACTIVE → return without re-transition.
      if (currentState === EntitlementInstanceState.ACTIVE) {
        return { id: row.id, state: currentState, transitioned: false }
      }

      // Only ISSUED → ACTIVE is the supported claim transition. Other states
      // (REDEMPTION_REQUESTED, REDEEMED_*, DISPUTED) are mid-redeem flows and
      // should not be re-claimable. Bypass with a 410 in the route.
      if (currentState !== EntitlementInstanceState.ISSUED) {
        return { id: row.id, state: currentState, transitioned: false }
      }

      assertTransition(currentState, EntitlementInstanceState.ACTIVE)
      await client.query(
        `UPDATE entitlement_instance
            SET state = $2, updated_at = NOW()
          WHERE id = $1`,
        [row.id, EntitlementInstanceState.ACTIVE]
      )
      return {
        id: row.id,
        state: EntitlementInstanceState.ACTIVE,
        transitioned: true,
      }
    })
  } catch (err) {
    await padToFloor(startedAt)
    res.status(500).json({
      type: "server_error",
      message: "Claim transition failed.",
      details: { error: (err as Error).message },
    })
    return
  }

  if (result === null) {
    // Either DB unavailable OR token not found / revoked. We cannot distinguish
    // for the caller (enumeration safety) — both surface as 404.
    await padToFloor(startedAt)
    res.status(404).json({ type: "not_found", message: "Claim token not found." })
    return
  }

  // Wygasły magic-link (TTL) → 410 (Gone) z neutralną kopią. Odróżniony
  // od stanów terminalnych typem `magic_link_expired` (ADR-138 DEC-1).
  if (result.expired) {
    await padToFloor(startedAt)
    res.status(410).json(EXPIRED_CLAIM_LINK_GONE_BODY)
    return
  }

  // Terminal states → 410 with neutral copy.
  if (TERMINAL_TOKEN_STATES.has(result.state)) {
    await padToFloor(startedAt)
    res.status(410).json({
      type: result.state.toLowerCase(),
      message: "This claim is no longer redeemable.",
      state: result.state,
    })
    return
  }

  await padToFloor(startedAt)

  if (shouldRedirect(req)) {
    res.setHeader("Location", `/claim/${encodeURIComponent(token)}`)
    res.status(303).end()
    return
  }

  res.status(200).json({
    data: {
      entitlement_id: result.id,
      state: result.state,
      claim_token: token,
      transitioned: result.transitioned,
    },
  })
}
