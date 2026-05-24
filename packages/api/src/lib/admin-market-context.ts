/**
 * admin-market-context.ts — server-side market resolution for admin routes.
 *
 * cc-4 finding F-03: `x-gp-market-id` was previously accepted as a plain
 * client-supplied header (seller-pause, entitlements/reissue,
 * entitlements/issue-retention) with NO server-side cross-check against
 * the admin's market roster. Any authenticated admin could mutate any
 * market by spoofing the header, and audit rows could be attributed to
 * the wrong market.
 *
 * This helper centralises admin-market binding. v1.9.0 baseline contract:
 *
 *   1. `__super_admin__` actors retain header-based selection (admin
 *      decisions table is opt-in for granular RBAC; super-admin keeps
 *      the operational ability to act cross-market).
 *   2. Non-super-admin actors MUST have an `admin_market_grants` row for
 *      the requested market_id. If the table is empty / missing, the
 *      helper fails closed.
 *   3. A request that supplies `x-gp-market-id` but the actor lacks the
 *      grant returns `{ ok: false, status: 403 }` — the route MUST honour
 *      the verdict rather than continuing with `seller.market_id`.
 *   4. When the header is absent and the resource carries an intrinsic
 *      market_id (e.g. seller row), the route should pass that intrinsic
 *      value to `verifyAdminMarketAccess` for the same check.
 *
 * The `admin_market_grants` table is created best-effort; if the table
 * is missing the helper degrades to:
 *   - super-admins: allowed (no per-market grant required)
 *   - non super-admins: denied (fail-closed)
 *
 * NOTE: the existing `__super_admin__` capability lives in
 * `admin_capability_grants`. We reuse `findActiveGrant` from
 * `capability-grants-repo` to test for it; no new schema is required
 * for the v1.9.0 baseline. A follow-up ADR (F-13 ADR-109a) will define
 * the `admin_market_grants` schema for non-super-admin RBAC.
 *
 * @module lib/admin-market-context
 */
import type { MedusaRequest } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"
import {
  findActiveGrant,
  SUPER_ADMIN_CAPABILITY,
} from "./capability-grants-repo"

type AuthContext = {
  actor_id?: string
  actor_type?: string
}

function getAuthContext(req: MedusaRequest): AuthContext | undefined {
  return (req as MedusaRequest & { auth_context?: AuthContext }).auth_context
}

function getKnex(req: MedusaRequest): Knex | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const container = (req as any).scope ?? (req as any).__container__
    if (container?.resolve) {
      return container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
    }
  } catch {
    return undefined
  }
  return undefined
}

let _testKnex: Knex | undefined

/** Set mock Knex for unit tests. Call with undefined to reset. */
export function __setKnexForAdminMarketTests(db: Knex | undefined): void {
  _testKnex = db
}

function resolveKnex(req: MedusaRequest): Knex | undefined {
  return _testKnex ?? getKnex(req)
}

/**
 * Reads `x-gp-market-id` from the request headers and returns the trimmed
 * string or null when absent / malformed.
 *
 * Distinct from `extractMarketIdFromHeader` callers used to inline because
 * we want a single audited entrypoint that emits debug logs if the value
 * is ever spoofed in a non-super-admin path.
 */
export function readMarketIdHeader(req: MedusaRequest): string | null {
  const raw = req.headers["x-gp-market-id"]
  if (typeof raw === "string" && raw.trim()) return raw.trim()
  if (Array.isArray(raw) && raw[0]?.trim()) return raw[0].trim()
  return null
}

export type AdminMarketContextResult =
  | {
      ok: true
      market_id: string | null
      actor_id: string
      actor_type: "user"
      is_super_admin: boolean
      source: "header" | "intrinsic" | "none"
    }
  | {
      ok: false
      status: 401
      code: "UNAUTHORIZED"
      message: string
    }
  | {
      ok: false
      status: 403
      code: "MARKET_FORBIDDEN"
      message: string
      requested_market_id: string
    }

/**
 * resolveAdminMarketContext — server-side market binding for admin routes.
 *
 * Resolution order:
 *   1. Require an authenticated admin (actor_id + actor_type === "user").
 *   2. Read header `x-gp-market-id` (preferred) OR caller-supplied
 *      `intrinsicMarketId` (fallback — typically from the resource row).
 *   3. If the resolved market_id is non-null, verify the actor has
 *      access. Super-admins are allowed by default; non-super-admins must
 *      hold a grant in `admin_market_grants` for the market_id. When the
 *      table is missing the helper fails closed for non-super-admins.
 *   4. Returns `ok: true` with market_id, actor_id, and source attribution
 *      so callers can log which path the value came from.
 *
 * Callers that mutate or read market-scoped resources MUST honour the
 * `ok: false` verdict and short-circuit with the matching HTTP code.
 */
export async function resolveAdminMarketContext(
  req: MedusaRequest,
  opts: { intrinsicMarketId?: string | null } = {}
): Promise<AdminMarketContextResult> {
  const ctx = getAuthContext(req)
  if (!ctx?.actor_id) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      message: "Valid admin session required",
    }
  }
  if (ctx.actor_type !== undefined && ctx.actor_type !== "user") {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      message: "Admin actor_type required (actor_type=user); other actor types are rejected",
    }
  }

  const headerMarketId = readMarketIdHeader(req)
  const intrinsicMarketId = opts.intrinsicMarketId ?? null
  const requestedMarketId = headerMarketId ?? intrinsicMarketId
  const source: "header" | "intrinsic" | "none" = headerMarketId
    ? "header"
    : intrinsicMarketId
    ? "intrinsic"
    : "none"

  const db = resolveKnex(req)
  let isSuperAdmin = false
  if (db) {
    try {
      isSuperAdmin = await findActiveGrant(db, ctx.actor_id, SUPER_ADMIN_CAPABILITY)
    } catch {
      // DB error — degrade to non-super-admin path (fail-closed below for non-empty market).
      isSuperAdmin = false
    }
  }

  // If no market context at all (header absent + intrinsic null), surface
  // ok:true with market_id=null so the caller can decide what to do
  // (e.g. cross-market platform-wide ops for super-admins).
  if (!requestedMarketId) {
    return {
      ok: true,
      market_id: null,
      actor_id: ctx.actor_id,
      actor_type: "user",
      is_super_admin: isSuperAdmin,
      source: "none",
    }
  }

  if (isSuperAdmin) {
    return {
      ok: true,
      market_id: requestedMarketId,
      actor_id: ctx.actor_id,
      actor_type: "user",
      is_super_admin: true,
      source,
    }
  }

  // Non-super-admin — require an admin_market_grants row.
  const hasGrant = db
    ? await hasAdminMarketGrant(db, ctx.actor_id, requestedMarketId)
    : false
  if (!hasGrant) {
    return {
      ok: false,
      status: 403,
      code: "MARKET_FORBIDDEN",
      message: `Admin actor does not have access to market ${requestedMarketId}`,
      requested_market_id: requestedMarketId,
    }
  }

  return {
    ok: true,
    market_id: requestedMarketId,
    actor_id: ctx.actor_id,
    actor_type: "user",
    is_super_admin: false,
    source,
  }
}

/**
 * hasAdminMarketGrant — best-effort lookup against `admin_market_grants`.
 *
 * Schema (informational — table may not yet exist in all environments):
 *   - admin_user_id text NOT NULL
 *   - market_id text NOT NULL
 *   - granted_at timestamptz NOT NULL DEFAULT now()
 *   - revoked_at timestamptz NULL
 *   - PRIMARY KEY (admin_user_id, market_id)
 *
 * If the table is missing or unreadable, returns false. The whole resolver
 * fails closed for non-super-admins in that case (deliberate).
 */
async function hasAdminMarketGrant(
  db: Knex,
  adminUserId: string,
  marketId: string
): Promise<boolean> {
  try {
    const rows = await db<{ admin_user_id: string }>("admin_market_grants")
      .select("admin_user_id")
      .where("admin_user_id", adminUserId)
      .where("market_id", marketId)
      .whereNull("revoked_at")
      .limit(1)
    return rows.length > 0
  } catch {
    // Table missing or other DB error — non-super-admins fail closed above.
    return false
  }
}
