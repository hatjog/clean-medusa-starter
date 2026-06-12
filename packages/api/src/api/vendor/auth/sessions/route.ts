/**
 * GET /vendor/auth/sessions — vendor auth session inventory.
 *
 * This GP-owned vendor auth route is intentionally mounted through
 * withVendorAuth so the caller is bound by the existing S2S HMAC transport.
 * Sessions are backed by the magic_link_issued ledger and exclude revoked or
 * expired JTIs.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import { withVendorAuth, type VendorAuthContext } from "../../../../lib/vendor-auth"

type RequestWithVendorAuth = MedusaRequest & {
  vendorAuth?: VendorAuthContext
}

type MagicLinkSessionRow = {
  token_jti: string
  issued_at: Date | string
  subject?: Record<string, unknown> | string | null
}

export type VendorAuthSessionView = {
  jti: string
  device_class: string
  last_active: string
  ip_region: string | null
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

function parseSubject(subject: MagicLinkSessionRow["subject"]): Record<string, unknown> {
  if (!subject) return {}
  if (typeof subject === "string") {
    try {
      const parsed = JSON.parse(subject)
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return subject
}

function normalizeDeviceClass(subject: Record<string, unknown>): string {
  const deviceClass = subject["device_class"]
  return typeof deviceClass === "string" && deviceClass.trim()
    ? deviceClass.trim()
    : "unknown"
}

function normalizeIpRegion(subject: Record<string, unknown>): string | null {
  const ipRegion = subject["ip_region"]
  return typeof ipRegion === "string" && ipRegion.trim() ? ipRegion.trim() : null
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export const GET = withVendorAuth(async (
  req: RequestWithVendorAuth,
  res: MedusaResponse,
): Promise<void> => {
  const db = resolveDb(req)
  if (!db) {
    res.status(503).json({
      code: "PG_POOL_UNAVAILABLE",
      message: "Session store unavailable",
    })
    return
  }

  const sellerId = req.vendorAuth!.seller_id
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
      "issued.subject",
    ])
    .where("issued.subject_seller_id", sellerId)
    .where("issued.expires_at", ">", new Date())
    .whereNull("revoked.token_jti")
    .orderBy("issued.issued_at", "desc")
    .limit(20)

  const sessions: VendorAuthSessionView[] = rows.map((row) => {
    const subject = parseSubject(row.subject)
    return {
      jti: row.token_jti,
      device_class: normalizeDeviceClass(subject),
      last_active: toIsoString(row.issued_at),
      ip_region: normalizeIpRegion(subject),
      current_session: Boolean(currentJti && currentJti === row.token_jti),
    }
  })

  res.status(200).json({ sessions })
})
