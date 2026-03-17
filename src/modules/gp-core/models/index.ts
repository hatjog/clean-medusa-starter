export type TimestampValue = Date | string

export type GpCoreVertical = {
  id: string
  instance_id: string
  name: string
  slug: string
  status: string
  created_at: TimestampValue
  updated_at: TimestampValue
}

export type GpCoreMarketRecord = {
  id: string
  instance_id: string
  name: string
  slug: string
  vertical_id: string
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
  status: string
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

export type GpCoreMarket = GpCoreMarketRecord & {
  vertical: GpCoreVertical
}

export type GpCoreMarketDetail = GpCoreMarket & {
  assignments: GpCoreVendorMarketAssignmentDetail[]
}

export type GpCoreModuleOptions = {
  databaseUrl?: string
  mercurDatabaseUrl?: string
}

export type CreateVerticalInput = {
  id?: string
  instance_id: string
  name: string
  slug: string
  status?: string
}

export type CreateMarketInput = {
  id?: string
  instance_id: string
  name: string
  slug: string
  vertical_id: string
  status?: string
  sales_channel_id?: string | null
  payload_vendor_id?: string | null
}

export type UpdateMarketInput = {
  name?: string
  vertical_id?: string
  status?: string
  sales_channel_id?: string | null
  payload_vendor_id?: string | null
  updated_by?: "system" | "admin"
}

export type CreateVendorInput = {
  id?: string
  instance_id: string
  name: string
  status?: string
}

export type AssignVendorToMarketInput = {
  id?: string
  instance_id: string
  vendor_id: string
  market_id: string
  status?: string
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

export type EntitlementCreateDto = {
  order_id: string
  line_item_id: string
  vendor_id: string
  market_id: string
  instance_id: string
  product_id: string
  face_value_minor: number
  currency: string
  buyer_email: string
  buyer_is_recipient: boolean
  customer_id: string | null
  idempotency_key: string
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