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
import { ENTITLEMENT_BOUNDARY, validityMonthsMax } from "./entitlement-boundary"

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
      state: row.state as EntitlementInstanceState,
      booking_pointer: (row.booking_pointer ?? null) as string | null,
      policy_snapshot: this.toPolicySnapshot(row.policy_snapshot),
      expires_at: this.toDate(row.expires_at as string | Date | null),
      unpaid_extension_count: Number(row.unpaid_extension_count ?? 0),
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

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async getByCode(code: string): Promise<VoucherWithEvents | null> {
    const pool = this.getPool()
    const vResult = await pool.query<Record<string, unknown>>(
      `SELECT * FROM voucher WHERE code = $1`,
      [code]
    )
    if (vResult.rows.length === 0) return null
    const voucher = this.rowToVoucher(vResult.rows[0])

    const eResult = await pool.query<Record<string, unknown>>(
      `SELECT * FROM voucher_event WHERE voucher_code = $1 ORDER BY occurred_at ASC`,
      [code]
    )
    return { ...voucher, events: eResult.rows.map((r) => this.rowToEvent(r)) }
  }

  async listCodes(): Promise<string[]> {
    const result = await this.getPool().query<{ code: string }>(
      `SELECT code FROM voucher ORDER BY created_at ASC`
    )
    return result.rows.map((r) => r.code)
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

  async cancel_booking(entitlement_id: string): Promise<EntitlementInstanceResult> {
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

      const updateRes = await client.query<Record<string, unknown>>(
        `UPDATE entitlement_instance
         SET booking_pointer = NULL,
             state = $2,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [entitlement_id, EntitlementInstanceState.ACTIVE]
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

      await client.query("COMMIT")
      return updated
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  }

  async claim(
    code: string,
    opts: { now?: Date } = {}
  ): Promise<ClaimResult> {
    const pool = this.getPool()
    const now = opts.now ?? new Date()

    const voucher = await this.getByCode(code)
    if (!voucher) return { status: "not_found", voucher: null }

    if (voucher.status === "claimed") {
      return { status: "already_claimed", voucher }
    }

    if (voucher.expires_at && voucher.expires_at < now) {
      return { status: "expired", voucher }
    }

    // F2 fix: Atomic status transition + event append in a transaction.
    // Use SELECT ... FOR UPDATE to lock the row, then conditional UPDATE
    // gated on status<>'claimed' so concurrent callers cannot double-fire
    // the `claimed` event.
    const client = await pool.connect()
    let didTransition = false
    try {
      await client.query("BEGIN")
      const lockRes = await client.query<{ status: string; expires_at: Date | null }>(
        `SELECT status, expires_at FROM voucher WHERE code = $1 FOR UPDATE`,
        [code]
      )
      if (lockRes.rows.length === 0) {
        await client.query("ROLLBACK")
        return { status: "not_found", voucher: null }
      }
      const lockedStatus = lockRes.rows[0].status
      const lockedExpires = lockRes.rows[0].expires_at
        ? new Date(lockRes.rows[0].expires_at)
        : null
      if (lockedStatus === "claimed") {
        await client.query("ROLLBACK")
        const current = await this.getByCode(code)
        return { status: "already_claimed", voucher: current ?? voucher }
      }
      if (lockedExpires && lockedExpires < now) {
        await client.query("ROLLBACK")
        const current = await this.getByCode(code)
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
      await client.query("COMMIT")
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }

    const updated = await this.getByCode(code)
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
