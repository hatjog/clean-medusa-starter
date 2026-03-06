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