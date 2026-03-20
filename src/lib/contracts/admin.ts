/**
 * Admin API contracts (Story 8.1 — Entitlement Lookup & Admin Search)
 *
 * Defines query schema and response types for operator admin endpoints.
 * All amount fields use _minor suffix (IP-4).
 * All dates use ISO 8601 format (IP-5).
 *
 * References:
 * - architecture-v1.2.0.md#DD-20 — apiSuccess response shape
 * - architecture-v1.2.0.md#IP-3,4,5 — response conventions
 */
import { z } from "zod"

/** Query schema for GET /api/v1/admin/entitlements */
export const AdminEntitlementsQuerySchema = z.object({
  q: z.string().min(3).max(200),
})

export type AdminEntitlementsQuery = z.infer<typeof AdminEntitlementsQuerySchema>

/** Single redemption record */
export type RedemptionRecord = {
  id: string
  amount_minor: number
  vendor_id: string
  redeemed_at: string
  idempotency_key: string
}

/** Single audit log entry */
export type AuditLogEntry = {
  id: string
  action: string
  actor: string
  reason: string | null
  created_at: string
}

/**
 * Full entitlement view returned by admin search (30-second test shape).
 * Includes redemption history and audit log for full context in one response.
 */
export type EntitlementAdminView = {
  // Core identifiers
  id: string
  status: string
  voucher_code: string
  claim_token: string
  order_id: string | null

  // Financials (IP-4 — integer minor units)
  face_value_minor: number
  remaining_minor: number
  currency: string

  // Snapshot (cached at issuance — product may be archived)
  product_name: string
  vendor_name: string

  // Dates (IP-5 — ISO 8601)
  created_at: string
  expires_at: string | null
  claimed_at: string | null
  last_redeemed_at: string | null

  // Full context (AC-3 / UX-DR13)
  redemptions: RedemptionRecord[]
  audit_log: AuditLogEntry[]
}
