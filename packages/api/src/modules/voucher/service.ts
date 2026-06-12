/**
 * VoucherService — Medusa 2 module service.
 *
 * Story v160-cleanup-25: replaces in-memory voucher-fixture-store.ts with a
 * PG-backed service. Migrations create `voucher` + `voucher_event` tables.
 *
 * Pattern follows gp-core/service.ts (raw pg Pool, no MedusaService ORM).
 */

import { randomUUID } from "node:crypto"
import { Modules } from "@medusajs/framework/utils"
import { Pool } from "pg"
import type { PoolClient } from "pg"
import type {
  VoucherRow,
  VoucherEventRow,
  VoucherWithEvents,
  UpsertVoucherInput,
  AppendEventInput,
  ClaimResult,
} from "./models/types"
import {
  EntitlementInstanceState,
  EntitlementTransitionError,
  EntitlementType,
  assertTransition,
  type EntitlementInstanceRow,
  type EntitlementPolicySnapshot,
} from "./models/entitlement"
import type { VatClassification } from "./vat-resolver"
import {
  ENTITLEMENT_BOUNDARY,
  REFUND_CHANNELS,
  type NoShowPolicy,
  type RefundChannel,
  validityMonthsMax,
} from "./entitlement-boundary"

// Local minimal shape for admin search projection (Layer 4-aware).
// Mirrors fields from `lib/contracts/admin#EntitlementAdminView` that are
// projectable from `entitlement_instance` + `voucher` join. The redemption /
// audit-log enrichment fields are intentionally optional (gp_mercur Layer 4
// doesn't carry the separate redemption table that the legacy gp_core view
// projected) — admin UI tolerant of missing arrays.
type EntitlementAdminView = {
  id: string
  status: string
  voucher_code: string | null
  claim_token: string | null
  order_id: string | null
  face_value_minor: number
  remaining_minor: number
  currency: string
  product_name: string | null
  vendor_name: string | null
  created_at: string
  expires_at: string | null
  claimed_at: string | null
  last_redeemed_at: string | null
}

/** States from which a refund can be processed. */
const REFUNDABLE_STATES: ReadonlySet<EntitlementInstanceState> = new Set([
  EntitlementInstanceState.ACTIVE,
  EntitlementInstanceState.REDEEMED_PARTIAL,
  EntitlementInstanceState.REDEEMED_FULL,
  EntitlementInstanceState.REFUND_REQUESTED,
])

export const ENTITLEMENT_NO_SHOW_EVENT_TYPE =
  "gp.entitlements.entitlement_no_show.v1"

/** Canonical outcome vocabulary for the no-show event payload (epics FR1.17). */
export type NoShowOutcome =
  | "forfeiture"
  | "partial_fee"
  | "no_charge"
  | "vendor_decision"
  | "charge_full"

export interface MarkNoShowInput {
  reason: string
  actor?: string
  base_amount?: number
}

export interface MarkNoShowResult {
  entitlement_id: string
  outcome: NoShowOutcome
  no_show_policy: NoShowPolicy
  resulting_state: EntitlementInstanceState
  fee_amount?: number
  charge_pct?: number
  base_amount?: number
  remaining_amount?: number
  marked_at: string
}

type VoucherModuleOptions = {
  databaseUrl?: string
}

type EventBusMessage = { name: string; data: unknown }
type EventBusLike = {
  emit(message: EventBusMessage | EventBusMessage[]): Promise<void> | void
}
type Queryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

export const ENTITLEMENT_EXTENDED_EVENT = "ENTITLEMENT_EXTENDED"
export const ENTITLEMENT_REFUND_APPLIED_EVENT =
  "gp.entitlements.entitlement_refund_applied.v1"
export const ENTITLEMENT_CANCELLATION_FEE_APPLIED_EVENT =
  "ENTITLEMENT_CANCELLATION_FEE_APPLIED"

export interface ExtendEntitlementInput {
  paid: boolean
  actor?: string
  source?: string
  now?: Date
}

export interface EntitlementExtendedEnvelope {
  event: typeof ENTITLEMENT_EXTENDED_EVENT
  /** entitlement_profile_id — the profile/template identifier for this entitlement. */
  entitlement_id: string
  /** id of the specific entitlement_instance row being extended. */
  entitlement_instance_id: string
  paid: boolean
  fee_pct?: number
  previous_expires_at: string
  new_expires_at: string
  actor: string
  source: string
  timestamp: string
}

export interface ExtendEntitlementResult {
  /** entitlement_profile_id — the profile/template identifier (mirrors envelope). */
  entitlement_id: string
  /** id of the specific entitlement_instance row that was extended. */
  entitlement_instance_id: string
  paid: boolean
  fee_pct?: number
  previous_expires_at: Date
  new_expires_at: Date
  unpaid_extension_count: number
  event: EntitlementExtendedEnvelope
}

type ExtensionPolicy = {
  allowed: boolean
  paid: boolean
  fee_pct: number
  max_extension_months: number
}

type CancellationDeductMethod = "forfeit_credit" | "charge_card"
type CancellationPolicy = {
  cutoff_hours: number
  fee_pct: number
  deduct_method: CancellationDeductMethod
}

export type CancellationPaymentRefundSeam = (input: {
  entitlement_id: string
  order_id?: string
  refund_amount: number
  fee_amount: number
  base_amount: number
  currency?: string
}) => Promise<void> | void

export type CancelBookingInput = {
  current_time?: Date
  scheduled_at?: Date
  base_amount?: number
  currency?: string
  payment_refund?: CancellationPaymentRefundSeam
}

export type CancellationFeeAppliedPayload = {
  entitlement_id: string
  fee_amount: number
  fee_pct: number
  deduct_method: CancellationDeductMethod
  base_amount: number
  cutoff_hours: number
  cancelled_at: string
  scheduled_at: string
  refund_amount?: number
  remaining_amount?: number
}

type EntitlementInstanceResult = EntitlementInstanceRow & {
  expires_at?: Date | null
}

type EntitlementBookingCancelledPayload = {
  entitlement_id: string
  previous_state: EntitlementInstanceState.REDEMPTION_REQUESTED
  state: EntitlementInstanceState.ACTIVE
  booking_pointer: null
  entitlement_type: EntitlementType.VOUCHER_SERVICE
}

export class EntitlementExtensionError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = "EntitlementExtensionError"
    this.code = code
    this.details = details
  }
}

export class EntitlementRefundError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = "EntitlementRefundError"
    this.code = code
    this.details = details
  }
}

export interface RefundRequestInput {
  /** Unique refund identifier for idempotency. */
  refund_id: string
  /** Amount in minor units (e.g. grosz for PLN). */
  amount: number
  /** ISO 4217 currency code, must match entitlement currency. */
  currency: string
  reason?: string
  actor?: string
}

export interface RefundRequestResult {
  entitlement_id: string
  refund_id: string
  refund_channel: RefundChannel
  amount: number
  currency: string
  /** Whether this was a duplicate idempotent call (no new effect). */
  idempotent: boolean
  event: RefundAppliedEnvelope
}

/** Payload shape for `gp.entitlements.entitlement_refund_applied.v1`. */
export interface RefundAppliedPayload {
  entitlement_id: string
  refund_id: string
  applied_at: string
  currency: string
  refunded_amount_minor: number
  refund_channel: RefundChannel
  order_id?: string
  payment_id?: string
  voided?: boolean
}

/** Full event envelope for `gp.entitlements.entitlement_refund_applied.v1`. */
export interface RefundAppliedEnvelope {
  schema_version: "1"
  event_type: typeof ENTITLEMENT_REFUND_APPLIED_EVENT
  occurred_at: string
  actor: string
  idempotency_key: string
  scope: {
    instance_id: string
    market_id?: string
    vendor_id?: string
    location_id?: string
  }
  payload: RefundAppliedPayload
}

function resolveDatabaseUrl(override?: string): string {
  const url = override ?? process.env.DATABASE_URL
  if (!url) throw new Error("VoucherService: DATABASE_URL not set")
  return url
}

export class VoucherService {
  private readonly container_: Record<string, any>
  private readonly moduleOptions_: VoucherModuleOptions
  private pool_: Pool | null = null
  /** @internal — for testing only: inject a mock Pool */
  _testPool?: Pool

  constructor(
    container: Record<string, any> = {},
    moduleOptions: VoucherModuleOptions = {},
    moduleDeclaration: { options?: VoucherModuleOptions } = {}
  ) {
    this.container_ = container
    this.moduleOptions_ = {
      ...(moduleDeclaration?.options ?? {}),
      ...(moduleOptions ?? {}),
    }
  }

  private getPool(): Pool {
    if (this._testPool) return this._testPool
    if (!this.pool_) {
      this.pool_ = new Pool({
        connectionString: resolveDatabaseUrl(this.moduleOptions_.databaseUrl),
      })
    }
    return this.pool_
  }

  private resolveContainerDependency<T = unknown>(key: string): T | null {
    const direct = this.container_?.[key]
    if (direct) return direct as T

    if (typeof this.container_?.resolve === "function") {
      try {
        return (this.container_.resolve(key) ?? null) as T | null
      } catch (_error) {
        return null
      }
    }

    return null
  }

  private get eventBus_(): EventBusLike | null {
    const eventBus = this.resolveContainerDependency<EventBusLike>(
      Modules.EVENT_BUS
    )
    return eventBus && typeof eventBus.emit === "function" ? eventBus : null
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private toDate(v: Date | string | null | undefined): Date | null {
    if (v == null) return null
    return v instanceof Date ? v : new Date(v)
  }

  private rowToVoucher(row: Record<string, unknown>): VoucherRow {
    return {
      code: row.code as string,
      market_id: (row.market_id ?? null) as string | null,
      seller_id: row.seller_id as string,
      seller_name: row.seller_name as string,
      seller_handle: row.seller_handle as string,
      product_title: row.product_title as string,
      value_minor: Number(row.value_minor),
      currency_code: row.currency_code as string,
      status: row.status as VoucherRow["status"],
      expires_at: this.toDate(row.expires_at as string | Date | null),
      created_at: new Date(row.created_at as string | Date),
      updated_at: new Date(row.updated_at as string | Date),
    }
  }

  private rowToEvent(row: Record<string, unknown>): VoucherEventRow {
    return {
      id: row.id as string,
      voucher_code: (row.voucher_code ?? null) as string | null,
      event_type: row.event_type as VoucherEventRow["event_type"],
      payload: (row.payload ?? null) as Record<string, unknown> | null,
      occurred_at: new Date(row.occurred_at as string | Date),
      created_at: new Date(row.created_at as string | Date),
    }
  }

  private rowToEntitlementInstance(
    row: Record<string, unknown>
  ): EntitlementInstanceResult {
    const result: EntitlementInstanceResult = {
      id: row.id as string,
      entitlement_profile_id: row.entitlement_profile_id as string,
      entitlement_type: row.entitlement_type as EntitlementType,
      order_id: (row.order_id ?? null) as string | null,
      // Ontologia scope + snapshoty dodane migracjami. Wypełnienie
      // reference_price_minor należy do v1.12.0 Story 3.4; tu tylko mapujemy
      // nullable kolumnę dla wierszy legacy i pre-snapshot.
      market_id: (row.market_id ?? null) as string | null,
      sales_channel_id: (row.sales_channel_id ?? null) as string | null,
      vat_classification: (row.vat_classification ?? null) as VatClassification | null,
      reference_price_minor:
        row.reference_price_minor != null
          ? Number(row.reference_price_minor)
          : null,
      state: row.state as EntitlementInstanceState,
      booking_pointer: (row.booking_pointer ?? null) as string | null,
      policy_snapshot: this.toPolicySnapshot(row.policy_snapshot),
      expires_at: this.toDate(row.expires_at as string | Date | null),
      unpaid_extension_count: Number(row.unpaid_extension_count ?? 0),
      remaining_amount:
        row.remaining_amount != null ? Number(row.remaining_amount) : null,
      created_at: new Date(row.created_at as string | Date),
      updated_at: new Date(row.updated_at as string | Date),
    }

    return result
  }

  private toPolicySnapshot(value: unknown): EntitlementPolicySnapshot {
    if (typeof value === "string") {
      return JSON.parse(value) as EntitlementPolicySnapshot
    }
    if (!value || typeof value !== "object") {
      throw new EntitlementExtensionError(
        "POLICY_SNAPSHOT_INVALID",
        "entitlement_instance.policy_snapshot must be an object"
      )
    }
    return value as EntitlementPolicySnapshot
  }

  private extensionPolicyFromSnapshot(
    snapshot: EntitlementPolicySnapshot
  ): ExtensionPolicy {
    const extension = (snapshot as Record<string, unknown>).extension
    if (!extension || typeof extension !== "object") {
      throw new EntitlementExtensionError(
        "EXTENSION_POLICY_MISSING",
        "policy_snapshot.extension is required for voucher extension"
      )
    }

    const ext = extension as Record<string, unknown>
    const policy = {
      allowed: ext.allowed,
      paid: ext.paid,
      fee_pct: ext.fee_pct,
      max_extension_months: ext.max_extension_months,
    }
    if (
      typeof policy.allowed !== "boolean" ||
      typeof policy.paid !== "boolean" ||
      typeof policy.fee_pct !== "number" ||
      !Number.isFinite(policy.fee_pct) ||
      !Number.isInteger(policy.fee_pct) ||
      typeof policy.max_extension_months !== "number" ||
      !Number.isInteger(policy.max_extension_months)
    ) {
      throw new EntitlementExtensionError(
        "EXTENSION_POLICY_INVALID",
        "policy_snapshot.extension must contain allowed, paid, fee_pct and max_extension_months"
      )
    }

    return policy as ExtensionPolicy
  }

  private cancellationPolicyFromSnapshot(
    snapshot: EntitlementPolicySnapshot
  ): CancellationPolicy | null {
    const cancellation = (snapshot as Record<string, unknown>).cancellation
    if (!cancellation || typeof cancellation !== "object") return null

    const c = cancellation as Record<string, unknown>
    if (
      typeof c.cutoff_hours !== "number" ||
      !Number.isInteger(c.cutoff_hours) ||
      typeof c.fee_pct !== "number" ||
      !Number.isInteger(c.fee_pct) ||
      (c.deduct_method !== "forfeit_credit" && c.deduct_method !== "charge_card")
    ) {
      throw new EntitlementExtensionError(
        "CANCELLATION_POLICY_INVALID",
        "policy_snapshot.cancellation must contain cutoff_hours, fee_pct and deduct_method"
      )
    }

    if (
      c.cutoff_hours < ENTITLEMENT_BOUNDARY.policy.cancellation.cutoff_hours_min ||
      c.fee_pct < ENTITLEMENT_BOUNDARY.policy.cancellation.fee_pct_min ||
      c.fee_pct > ENTITLEMENT_BOUNDARY.policy.cancellation.fee_pct_max
    ) {
      throw new EntitlementExtensionError(
        "CANCELLATION_POLICY_BOUNDARY_VIOLATION",
        "policy_snapshot.cancellation is outside GP boundary"
      )
    }

    return {
      cutoff_hours: c.cutoff_hours,
      fee_pct: c.fee_pct,
      deduct_method: c.deduct_method,
    }
  }

  private resolveScheduledAt(
    current: EntitlementInstanceResult,
    input: CancelBookingInput
  ): Date | null {
    if (input.scheduled_at) return input.scheduled_at
    if (!current.booking_pointer) return null
    try {
      const parsed = JSON.parse(current.booking_pointer) as Record<string, unknown>
      const raw = parsed.scheduled_at ?? parsed.scheduledAt
      if (typeof raw === "string" || raw instanceof Date) return new Date(raw)
    } catch {
      return null
    }
    return null
  }

  private isWithinCancellationCutoff(
    currentTime: Date,
    scheduledAt: Date,
    cutoffHours: number
  ): boolean {
    const cutoffStart = scheduledAt.getTime() - cutoffHours * 60 * 60 * 1000
    const now = currentTime.getTime()
    return (
      Number.isFinite(now) &&
      Number.isFinite(cutoffStart) &&
      Number.isFinite(scheduledAt.getTime()) &&
      now >= cutoffStart &&
      now <= scheduledAt.getTime()
    )
  }

  private addMonths(date: Date, months: number): Date {
    const d = new Date(date.getTime())
    const day = d.getUTCDate()
    d.setUTCDate(1)
    d.setUTCMonth(d.getUTCMonth() + months)
    const lastDay = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
    ).getUTCDate()
    d.setUTCDate(Math.min(day, lastDay))
    return d
  }

  private async emitEntitlementExtended(
    event: EntitlementExtendedEnvelope
  ): Promise<void> {
    if (!this.eventBus_) {
      throw new EntitlementExtensionError(
        "EVENT_BUS_REQUIRED",
        "voucher extension requires Medusa event bus"
      )
    }
    await this.eventBus_.emit({ name: ENTITLEMENT_EXTENDED_EVENT, data: event })
  }

  private async emitEntitlementBookingCancelled(
    client: PoolClient,
    payload: EntitlementBookingCancelledPayload
  ): Promise<void> {
    await client.query(
      `INSERT INTO voucher_event (id, voucher_code, entitlement_id, event_type, payload, occurred_at, created_at)
       VALUES ($1, NULL, $2, $3, $4::jsonb, NOW(), NOW())`,
      [
        randomUUID(),
        payload.entitlement_id,
        "ENTITLEMENT_BOOKING_CANCELLED",
        payload,
      ]
    )
  }

  private async emitEntitlementCancellationFeeApplied(
    client: PoolClient,
    payload: CancellationFeeAppliedPayload
  ): Promise<void> {
    await client.query(
      `INSERT INTO voucher_event (id, voucher_code, entitlement_id, event_type, payload, occurred_at, created_at)
       VALUES ($1, NULL, $2, $3, $4::jsonb, $5, NOW())`,
      [
        randomUUID(),
        payload.entitlement_id,
        ENTITLEMENT_CANCELLATION_FEE_APPLIED_EVENT,
        payload,
        new Date(payload.cancelled_at),
      ]
    )
  }

  private async getByCodeWithClient(
    client: Queryable,
    code: string
  ): Promise<VoucherWithEvents | null> {
    const vResult = await client.query<Record<string, unknown>>(
      `SELECT * FROM voucher WHERE code = $1`,
      [code]
    )
    if (vResult.rows.length === 0) return null
    const voucher = this.rowToVoucher(vResult.rows[0])

    const eResult = await client.query<Record<string, unknown>>(
      `SELECT * FROM voucher_event WHERE voucher_code = $1 ORDER BY occurred_at ASC`,
      [code]
    )
    return { ...voucher, events: eResult.rows.map((r) => this.rowToEvent(r)) }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async getByCode(code: string): Promise<VoucherWithEvents | null> {
    return this.getByCodeWithClient(this.getPool(), code)
  }

  async listCodes(): Promise<string[]> {
    const result = await this.getPool().query<{ code: string }>(
      `SELECT code FROM voucher ORDER BY created_at ASC`
    )
    return result.rows.map((r) => r.code)
  }

  /**
   * v1.10.0 Story 9.3 — Buyer claim notification source fetcher.
   *
   * Read-only helper resolving the AR45 source record for a voucher claim,
   * sourced exclusively from Layer 4 (`entitlement_instance`) + `voucher`
   * + `voucher_event` + `public.order`. Replaces the legacy
   * `gp_core.entitlements` direct SQL read from the buyer-notification
   * subscriber (ADR-052 cutover, sunset clause closure).
   *
   * Lookup strategy (first row wins):
   *   1. by entitlement_instance.id (when `voucher_id` is a Layer 4 PK), or
   *   2. by policy_snapshot->>'voucher_code' / voucher.code = lookupCode.
   *
   * Joins:
   *   - voucher v ON v.code = (ei.policy_snapshot->>'voucher_code') — gives
   *     seller_name / seller_handle / product_title / voucher.code
   *     (voucher row carries those denormalized columns).
   *   - public.order o ON o.id = ei.order_id — gives buyer email (when
   *     order is wired post-payment, FR1.22).
   *   - voucher_event ve ON ve.voucher_code = v.code AND
   *     ve.event_type='claimed' — gives the claimed_at timestamp (latest
   *     event wins).
   *
   * Buyer email resolution priority:
   *   1. policy_snapshot->>'buyer_email' (canonical PII per pii-consent
   *      route), then
   *   2. public.order.email (Mercur Layer baseline).
   *
   * buyer_locale projection: policy_snapshot->>'buyer_locale' (nullable;
   * downstream `resolveLocale` falls back to 'pl').
   *
   * Returns null when no matching entitlement_instance / voucher row is
   * found — caller emits audit_status='failed' with
   * error_message='voucher source not found'.
   */
  async findBuyerClaimSource(
    voucher_id: string,
    voucher_code: string | null,
  ): Promise<{
    buyer_email: string | null
    buyer_locale: string | null
    seller_name: string | null
    seller_handle: string | null
    service_title: string | null
    claimed_at: string | null
    voucher_code: string | null
  } | null> {
    const lookupCode = voucher_code ?? voucher_id
    const pool = this.getPool()
    const res = await pool.query<Record<string, unknown>>(
      `SELECT
         ei.id                                       AS ei_id,
         ei.policy_snapshot                          AS policy_snapshot,
         ei.order_id                                 AS order_id,
         v.code                                      AS voucher_code,
         v.seller_name                               AS seller_name,
         v.seller_handle                             AS seller_handle,
         v.product_title                             AS product_title,
         o.email                                     AS order_email,
         (
           SELECT ve.occurred_at FROM voucher_event ve
            WHERE ve.voucher_code = v.code
              AND ve.event_type = 'claimed'
            ORDER BY ve.occurred_at DESC
            LIMIT 1
         )                                           AS claimed_at
       FROM entitlement_instance ei
       LEFT JOIN voucher v ON v.code = (ei.policy_snapshot->>'voucher_code')
       LEFT JOIN public.order o ON o.id = ei.order_id
       WHERE ei.id = $1
          OR (ei.policy_snapshot->>'voucher_code') = $2
          OR v.code = $2
       ORDER BY ei.created_at DESC
       LIMIT 1`,
      [voucher_id, lookupCode],
    )

    const row = res.rows[0]
    if (!row) return null

    const snapshot =
      typeof row.policy_snapshot === "string"
        ? (JSON.parse(row.policy_snapshot as string) as Record<string, unknown>)
        : ((row.policy_snapshot ?? {}) as Record<string, unknown>)

    const snapshotEmail =
      typeof snapshot.buyer_email === "string" && (snapshot.buyer_email as string).length > 0
        ? (snapshot.buyer_email as string)
        : null
    const orderEmail =
      typeof row.order_email === "string" && (row.order_email as string).length > 0
        ? (row.order_email as string)
        : null
    const snapshotLocale =
      typeof snapshot.buyer_locale === "string" && (snapshot.buyer_locale as string).length > 0
        ? (snapshot.buyer_locale as string)
        : null
    const claimedAt =
      row.claimed_at instanceof Date
        ? row.claimed_at.toISOString()
        : typeof row.claimed_at === "string" && (row.claimed_at as string).length > 0
          ? (row.claimed_at as string)
          : null

    return {
      buyer_email: snapshotEmail ?? orderEmail,
      buyer_locale: snapshotLocale,
      seller_name:
        typeof row.seller_name === "string" && (row.seller_name as string).length > 0
          ? (row.seller_name as string)
          : null,
      seller_handle:
        typeof row.seller_handle === "string" && (row.seller_handle as string).length > 0
          ? (row.seller_handle as string)
          : null,
      service_title:
        typeof row.product_title === "string" && (row.product_title as string).length > 0
          ? (row.product_title as string)
          : null,
      claimed_at: claimedAt,
      voucher_code:
        (typeof row.voucher_code === "string" && (row.voucher_code as string).length > 0
          ? (row.voucher_code as string)
          : null) ??
        (typeof snapshot.voucher_code === "string"
          ? (snapshot.voucher_code as string)
          : null) ??
        lookupCode,
    }
  }

  /**
   * Story 5.3 — source fetcher for appointment confirmation delivery.
   *
   * This is intentionally narrower than findBuyerClaimSource: the appointment
   * email must not receive a voucher code or service title. It only resolves
   * the dispatch recipient plus neutral salon/location labels used in the
   * confirmation body and .ics payload.
   */
  async findAppointmentConfirmationDeliverySource(
    entitlement_instance_id: string,
  ): Promise<{
    buyer_email: string | null
    buyer_locale: string | null
    salon_name: string | null
    location_address: string | null
    seller_handle: string | null
  } | null> {
    const pool = this.getPool()
    const res = await pool.query<Record<string, unknown>>(
      `SELECT
         ei.id                                       AS ei_id,
         ei.policy_snapshot                          AS policy_snapshot,
         ei.order_id                                 AS order_id,
         v.seller_name                               AS seller_name,
         v.seller_handle                             AS seller_handle,
         o.email                                     AS order_email
       FROM entitlement_instance ei
       LEFT JOIN voucher v ON v.code = (ei.policy_snapshot->>'voucher_code')
       LEFT JOIN public.order o ON o.id = ei.order_id
       WHERE ei.id = $1
       ORDER BY ei.created_at DESC
       LIMIT 1`,
      [entitlement_instance_id],
    )

    const row = res.rows[0]
    if (!row) return null

    const snapshot =
      typeof row.policy_snapshot === "string"
        ? (JSON.parse(row.policy_snapshot as string) as Record<string, unknown>)
        : ((row.policy_snapshot ?? {}) as Record<string, unknown>)
    const seller =
      snapshot.seller &&
      typeof snapshot.seller === "object" &&
      !Array.isArray(snapshot.seller)
        ? (snapshot.seller as Record<string, unknown>)
        : {}
    const snapshotEmail =
      typeof snapshot.buyer_email === "string" && (snapshot.buyer_email as string).length > 0
        ? (snapshot.buyer_email as string)
        : null
    const orderEmail =
      typeof row.order_email === "string" && (row.order_email as string).length > 0
        ? (row.order_email as string)
        : null
    const snapshotLocale =
      typeof snapshot.buyer_locale === "string" && (snapshot.buyer_locale as string).length > 0
        ? (snapshot.buyer_locale as string)
        : null
    const salonName =
      typeof seller.name === "string" && (seller.name as string).length > 0
        ? (seller.name as string)
        : typeof row.seller_name === "string" && (row.seller_name as string).length > 0
          ? (row.seller_name as string)
          : null
    const locationAddress =
      typeof seller.address === "string" && (seller.address as string).length > 0
        ? (seller.address as string)
        : typeof snapshot.location_address === "string" &&
            (snapshot.location_address as string).length > 0
          ? (snapshot.location_address as string)
          : null
    const sellerHandle =
      typeof seller.handle === "string" && (seller.handle as string).length > 0
        ? (seller.handle as string)
        : typeof row.seller_handle === "string" && (row.seller_handle as string).length > 0
          ? (row.seller_handle as string)
          : null

    return {
      buyer_email: snapshotEmail ?? orderEmail,
      buyer_locale: snapshotLocale,
      salon_name: salonName,
      location_address: locationAddress,
      seller_handle: sellerHandle,
    }
  }

  /**
   * v1.9.0 Wave F6 / Epic-2 HIGH-01 + CC-2 #1 — System 1 elimination.
   *
   * Admin entitlement search reading from Layer 4 (`entitlement_instance`)
   * instead of the deprecated `gp_core.entitlements` table. This is the
   * single-source-of-truth replacement for `gpCore.adminSearchEntitlements`;
   * the admin route now delegates here.
   *
   * Query semantics:
   *   - Email path (`q` contains `@`): join Mercur `order` table by
   *     buyer_email ILIKE, collect order_ids, then list entitlement_instance
   *     rows for those orders.
   *   - Direct path: ILIKE on voucher.code (joined via policy_snapshot
   *     voucher_code surrogate) + exact match on claim_token / order_id.
   *
   * Returns lightweight `EntitlementAdminView`-shaped projection; per-row
   * redemption / audit enrichment is intentionally omitted (legacy
   * implementation projected `e.face_value_minor` / `e.remaining_minor` from
   * an obsolete table; the Layer 4 equivalents live on `policy_snapshot` and
   * `remaining_amount`).
   */
  async adminSearchEntitlements(
    q: string,
    opts: { market_id?: string | null; allow_cross_market?: boolean } = {}
  ): Promise<EntitlementAdminView[]> {
    const trimmed = q.trim()
    if (!trimmed) return []
    const marketId = opts.market_id ?? null
    const allowCrossMarket = opts.allow_cross_market === true
    // Story 1.5 / R5 / FR-F5 — fail-closed default. A caller that supplies
    // neither a concrete market_id NOR an explicit cross-market opt-in gets an
    // empty result set, NOT an unscoped cross-market read. Cross-market global
    // search is reserved for super-admins and MUST be requested explicitly via
    // `allow_cross_market: true` (the admin route only sets it after verifying
    // `is_super_admin`). This removes the prior fail-open default where a future
    // caller omitting `opts` would silently read every market.
    if (!marketId && !allowCrossMarket) return []
    const pool = this.getPool()

    const isEmailSearch = trimmed.includes("@")
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        trimmed
      )

    if (isEmailSearch) {
      const ordersRes = await pool.query<{ id: string }>(
        `SELECT id FROM public.order WHERE email ILIKE $1 LIMIT 100`,
        [`%${trimmed}%`]
      )
      if (ordersRes.rows.length === 0) return []
      const orderIds = ordersRes.rows.map((r) => r.id)
      const rows = await pool.query<Record<string, unknown>>(
        `SELECT ei.*, v.code AS voucher_code, v.value_minor, v.currency_code
           FROM entitlement_instance ei
           LEFT JOIN voucher v ON v.code = (ei.policy_snapshot->>'voucher_code')
          WHERE ei.order_id = ANY($1::text[])
            AND ($2::text IS NULL OR ei.market_id = $2)
          ORDER BY ei.created_at DESC
          LIMIT 200`,
        [orderIds, marketId]
      )
      return rows.rows.map((r) => this.projectAdminView(r))
    }

    const directRes = await pool.query<Record<string, unknown>>(
      `SELECT ei.*, v.code AS voucher_code, v.value_minor, v.currency_code
         FROM entitlement_instance ei
         LEFT JOIN voucher v ON v.code = (ei.policy_snapshot->>'voucher_code')
        WHERE (
             v.code ILIKE $1
          ${isUuid ? "OR ei.claim_token = $2::uuid OR ei.order_id = $2 OR ei.id = $2" : "OR ei.order_id = $2 OR ei.id = $2"}
        )
          AND ($3::text IS NULL OR ei.market_id = $3)
        ORDER BY ei.created_at DESC
        LIMIT 100`,
      [`%${trimmed}%`, trimmed, marketId]
    )
    return directRes.rows.map((r) => this.projectAdminView(r))
  }

  private projectAdminView(row: Record<string, unknown>): EntitlementAdminView {
    const policySnapshot =
      typeof row.policy_snapshot === "string"
        ? (JSON.parse(row.policy_snapshot as string) as Record<string, unknown>)
        : ((row.policy_snapshot ?? {}) as Record<string, unknown>)
    const faceValue =
      typeof row.value_minor === "number"
        ? (row.value_minor as number)
        : typeof policySnapshot.amount_minor === "number"
          ? (policySnapshot.amount_minor as number)
          : 0
    const remaining =
      row.remaining_amount != null ? Number(row.remaining_amount) : faceValue
    const currency =
      (typeof row.currency_code === "string" ? (row.currency_code as string) : null) ??
      (typeof policySnapshot.currency === "string" ? (policySnapshot.currency as string) : "PLN")
    return {
      id: row.id as string,
      status: row.state as string,
      voucher_code: (row.voucher_code as string | undefined) ?? null,
      claim_token: (row.claim_token as string | null | undefined) ?? null,
      order_id: (row.order_id as string | null | undefined) ?? null,
      face_value_minor: faceValue,
      remaining_minor: remaining,
      currency,
      product_name:
        typeof policySnapshot.product_name === "string"
          ? (policySnapshot.product_name as string)
          : null,
      vendor_name:
        typeof policySnapshot.vendor_name === "string"
          ? (policySnapshot.vendor_name as string)
          : null,
      created_at:
        row.created_at instanceof Date
          ? (row.created_at as Date).toISOString()
          : String(row.created_at ?? ""),
      expires_at:
        row.expires_at == null
          ? null
          : row.expires_at instanceof Date
            ? (row.expires_at as Date).toISOString()
            : String(row.expires_at),
      claimed_at: null,
      last_redeemed_at: null,
    }
  }

  async upsert(input: UpsertVoucherInput): Promise<VoucherWithEvents> {
    const pool = this.getPool()
    const expiresAt = this.toDate(input.expires_at)

    await pool.query(
      `INSERT INTO voucher (code, market_id, seller_id, seller_name, seller_handle, product_title, value_minor, currency_code, status, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
       ON CONFLICT (code) DO UPDATE SET
         market_id = EXCLUDED.market_id,
         seller_id = EXCLUDED.seller_id,
         seller_name = EXCLUDED.seller_name,
         seller_handle = EXCLUDED.seller_handle,
         product_title = EXCLUDED.product_title,
         value_minor = EXCLUDED.value_minor,
         currency_code = EXCLUDED.currency_code,
         status = EXCLUDED.status,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [
        input.code,
        input.market_id ?? null,
        input.seller_id,
        input.seller_name,
        input.seller_handle,
        input.product_title,
        input.value_minor,
        input.currency_code,
        input.status,
        expiresAt,
      ]
    )

    // Idempotent event insert
    const events = input.events ?? []
    for (const evt of events) {
      await pool.query(
        `INSERT INTO voucher_event (id, voucher_code, event_type, occurred_at, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [evt.id, input.code, evt.event_type, this.toDate(evt.occurred_at)]
      )
    }

    const result = await this.getByCode(input.code)
    if (!result) throw new Error(`VoucherService.upsert: failed to read back ${input.code}`)
    return result
  }

  async appendEvent(
    code: string,
    event: AppendEventInput
  ): Promise<VoucherEventRow> {
    const id = randomUUID()
    const occurredAt = event.occurred_at ?? new Date()
    await this.getPool().query(
      `INSERT INTO voucher_event (id, voucher_code, event_type, occurred_at, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [id, code, event.event_type, occurredAt]
    )
    return {
      id,
      voucher_code: code,
      event_type: event.event_type,
      payload: null,
      occurred_at: occurredAt,
      created_at: new Date(),
    }
  }

  async cancel_booking(
    entitlement_id: string,
    input: CancelBookingInput | Date = {}
  ): Promise<EntitlementInstanceResult> {
    const opts: CancelBookingInput =
      input instanceof Date ? { current_time: input } : input
    const client = await this.getPool().connect()

    try {
      await client.query("BEGIN")

      const lockRes = await client.query<Record<string, unknown>>(
        `SELECT * FROM entitlement_instance WHERE id = $1 FOR UPDATE`,
        [entitlement_id]
      )
      if (lockRes.rows.length === 0) {
        throw new Error(
          `VoucherService.cancel_booking: entitlement not found ${entitlement_id}`
        )
      }

      const current = this.rowToEntitlementInstance(lockRes.rows[0])
      const previousState = current.state
      assertTransition(previousState, EntitlementInstanceState.ACTIVE)
      if (previousState !== EntitlementInstanceState.REDEMPTION_REQUESTED) {
        throw new EntitlementTransitionError(
          previousState,
          EntitlementInstanceState.ACTIVE
        )
      }
      if (current.entitlement_type !== EntitlementType.VOUCHER_SERVICE) {
        throw new Error(
          `VoucherService.cancel_booking: entitlement ${entitlement_id} is not VOUCHER_SERVICE`
        )
      }
      // policy_snapshot is never written by cancel_booking — the invariant is
      // guaranteed structurally (no SET policy_snapshot in the UPDATE below).
      // assertPolicySnapshotImmutable is NOT called here because passing the
      // same reference as both issued and candidate makes it a no-op; the AC3
      // deep-equal test covers the invariant instead.
      const cancelledAt = opts.current_time ?? new Date()
      const scheduledAt = this.resolveScheduledAt(current, opts)
      const cancellation = this.cancellationPolicyFromSnapshot(
        current.policy_snapshot
      )
      const baseAmount = opts.base_amount ?? current.remaining_amount ?? 0
      let feePayload: CancellationFeeAppliedPayload | null = null
      let remainingAmount: number | null = null

      if (
        cancellation &&
        scheduledAt &&
        cancellation.fee_pct > 0 &&
        baseAmount > 0 &&
        this.isWithinCancellationCutoff(
          cancelledAt,
          scheduledAt,
          cancellation.cutoff_hours
        )
      ) {
        const feeAmount = Math.round((baseAmount * cancellation.fee_pct) / 100)
        if (feeAmount > 0) {
          if (cancellation.deduct_method === "forfeit_credit") {
            remainingAmount = Math.max(0, (current.remaining_amount ?? baseAmount) - feeAmount)
          } else {
            const refundAmount = Math.max(0, baseAmount - feeAmount)
            await opts.payment_refund?.({
              entitlement_id,
              ...(current.order_id ? { order_id: current.order_id } : {}),
              refund_amount: refundAmount,
              fee_amount: feeAmount,
              base_amount: baseAmount,
              ...(opts.currency ? { currency: opts.currency } : {}),
            })
          }
          feePayload = {
            entitlement_id,
            fee_amount: feeAmount,
            fee_pct: cancellation.fee_pct,
            deduct_method: cancellation.deduct_method,
            base_amount: baseAmount,
            cutoff_hours: cancellation.cutoff_hours,
            cancelled_at: cancelledAt.toISOString(),
            scheduled_at: scheduledAt.toISOString(),
            ...(cancellation.deduct_method === "charge_card"
              ? { refund_amount: Math.max(0, baseAmount - feeAmount) }
              : {}),
            ...(remainingAmount !== null
              ? { remaining_amount: remainingAmount }
              : {}),
          }
        }
      }

      const updateRes = await client.query<Record<string, unknown>>(
        `UPDATE entitlement_instance
         SET booking_pointer = NULL,
             state = $2,
             remaining_amount = COALESCE($3, remaining_amount),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [entitlement_id, EntitlementInstanceState.ACTIVE, remainingAmount]
      )
      if (updateRes.rows.length === 0) {
        throw new Error(
          `VoucherService.cancel_booking: failed to update ${entitlement_id}`
        )
      }

      const updated = this.rowToEntitlementInstance(updateRes.rows[0])
      await this.emitEntitlementBookingCancelled(client, {
        entitlement_id,
        previous_state: EntitlementInstanceState.REDEMPTION_REQUESTED,
        state: EntitlementInstanceState.ACTIVE,
        booking_pointer: null,
        entitlement_type: EntitlementType.VOUCHER_SERVICE,
      })
      if (feePayload) {
        await this.emitEntitlementCancellationFeeApplied(client, feePayload)
      }

      await client.query("COMMIT")
      return updated
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  }

  private async emitEntitlementNoShow(
    client: PoolClient,
    payload: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO voucher_event (id, voucher_code, entitlement_id, event_type, payload, occurred_at, created_at)
       VALUES ($1, NULL, $2, $3, $4::jsonb, NOW(), NOW())`,
      [
        randomUUID(),
        payload.entitlement_id,
        ENTITLEMENT_NO_SHOW_EVENT_TYPE,
        payload,
      ]
    )
  }

  /**
   * Mark a no-show on an entitlement instance. Reads policy from
   * `policy_snapshot.no_show` (immutable post-ISSUED, regulamin § 12 — NOT
   * the live profile). Dispatches deterministic outcomes per policy value.
   *
   * Service method (not workflow): synchronous single-module operation, no
   * external side-effects (no Stripe charge — internal credit deduction only).
   * Idempotent: repeated call on already-no-show state is a no-op.
   */
  async mark_no_show(
    entitlement_id: string,
    input: MarkNoShowInput
  ): Promise<MarkNoShowResult> {
    const client = await this.getPool().connect()
    let committed = false

    try {
      await client.query("BEGIN")

      const lockRes = await client.query<Record<string, unknown>>(
        `SELECT * FROM entitlement_instance WHERE id = $1 FOR UPDATE`,
        [entitlement_id]
      )
      if (lockRes.rows.length === 0) {
        throw new Error(
          `VoucherService.mark_no_show: entitlement not found ${entitlement_id}`
        )
      }

      const current = this.rowToEntitlementInstance(lockRes.rows[0])

      // Read policy from immutable snapshot (NOT live profile — regulamin § 12).
      // Must be extracted before idempotency check so idempotent path can return it.
      const snapshot = current.policy_snapshot as Record<string, unknown>
      const noShowSnapshot = (snapshot.no_show ?? {}) as Record<string, unknown>
      const policyValue = ((noShowSnapshot.policy as string | undefined) ?? "no_charge") as NoShowPolicy
      const snapshotChargePct =
        typeof noShowSnapshot.charge_pct === "number"
          ? (noShowSnapshot.charge_pct as number)
          : 0

      // Idempotency: if already in a terminal no-show outcome state, return early.
      // Outcome is derived from the policy snapshot (M2 fix: not hardcoded to "forfeiture").
      const noShowTerminalStates: ReadonlySet<EntitlementInstanceState> =
        new Set([
          EntitlementInstanceState.VOIDED,
          EntitlementInstanceState.PENDING_VENDOR_DECISION,
        ])
      if (noShowTerminalStates.has(current.state)) {
        await client.query("ROLLBACK")
        committed = true
        const idempotentOutcome: NoShowOutcome =
          current.state === EntitlementInstanceState.PENDING_VENDOR_DECISION
            ? "vendor_decision"
            : policyValue === "charge_full"
            ? "charge_full"
            : "forfeiture"
        return {
          entitlement_id,
          outcome: idempotentOutcome,
          no_show_policy: policyValue,
          resulting_state: current.state,
          marked_at: new Date().toISOString(),
        }
      }

      // H1 fix: guard that source state is valid for a no-show operation.
      // Only ACTIVE and REDEMPTION_REQUESTED are valid pre-no-show states.
      // charge_partial and no_charge don't call assertTransition (state-preserving),
      // so this explicit guard is required for all policy paths.
      const validNoShowSourceStates: ReadonlySet<EntitlementInstanceState> = new Set([
        EntitlementInstanceState.ACTIVE,
        EntitlementInstanceState.REDEMPTION_REQUESTED,
      ])
      if (!validNoShowSourceStates.has(current.state)) {
        throw new EntitlementTransitionError(current.state, EntitlementInstanceState.VOIDED)
      }

      const markedAt = new Date().toISOString()
      let newState: EntitlementInstanceState
      let outcome: NoShowOutcome
      let feeAmount: number | undefined
      let newRemainingAmount: number | undefined
      const baseAmount = input.base_amount ?? current.remaining_amount ?? 0

      switch (policyValue) {
        case "forfeit_voucher": {
          assertTransition(current.state, EntitlementInstanceState.VOIDED)
          newState = EntitlementInstanceState.VOIDED
          outcome = "forfeiture"
          await client.query(
            `UPDATE entitlement_instance SET state = $2, updated_at = NOW() WHERE id = $1`,
            [entitlement_id, newState]
          )
          break
        }
        case "charge_partial": {
          // fee = round(base_amount * charge_pct / 100); remaining preserved (clamp >= 0)
          const pct = snapshotChargePct
          feeAmount = Math.round((baseAmount * pct) / 100)
          const currentRemaining = current.remaining_amount ?? baseAmount
          newRemainingAmount = Math.max(0, currentRemaining - feeAmount)
          newState = current.state // state stays (voucher still usable)
          outcome = "partial_fee"
          await client.query(
            `UPDATE entitlement_instance SET remaining_amount = $2, updated_at = NOW() WHERE id = $1`,
            [entitlement_id, newRemainingAmount]
          )
          break
        }
        case "charge_full": {
          // charge 100% — voucher consumed; semantics: VOIDED (no residual value)
          feeAmount = baseAmount
          newRemainingAmount = 0
          newState = EntitlementInstanceState.VOIDED
          assertTransition(current.state, EntitlementInstanceState.VOIDED)
          outcome = "charge_full"
          await client.query(
            `UPDATE entitlement_instance
             SET state = $2, remaining_amount = 0, updated_at = NOW()
             WHERE id = $1`,
            [entitlement_id, newState]
          )
          break
        }
        case "no_charge": {
          // No penalty; entitlement remains usable (state unchanged)
          newState = current.state
          outcome = "no_charge"
          // no DB state change — just emit audit event
          break
        }
        case "vendor_decision": {
          assertTransition(current.state, EntitlementInstanceState.PENDING_VENDOR_DECISION)
          newState = EntitlementInstanceState.PENDING_VENDOR_DECISION
          outcome = "vendor_decision"
          await client.query(
            `UPDATE entitlement_instance SET state = $2, updated_at = NOW() WHERE id = $1`,
            [entitlement_id, newState]
          )
          break
        }
        default: {
          // Unknown policy value — fail loud (architecture fail-loud pattern)
          throw new Error(
            `VoucherService.mark_no_show: unknown no_show policy '${policyValue}' on instance ${entitlement_id}`
          )
        }
      }

      // Emit audit event AFTER state mutation (HG-4 backwards compat)
      const eventPayload: Record<string, unknown> = {
        entitlement_id,
        outcome,
        no_show_policy: policyValue,
        reason: input.reason,
        marked_at: markedAt,
        resulting_state: newState,
        ...(feeAmount !== undefined ? { fee_amount: feeAmount } : {}),
        ...(snapshotChargePct && policyValue !== "no_charge"
          ? { charge_pct: snapshotChargePct }
          : {}),
        ...(baseAmount > 0 ? { base_amount: baseAmount } : {}),
        ...(newRemainingAmount !== undefined
          ? { remaining_amount: newRemainingAmount }
          : {}),
        ...(input.actor ? { admin_user_id: input.actor } : {}),
      }
      await this.emitEntitlementNoShow(client, eventPayload)

      await client.query("COMMIT")
      committed = true

      return {
        entitlement_id,
        outcome,
        no_show_policy: policyValue,
        resulting_state: newState,
        ...(feeAmount !== undefined ? { fee_amount: feeAmount } : {}),
        ...(snapshotChargePct ? { charge_pct: snapshotChargePct } : {}),
        ...(baseAmount > 0 ? { base_amount: baseAmount } : {}),
        ...(newRemainingAmount !== undefined
          ? { remaining_amount: newRemainingAmount }
          : {}),
        marked_at: markedAt,
      }
    } catch (err) {
      if (!committed) {
        await client.query("ROLLBACK")
      }
      throw err
    } finally {
      client.release()
    }
  }

  async claim(
    code: string,
    opts: { now?: Date; client?: Queryable } = {}
  ): Promise<ClaimResult> {
    const now = opts.now ?? new Date()
    const txClient = opts.client ?? null

    // v1.9.0 Wave F6 HIGH-09 — the previous unlocked existence/expiry/already-
    // claimed pre-check formed a TOCTOU window with the FOR UPDATE block
    // below. We keep the cheap getByCode for the "not_found" early-out
    // (the FOR UPDATE on a missing row also returns 0 rows so the result is
    // equivalent, but the early-out spares the connection acquisition) and
    // move expiry / already-claimed branching INSIDE the lock so all state
    // observations come from the same locked snapshot.
    const voucher = txClient
      ? await this.getByCodeWithClient(txClient, code)
      : await this.getByCode(code)
    if (!voucher) return { status: "not_found", voucher: null }

    // F2 fix: Atomic status transition + event append in a transaction.
    // Use SELECT ... FOR UPDATE to lock the row, then conditional UPDATE
    // gated on status<>'claimed' so concurrent callers cannot double-fire
    // the `claimed` event.
    const client = txClient ?? await this.getPool().connect()
    let didTransition = false
    try {
      if (!txClient) await client.query("BEGIN")
      const lockRes = await client.query<{ status: string; expires_at: Date | null }>(
        `SELECT status, expires_at FROM voucher WHERE code = $1 FOR UPDATE`,
        [code]
      )
      if (lockRes.rows.length === 0) {
        if (!txClient) await client.query("ROLLBACK")
        return { status: "not_found", voucher: null }
      }
      const lockedStatus = lockRes.rows[0].status
      const lockedExpires = lockRes.rows[0].expires_at
        ? new Date(lockRes.rows[0].expires_at)
        : null
      if (lockedStatus === "claimed") {
        if (!txClient) await client.query("ROLLBACK")
        const current = txClient
          ? await this.getByCodeWithClient(txClient, code)
          : await this.getByCode(code)
        return { status: "already_claimed", voucher: current ?? voucher }
      }
      if (lockedExpires && lockedExpires < now) {
        if (!txClient) await client.query("ROLLBACK")
        const current = txClient
          ? await this.getByCodeWithClient(txClient, code)
          : await this.getByCode(code)
        return { status: "expired", voucher: current ?? voucher }
      }
      const updRes = await client.query(
        `UPDATE voucher SET status = 'claimed', updated_at = NOW()
         WHERE code = $1 AND status <> 'claimed'`,
        [code]
      )
      if ((updRes.rowCount ?? 0) > 0) {
        const eventId = randomUUID()
        await client.query(
          `INSERT INTO voucher_event (id, voucher_code, event_type, occurred_at, created_at)
           VALUES ($1, $2, 'claimed', $3, NOW())`,
          [eventId, code, now]
        )
        didTransition = true
      }
      if (!txClient) await client.query("COMMIT")
    } catch (err) {
      if (!txClient) await client.query("ROLLBACK")
      throw err
    } finally {
      if (!txClient) (client as PoolClient).release()
    }

    const updated = txClient
      ? await this.getByCodeWithClient(txClient, code)
      : await this.getByCode(code)
    if (!updated) throw new Error(`VoucherService.claim: failed to read back ${code}`)
    if (!didTransition) {
      // Race lost — a concurrent caller already transitioned to claimed.
      return { status: "already_claimed", voucher: updated }
    }
    return { status: "claimed", voucher: updated }
  }

  async extend(
    entitlementId: string,
    input: ExtendEntitlementInput | boolean
  ): Promise<ExtendEntitlementResult> {
    const opts: ExtendEntitlementInput =
      typeof input === "boolean" ? { paid: input } : input
    const now = opts.now ?? new Date()
    const actor = opts.actor ?? "system"
    const source = opts.source ?? "voucher.extend"
    const client = await this.getPool().connect()

    // committed tracks whether COMMIT succeeded so the catch block does not
    // attempt ROLLBACK on an already-committed transaction.
    let committed = false
    let event: EntitlementExtendedEnvelope | undefined
    try {
      await client.query("BEGIN")
      const result = await (client as Queryable).query(
        `SELECT id, entitlement_profile_id, entitlement_type, order_id, state,
                policy_snapshot, expires_at, unpaid_extension_count, created_at, updated_at
           FROM entitlement_instance
          WHERE id = $1
          FOR UPDATE`,
        [entitlementId]
      )
      if (result.rows.length === 0) {
        throw new EntitlementExtensionError(
          "ENTITLEMENT_NOT_FOUND",
          `entitlement_instance '${entitlementId}' was not found`,
          { entitlement_id: entitlementId }
        )
      }

      const row = this.rowToEntitlementInstance(result.rows[0])
      const extension = this.extensionPolicyFromSnapshot(row.policy_snapshot)
      this.assertCanExtend(row, extension, opts.paid)

      const previousExpiresAt = row.expires_at
      if (!previousExpiresAt) {
        throw new EntitlementExtensionError(
          "EXPIRES_AT_REQUIRED",
          "entitlement_instance.expires_at is required before extension",
          { entitlement_id: entitlementId }
        )
      }

      const newExpiresAt = this.addMonths(
        previousExpiresAt,
        extension.max_extension_months
      )
      const platformMaxExpiresAt = this.addMonths(
        row.created_at,
        validityMonthsMax(row.entitlement_type)
      )
      if (newExpiresAt > platformMaxExpiresAt) {
        throw new EntitlementExtensionError(
          "VALIDITY_BOUNDARY_EXCEEDED",
          "extension would exceed entitlement_type validity_months_max",
          {
            entitlement_id: entitlementId,
            new_expires_at: newExpiresAt.toISOString(),
            platform_max_expires_at: platformMaxExpiresAt.toISOString(),
          }
        )
      }

      const unpaidExtensionCount = opts.paid
        ? row.unpaid_extension_count
        : row.unpaid_extension_count + 1

      await (client as Queryable).query(
        `UPDATE entitlement_instance
            SET expires_at = $2,
                unpaid_extension_count = $3,
                updated_at = NOW()
          WHERE id = $1`,
        [entitlementId, newExpiresAt, unpaidExtensionCount]
      )

      event = {
        event: ENTITLEMENT_EXTENDED_EVENT,
        entitlement_id: row.entitlement_profile_id,
        entitlement_instance_id: row.id,
        paid: opts.paid,
        ...(opts.paid ? { fee_pct: extension.fee_pct } : {}),
        previous_expires_at: previousExpiresAt.toISOString(),
        new_expires_at: newExpiresAt.toISOString(),
        actor,
        source,
        timestamp: now.toISOString(),
      }

      // COMMIT before emitting — ensures the event is only broadcast when the
      // DB mutation is durable (AC2 atomicity: no partial state on COMMIT
      // failure, M1 fix).
      await client.query("COMMIT")
      committed = true

      await this.emitEntitlementExtended(event)

      return {
        entitlement_id: row.entitlement_profile_id,
        entitlement_instance_id: row.id,
        paid: opts.paid,
        ...(opts.paid ? { fee_pct: extension.fee_pct } : {}),
        previous_expires_at: previousExpiresAt,
        new_expires_at: newExpiresAt,
        unpaid_extension_count: unpaidExtensionCount,
        event,
      }
    } catch (err) {
      if (!committed) {
        await client.query("ROLLBACK")
      }
      throw err
    } finally {
      client.release()
    }
  }

  private async emitRefundApplied(envelope: RefundAppliedEnvelope): Promise<void> {
    if (!this.eventBus_) {
      throw new EntitlementRefundError(
        "EVENT_BUS_REQUIRED",
        "refund_request requires Medusa event bus"
      )
    }
    await this.eventBus_.emit({ name: ENTITLEMENT_REFUND_APPLIED_EVENT, data: envelope })
  }

  /**
   * Route a refund request to the correct channel per the entitlement's
   * policy_snapshot (immutable post-ISSUED, regulamin § 12).
   *
   * Channels:
   * - original_payment → register routing decision + emit audit event;
   *   delegates to native Medusa payment-refund path consumed by Story 1.3
   *   subscriber. Does NOT call Stripe refund.create (OOS v1.8.0).
   * - store_credit → increment customer.metadata.gp.store_credit
   * - vendor_wallet → increment vendor.metadata.wallet
   *
   * Idempotent: a duplicate call with the same refund_id returns the same
   * result without re-applying the effect.
   */
  async refund_request(
    entitlementId: string,
    input: RefundRequestInput
  ): Promise<RefundRequestResult> {
    // F-02 fix: validate amount is a positive integer (minor units).
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new EntitlementRefundError(
        "INVALID_REFUND_AMOUNT",
        `refund amount must be a positive integer (minor units), got ${input.amount}`,
        { entitlement_id: entitlementId, amount: input.amount }
      )
    }

    // F-05 fix: validate currency is a 3-character ISO 4217 code.
    if (!/^[A-Z]{3}$/.test(input.currency)) {
      throw new EntitlementRefundError(
        "INVALID_CURRENCY",
        `currency must be a 3-character ISO 4217 code (uppercase), got '${input.currency}'`,
        { entitlement_id: entitlementId, currency: input.currency }
      )
    }

    const actor = input.actor ?? "system"
    const now = new Date()
    const idempotencyKey = `entitlement:${entitlementId}:refund_applied:${input.refund_id}`

    const pool = this.getPool()
    const client = await pool.connect()
    let committed = false
    let envelope: RefundAppliedEnvelope | undefined

    try {
      await client.query("BEGIN")

      // F-06 fix: idempotency check moved inside the transaction (after BEGIN)
      // to close the TOCTOU race window between check and effect. Both read and
      // insert execute under the same client transaction.
      const existingEvent = await (client as Queryable).query<Record<string, unknown>>(
        `SELECT payload FROM voucher_event
          WHERE entitlement_id = $1
            AND event_type = $2
            AND payload->>'refund_id' = $3
          LIMIT 1`,
        [entitlementId, ENTITLEMENT_REFUND_APPLIED_EVENT, input.refund_id]
      )
      if ((existingEvent.rowCount ?? 0) > 0) {
        await client.query("ROLLBACK")
        const p = existingEvent.rows[0].payload as RefundAppliedPayload
        const idempotentEnvelope: RefundAppliedEnvelope = {
          schema_version: "1",
          event_type: ENTITLEMENT_REFUND_APPLIED_EVENT,
          occurred_at: p.applied_at,
          actor,
          idempotency_key: idempotencyKey,
          // F-01 fix: use actual entitlement instance ID, not hardcoded "gp-dev".
          scope: { instance_id: entitlementId },
          payload: p,
        }
        return {
          entitlement_id: entitlementId,
          refund_id: input.refund_id,
          refund_channel: p.refund_channel,
          amount: p.refunded_amount_minor,
          currency: p.currency,
          idempotent: true,
          event: idempotentEnvelope,
        }
      }

      const result = await (client as Queryable).query(
        `SELECT id, entitlement_profile_id, order_id, state, policy_snapshot,
                created_at, updated_at
           FROM entitlement_instance
          WHERE id = $1
          FOR UPDATE`,
        [entitlementId]
      )
      if (result.rows.length === 0) {
        throw new EntitlementRefundError(
          "ENTITLEMENT_NOT_FOUND",
          `entitlement_instance '${entitlementId}' was not found`,
          { entitlement_id: entitlementId }
        )
      }

      const row = this.rowToEntitlementInstance(result.rows[0])

      // F-04 fix: guard against refund on terminal/invalid states.
      if (!REFUNDABLE_STATES.has(row.state)) {
        throw new EntitlementRefundError(
          "INVALID_ENTITLEMENT_STATE_FOR_REFUND",
          `entitlement_instance '${entitlementId}' is in state ${row.state} which does not allow refund processing`,
          { entitlement_id: entitlementId, state: row.state }
        )
      }

      const snapshot = row.policy_snapshot as Record<string, unknown>
      const rawChannel = snapshot.refund_channel

      if (
        rawChannel === undefined ||
        !(REFUND_CHANNELS as readonly string[]).includes(rawChannel as string)
      ) {
        throw new EntitlementRefundError(
          "UNKNOWN_REFUND_CHANNEL",
          `policy_snapshot.refund_channel '${String(rawChannel)}' is not a supported refund channel`,
          { entitlement_id: entitlementId, refund_channel: rawChannel }
        )
      }

      const refundChannel = rawChannel as RefundChannel
      const appliedAt = now.toISOString()

      if (refundChannel === "store_credit") {
        // Increment customer.metadata.gp.store_credit (minor units, currency-aware).
        // Note: the nested jsonb_set correctly uses the original customer metadata
        // in the COALESCE — PostgreSQL evaluates all SET expressions against the
        // pre-UPDATE row state, so the inner jsonb_set result is threaded as the
        // first argument to the outer one while COALESCE reads the original value.
        // This is intentional and correct PostgreSQL behavior.
        await (client as Queryable).query(
          `UPDATE customer
              SET metadata = jsonb_set(
                    jsonb_set(
                      COALESCE(customer.metadata, '{}'::jsonb),
                      '{gp}',
                      COALESCE(customer.metadata->'gp', '{}'::jsonb),
                      true
                    ),
                    '{gp,store_credit}',
                    to_jsonb(
                      COALESCE((customer.metadata->'gp'->>'store_credit')::bigint, 0) + $2
                    ),
                    true
                  ),
                  updated_at = NOW()
            FROM "order" o
           WHERE customer.id = o.customer_id
             AND o.id = (SELECT order_id FROM entitlement_instance WHERE id = $1)`,
          [entitlementId, input.amount]
        )
      } else if (refundChannel === "vendor_wallet") {
        // v1.9.0 Wave F6 HIGH-03 — Story 2.1 AC: entitlement_profiles is a
        // DECLARATIVE YAML CONFIG (gp-ops market.yaml), NOT a DB table. The
        // previous JOIN against `entitlement_profiles` raised
        // `relation "entitlement_profiles" does not exist` at runtime. Fix:
        // resolve the vendor (seller) directly from the order line item's
        // seller_id, which Mercur stores per line on `order_item`. This drops
        // the dependency on the non-existent DB table.
        //
        // Multi-line carts: each line has its own seller; the refund increments
        // the wallet of every seller proportionally (one UPDATE per matching
        // seller_id). The current implementation picks the first seller for
        // the order; for v1.8.0 BonBeauty MVP all line items in an order share
        // the same seller, so this collapses to a single increment. v1.10.0+
        // multi-seller orders need a per-line refund routing decision (deferred
        // to a follow-up ADR).
        await (client as Queryable).query(
          `WITH target_seller AS (
             SELECT (oi.metadata->>'seller_id') AS seller_id
               FROM entitlement_instance ei
               JOIN order_item oi ON oi.order_id = ei.order_id
              WHERE ei.id = $1
                AND oi.deleted_at IS NULL
                AND oi.metadata ? 'seller_id'
              ORDER BY oi.created_at ASC
              LIMIT 1
           )
           UPDATE seller
              SET metadata = jsonb_set(
                    COALESCE(seller.metadata, '{}'::jsonb),
                    '{wallet}',
                    to_jsonb(
                      COALESCE((seller.metadata->>'wallet')::bigint, 0) + $2
                    ),
                    true
                  ),
                  updated_at = NOW()
             FROM target_seller ts
            WHERE seller.id = ts.seller_id`,
          [entitlementId, input.amount]
        )
      }
      // original_payment: register routing decision + emit audit. No Stripe
      // refund.create call (OOS v1.8.0 — Story 1.8 manual + webhook consume;
      // automation named_retry_slot: v1.10.0+).

      const payload: RefundAppliedPayload = {
        entitlement_id: entitlementId,
        refund_id: input.refund_id,
        applied_at: appliedAt,
        currency: input.currency,
        refunded_amount_minor: input.amount,
        refund_channel: refundChannel,
        ...(row.order_id ? { order_id: row.order_id } : {}),
      }

      // Persist event record for idempotency tracking.
      await (client as Queryable).query(
        `INSERT INTO voucher_event
           (id, voucher_code, entitlement_id, event_type, payload, occurred_at, created_at)
         VALUES ($1, NULL, $2, $3, $4::jsonb, $5, NOW())`,
        [
          randomUUID(),
          entitlementId,
          ENTITLEMENT_REFUND_APPLIED_EVENT,
          JSON.stringify(payload),
          now,
        ]
      )

      envelope = {
        schema_version: "1",
        event_type: ENTITLEMENT_REFUND_APPLIED_EVENT,
        occurred_at: appliedAt,
        actor,
        idempotency_key: idempotencyKey,
        // F-01 fix: use actual entitlement instance ID, not hardcoded "gp-dev".
        scope: { instance_id: entitlementId },
        payload,
      }

      await client.query("COMMIT")
      committed = true

      await this.emitRefundApplied(envelope)

      return {
        entitlement_id: entitlementId,
        refund_id: input.refund_id,
        refund_channel: refundChannel,
        amount: input.amount,
        currency: input.currency,
        idempotent: false,
        event: envelope,
      }
    } catch (err) {
      if (!committed) {
        await client.query("ROLLBACK")
      }
      throw err
    } finally {
      client.release()
    }
  }

  private assertCanExtend(
    row: EntitlementInstanceRow,
    extension: ExtensionPolicy,
    paid: boolean
  ): void {
    if (row.state !== EntitlementInstanceState.ACTIVE) {
      throw new EntitlementExtensionError(
        "INVALID_ENTITLEMENT_STATE",
        "voucher extension is allowed only for ACTIVE entitlement instances",
        { entitlement_id: row.id, state: row.state }
      )
    }

    if (!extension.allowed) {
      throw new EntitlementExtensionError(
        "EXTENSION_NOT_ALLOWED",
        "policy_snapshot.extension.allowed is false",
        { entitlement_id: row.id }
      )
    }

    if (paid && !extension.paid) {
      throw new EntitlementExtensionError(
        "PAID_EXTENSION_NOT_ALLOWED",
        "policy_snapshot.extension.paid is false",
        { entitlement_id: row.id }
      )
    }

    if (!paid && row.unpaid_extension_count >= 1) {
      throw new EntitlementExtensionError(
        "UNPAID_EXTENSION_LIMIT_EXCEEDED",
        "voucher can be extended for free at most once",
        {
          entitlement_id: row.id,
          unpaid_extension_count: row.unpaid_extension_count,
        }
      )
    }

    if (
      paid &&
      (extension.fee_pct < ENTITLEMENT_BOUNDARY.policy.extension.fee_pct_min ||
        extension.fee_pct > ENTITLEMENT_BOUNDARY.policy.extension.fee_pct_max)
    ) {
      throw new EntitlementExtensionError(
        "EXTENSION_FEE_BOUNDARY_VIOLATION",
        "paid voucher extension fee_pct must be within GP boundary",
        {
          entitlement_id: row.id,
          fee_pct: extension.fee_pct,
          min: ENTITLEMENT_BOUNDARY.policy.extension.fee_pct_min,
          max: ENTITLEMENT_BOUNDARY.policy.extension.fee_pct_max,
        }
      )
    }

    if (
      extension.max_extension_months < 1 ||
      extension.max_extension_months > ENTITLEMENT_BOUNDARY.validity_months_max
    ) {
      throw new EntitlementExtensionError(
        "MAX_EXTENSION_MONTHS_BOUNDARY_VIOLATION",
        "policy_snapshot.extension.max_extension_months outside GP boundary",
        {
          entitlement_id: row.id,
          max_extension_months: extension.max_extension_months,
        }
      )
    }
  }
}

export default VoucherService
