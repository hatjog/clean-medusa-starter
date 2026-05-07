/**
 * voucher module — shared types.
 *
 * Story v160-cleanup-25: replaces in-memory voucher-fixture-store.ts with a
 * PG-backed Medusa 2 module.
 */

export type VoucherStatus =
  | "idle"
  | "consent_pending"
  | "claimed"
  | "withdrawn"

export type VoucherEventType =
  | "created"
  | "sent"
  | "opened"
  | "claimed"
  | "withdrawn"

export interface VoucherRow {
  code: string
  market_id: string | null
  seller_id: string
  seller_name: string
  seller_handle: string
  product_title: string
  value_minor: number
  currency_code: string
  status: VoucherStatus
  expires_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface VoucherEventRow {
  id: string
  voucher_code: string
  event_type: VoucherEventType
  occurred_at: Date
  created_at: Date
}

export interface VoucherWithEvents extends VoucherRow {
  events: VoucherEventRow[]
}

export interface UpsertVoucherInput {
  code: string
  market_id?: string | null
  seller_id: string
  seller_name: string
  seller_handle: string
  product_title: string
  value_minor: number
  currency_code: string
  status: VoucherStatus
  expires_at?: Date | string | null
  events?: Array<{
    id: string
    event_type: VoucherEventType
    occurred_at: Date | string
  }>
}

export interface AppendEventInput {
  event_type: VoucherEventType
  occurred_at?: Date
}

export type ClaimResult =
  | { status: "claimed"; voucher: VoucherWithEvents }
  | { status: "already_claimed"; voucher: VoucherWithEvents }
  | { status: "expired"; voucher: VoucherWithEvents }
  | { status: "not_found"; voucher: null }
