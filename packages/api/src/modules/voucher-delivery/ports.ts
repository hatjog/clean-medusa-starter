/**
 * voucher-delivery/ports.ts — bounded-context port contracts for the Voucher
 * Delivery BC (D-52 stub-domain + D-53 schema link).
 *
 * v1.4.0 ships interface contracts only. Stub classes throw a hard
 * `not implemented v1.4.0` error at runtime to prevent accidental invocation.
 * v1.5.0 will swap impl with the multi-channel dispatcher and audit-trail
 * persistence layer.
 *
 * @see D-52 — Voucher Delivery BC stub-domain.
 * @see D-53 — three voucher delivery schemas (VoucherTemplate,
 *      VoucherPersonalization, VoucherDelivery).
 * @see _bmad-output/planning-artifacts/voucher-delivery-analysis-2026-04-23.md
 *      §3.2 (VoucherDelivery entity).
 *
 * Versioning: net-new optional fields = additive-MINOR. Renaming or removing
 * fields, or making any existing field required, = MAJOR.
 */

import type { VoucherDeliveryType } from "../voucher-template/ports"

const NOT_IMPL = "not implemented v1.4.0 — see D-52, ships in v1.5.0"

/**
 * VoucherDispatchInput — placeholder shape for a dispatch request.
 *
 * @see D-53.
 * @see voucher-delivery-analysis-2026-04-23.md §3.2.
 *
 * v1.5.0 will swap impl with the full dispatch body (auth tokens, channel
 * options, retry policy). The minimal routing surface lands now.
 */
export type VoucherDispatchInput = {
  /* TBD v1.5.0 — provider auth, retry policy, channel options. */
  voucher_id: string
  personalization_id: string
  channel: VoucherDeliveryType
  /** Channel-typed recipient contact (email | phone | postal address). */
  recipient_contact: string
  locale: string
}

/**
 * VoucherDispatchResult — placeholder shape for a dispatch result.
 *
 * @see D-53.
 *
 * v1.5.0 will swap impl with full provider telemetry and structured failure
 * detail. Status discriminator + delivery id are the stable surface.
 *
 * Renaming any of `'QUEUED' | 'DELIVERED' | 'FAILED'` is MAJOR; adding new
 * status codes is additive-MINOR.
 */
export type VoucherDispatchResult = {
  /* TBD v1.5.0 — full provider telemetry. */
  delivery_id: string
  status: "QUEUED" | "DELIVERED" | "FAILED"
  provider?: string
  provider_order_id?: string
}

/**
 * VoucherDeliveryAttempt — placeholder shape for an audit-trail entry.
 *
 * @see D-53.
 * @see voucher-delivery-analysis-2026-04-23.md §3.2.
 *
 * v1.5.0 will swap impl with the full audit row (provider response, failure
 * categorisation, retry lineage). The minimal identifier + timestamp surface
 * lands now.
 *
 * `scheduled_at` / `delivered_at` use ISO 8601 strings (IP-5 convention).
 */
export type VoucherDeliveryAttempt = {
  /* TBD v1.5.0 — provider response detail, failure categorisation, retry lineage. */
  id: string
  voucher_id: string
  channel: VoucherDeliveryType
  status: string
  /** ISO 8601 timestamp. */
  scheduled_at: string
  /** ISO 8601 timestamp. */
  delivered_at?: string
  error?: string
  attempts_count: number
  metadata?: Record<string, unknown>
}

/**
 * IVoucherDispatcher — port for dispatching a voucher to a delivery channel.
 *
 * @see D-52, D-53.
 *
 * v1.5.0 will swap impl. v1.4.0 stub throws — invocation is a contract bug.
 */
export interface IVoucherDispatcher {
  dispatch(input: VoucherDispatchInput): Promise<VoucherDispatchResult>
}

/**
 * IVoucherDeliveryAuditTrail — port for recording and listing delivery
 * attempts (for compliance + customer-care debugging).
 *
 * @see D-52, D-53.
 *
 * v1.5.0 will swap impl. v1.4.0 stub throws.
 */
export interface IVoucherDeliveryAuditTrail {
  recordAttempt(attempt: VoucherDeliveryAttempt): Promise<void>
  listAttempts(voucherId: string): Promise<VoucherDeliveryAttempt[]>
}

/**
 * StubVoucherDispatcher — v1.4.0 placeholder. Throws on every call.
 *
 * @see D-52. v1.5.0 will swap impl.
 */
export class StubVoucherDispatcher implements IVoucherDispatcher {
  async dispatch(): Promise<VoucherDispatchResult> {
    throw new Error(NOT_IMPL)
  }
}

/**
 * StubVoucherDeliveryAuditTrail — v1.4.0 placeholder. Throws on every call.
 *
 * @see D-52. v1.5.0 will swap impl.
 */
export class StubVoucherDeliveryAuditTrail implements IVoucherDeliveryAuditTrail {
  async recordAttempt(): Promise<void> {
    throw new Error(NOT_IMPL)
  }

  async listAttempts(): Promise<VoucherDeliveryAttempt[]> {
    throw new Error(NOT_IMPL)
  }
}
