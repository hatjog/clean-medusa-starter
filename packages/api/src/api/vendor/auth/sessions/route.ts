/**
 * GET /vendor/auth/sessions — vendor auth session inventory.
 *
 * This GP-owned vendor auth route is mounted under
 * `authenticate("seller", ["bearer"])` (wired in middlewares.ts) so it shares
 * the same browser-JWT transport as the sibling route
 * `POST /vendor/magic-links/:jti/revoke`.
 *
 * Sessions are backed by the magic_link_issued ledger and exclude revoked or
 * expired JTIs.  The seller_id is read from req.auth_context.actor_id (the
 * Medusa actor injected by authenticate("seller", ["bearer"])).
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

type SellerAuthContext = {
  actor_id?: string
  actor_type?: string
}

type MagicLinkSessionRow = {
  token_jti: string
  issued_at: Date | string
}

export type VendorAuthSessionView = {
  jti: string
  last_active: string
  current_session: boolean
}

function resolveDb(req: MedusaRequest): Knex | null {
  try {
    return req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  } catch {
    return null
  }
}

function readHeader(req: MedusaRequest, name: string): string | null {
  const raw = req.headers[name.toLowerCase()] ?? req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function resolveSellerId(req: MedusaRequest): string | null {
  const authContext = (req as MedusaRequest & { auth_context?: SellerAuthContext })
    .auth_context
  if (authContext?.actor_type !== "seller") {
    return null
  }
  const actorId = authContext.actor_id?.trim()
  return actorId || null
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const sellerId = resolveSellerId(req)
  if (!sellerId) {
    res.status(401).json({
      code: "SELLER_AUTH_REQUIRED",
      message: "Authenticated seller context required",
    })
    return
  }

  const db = resolveDb(req)
  if (!db) {
    res.status(503).json({
      code: "PG_POOL_UNAVAILABLE",
      message: "Session store unavailable",
    })
    return
  }

  const currentJti = readHeader(req, "x-vendor-session-jti")
  const rows = await db("magic_link_issued as issued")
    .leftJoin(
      "magic_link_revocation as revoked",
      "issued.token_jti",
      "revoked.token_jti"
    )
    .select<MagicLinkSessionRow[]>([
      "issued.token_jti",
      "issued.issued_at",
    ])
    .where("issued.subject_seller_id", sellerId)
    .where("issued.expires_at", ">", new Date())
    .whereNull("revoked.token_jti")
    .orderBy("issued.issued_at", "desc")
    .limit(20)

  const sessions: VendorAuthSessionView[] = rows.map((row) => ({
    jti: row.token_jti,
    last_active: toIsoString(row.issued_at),
    current_session: Boolean(currentJti && currentJti === row.token_jti),
  }))

  res.status(200).json({ sessions })
}
