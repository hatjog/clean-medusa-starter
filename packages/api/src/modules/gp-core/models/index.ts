export type TimestampValue = Date | string
export type MercurSellerStatus = "pending_approval" | "open" | "suspended" | "terminated"

export type GpCoreMarketRecord = {
  id: string
  instance_id: string
  name: string
  slug: string
  status: string
  sales_channel_id: string | null
  payload_vendor_id: string | null
  created_at: TimestampValue
  updated_at: TimestampValue
}

export type GpCoreVendor = {
  id: string
  instance_id: string
  name: string
  status: MercurSellerStatus
  created_at: TimestampValue
  updated_at: TimestampValue
}

export type GpCoreVendorMarketAssignment = {
  id: string
  instance_id: string
  vendor_id: string
  market_id: string
  status: string
  created_at: TimestampValue
  updated_at: TimestampValue
}

export type GpCoreVendorMarketAssignmentDetail = GpCoreVendorMarketAssignment & {
  vendor: GpCoreVendor
}

export type GpCoreMarket = GpCoreMarketRecord

export type GpCoreMarketDetail = GpCoreMarket & {
  assignments: GpCoreVendorMarketAssignmentDetail[]
}

export type GpCoreModuleOptions = {
  databaseUrl?: string
  mercurDatabaseUrl?: string
}

export type CreateMarketInput = {
  id?: string
  instance_id: string
  name: string
  slug: string
  status?: string
  sales_channel_id?: string | null
  payload_vendor_id?: string | null
}

export type UpdateMarketInput = {
  name?: string
  status?: string
  sales_channel_id?: string | null
  payload_vendor_id?: string | null
  updated_by?: "system" | "admin"
}

export type CreateVendorInput = {
  id?: string
  instance_id: string
  name: string
  status?: MercurSellerStatus
}

export type AssignVendorToMarketInput = {
  id?: string
  instance_id: string
  vendor_id: string
  market_id: string
  status?: string
}

// --- User Membership Types (accounts sync) ---

export type UpsertUserMarketMembershipInput = {
  user_id: string
  instance_id: string
  market_id: string
  role: string
}

export type UpsertUserVendorMembershipInput = {
  user_id: string
  instance_id: string
  vendor_id: string
  role: string
}

// --- Entitlement Domain Types (Story 1.2) ---

export enum EntitlementStatus {
  ISSUED = "ISSUED",
  ACTIVE = "ACTIVE",
  PARTIALLY_REDEEMED = "PARTIALLY_REDEEMED",
  REDEEMED = "REDEEMED",
  VOIDED = "VOIDED",
  REFUNDED = "REFUNDED",
  EXPIRED = "EXPIRED",
}

export type Entitlement = {
  id: string
  market_id: string
  order_id: string
  line_item_id: string
  product_id: string
  vendor_id: string
  face_value_minor: number
  remaining_minor: number
  currency: string
  status: EntitlementStatus
  claim_token: string | null
  voucher_code: string | null
  buyer_email: string
  buyer_is_recipient: boolean
  customer_id: string | null
  expires_at: TimestampValue | null
  created_at: TimestampValue
  updated_at: TimestampValue
}

export type Redemption = {
  id: string
  entitlement_id: string
  amount_minor: number
  vendor_id: string
  idempotency_key: string
  created_at: TimestampValue
}

/**
 * Subscriber-friendly DTO for createEntitlement (Story 1.10, ADR-118 Path Y).
 *
 * The `on-order-completed` subscriber emits only `{order_id, recipient_locale?,
 * message_locale?, is_gift?, voucher_kind?}` per the cross-version OrderPlaced
 * payload. The service derives the remaining fields from a Mercur order lookup
 * when they are not provided. Callers that already have full context (admin
 * tools, integration tests) MAY pass the full canonical shape.
 *
 * - `order_id` is REQUIRED and is the idempotency anchor in combination with
 *   `line_item_id` (UNIQUE constraint on `gp_core.entitlements`).
 * - `idempotency_key` is optional metadata; when absent the service derives
 *   `${order_id}::${line_item_id}` per the seed-entitlements pattern.
 * - v2 OrderPlaced fields (`recipient_locale`, `message_locale`, `is_gift`,
 *   `voucher_kind`) are persisted into `entitlement_audit_log.metadata` so the
 *   subscriber telemetry remains traceable post-issue.
 */
export type EntitlementCreateDto = {
  order_id: string
  line_item_id?: string
  vendor_id?: string
  market_id?: string
  instance_id?: string
  product_id?: string | null
  face_value_minor?: number
  currency?: string
  buyer_email?: string
  buyer_is_recipient?: boolean
  customer_id?: string | null
  idempotency_key?: string
  // v2 OrderPlaced enrichment (D-50 backward compatibility — optional)
  recipient_locale?: string | null
  message_locale?: string | null
  is_gift?: boolean
  voucher_kind?: "SPV" | "MPV" | "none" | string
}

export type RedemptionCreateDto = {
  entitlement_id: string
  amount_minor: number
  vendor_id: string
  idempotency_key: string
}

export type EntitlementAuditEntry = {
  id: string
  entitlement_id: string
  action: string
  actor: string
  details: Record<string, unknown>
  created_at: TimestampValue
}
