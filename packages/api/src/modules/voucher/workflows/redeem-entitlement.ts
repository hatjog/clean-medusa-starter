/**
 * redeem-entitlement — minimal idempotent full-redeem workflow (BE-8, Story 2.9).
 *
 * Performs a two-step atomic state transition:
 *   ACTIVE → REDEMPTION_REQUESTED → REDEEMED_FULL
 *
 * Idempotency: if the entitlement is already REDEEMED_FULL the workflow
 * returns an idempotent result without re-emitting the event. If the state
 * machine rejects the transition (EntitlementTransitionError) the caller
 * (subscriber) treats it as an idempotent no-op per AC4.
 *
 * Follows the class-based workflow pattern established by reissue-lost-code.ts
 * (same deviation note M1: hand-rolled BEGIN/COMMIT gives a single transaction
 * scope; event emit is post-COMMIT with one retry for best-effort durability).
 */

import { createHash } from "node:crypto"
import { Modules } from "@medusajs/framework/utils"

import {
  EntitlementInstanceState,
  assertTransition,
  snapshotPolicy,
  type EntitlementPolicySnapshot,
} from "../models/entitlement"

export const ENTITLEMENT_REDEEMED_EVENT_TYPE =
  "gp.entitlements.entitlement_redeemed.v1" as const

export type RedeemEventEnvelope = {
  schema_version: "1"
  event_type: typeof ENTITLEMENT_REDEEMED_EVENT_TYPE
  occurred_at: string
  actor: "system:auto-redeem"
  scope: {
    instance_id: string
    market_id: string
    vendor_id?: string | null
    location_id?: string | null
  }
  idempotency_key: string
  payload: {
    entitlement_id: string
    redemption_id: string
    redeemed_at: string
    currency: string
    amount_minor: number
    remaining_minor_after: 0
    new_status: "REDEEMED"
    idempotency_key: string
    actor_hint: string
  }
}

export type RedeemableEntitlement = {
  id: string
  state: EntitlementInstanceState
  policy_snapshot: EntitlementPolicySnapshot
  order_id: string | null
  market_id?: string | null
}

export type RedeemEntitlementInput = {
  entitlement_id: string
  /** Booking reference used to build a deterministic idempotency_key. */
  booking_ref: string
  /**
   * Currency code for the event payload.
   * Defaults to "PLN" (BonBeauty market); should be derived from market context
   * when the subscriber is wired to a real booking-confirmation event.
   */
  currency?: string
  /**
   * Service units consumed. Defaults to 1 (VOUCHER_SERVICE = 1 service unit).
   * Minimum 1 per entitlement_redeemed.v1 schema constraint.
   */
  amount_minor?: number
  market_id?: string | null
  now?: Date
}

export type RedeemEntitlementResult = {
  entitlement_id: string
  new_state: EntitlementInstanceState.REDEEMED_FULL
  event: RedeemEventEnvelope
  idempotent: boolean
}

export class EntitlementNotFoundError extends Error {
  constructor(id: string) {
    super(`entitlement_instance ${id} was not found`)
    this.name = "EntitlementNotFoundError"
  }
}

export interface RedeemEntitlementStore {
  withTransaction<T>(
    fn: (tx: RedeemEntitlementTx) => Promise<T>
  ): Promise<T>
}

export interface RedeemEntitlementTx {
  getEntitlementForUpdate(id: string): Promise<RedeemableEntitlement | null>
  updateEntitlementState(
    id: string,
    fromState: EntitlementInstanceState,
    toState: EntitlementInstanceState,
    now: Date
  ): Promise<void>
}

export type RedeemEntitlementEventEmitter = {
  emit: (envelope: RedeemEventEnvelope) => Promise<void>
}

export class RedeemEntitlementWorkflow {
  constructor(
    private readonly store: RedeemEntitlementStore,
    private readonly events: RedeemEntitlementEventEmitter
  ) {}

  async redeem(
    input: RedeemEntitlementInput
  ): Promise<RedeemEntitlementResult> {
    const now = input.now ?? new Date()
    const idempotencyKey = buildIdempotencyKey(
      input.entitlement_id,
      input.booking_ref
    )

    const result = await this.store.withTransaction(async (tx) => {
      const ent = await tx.getEntitlementForUpdate(input.entitlement_id)
      if (!ent) throw new EntitlementNotFoundError(input.entitlement_id)

      // Idempotency: already REDEEMED_FULL → no-op, do not re-emit.
      if (ent.state === EntitlementInstanceState.REDEEMED_FULL) {
        return {
          result: buildResult(ent, input, now, idempotencyKey, true),
          shouldEmit: false,
        }
      }

      // Step 1: ACTIVE → REDEMPTION_REQUESTED (skip if already there).
      if (ent.state === EntitlementInstanceState.ACTIVE) {
        assertTransition(
          EntitlementInstanceState.ACTIVE,
          EntitlementInstanceState.REDEMPTION_REQUESTED
        )
        await tx.updateEntitlementState(
          ent.id,
          EntitlementInstanceState.ACTIVE,
          EntitlementInstanceState.REDEMPTION_REQUESTED,
          now
        )
      } else if (ent.state !== EntitlementInstanceState.REDEMPTION_REQUESTED) {
        // State does not allow transition to REDEEMED_FULL — throws EntitlementTransitionError.
        assertTransition(ent.state, EntitlementInstanceState.REDEEMED_FULL)
      }

      // Step 2: REDEMPTION_REQUESTED → REDEEMED_FULL.
      assertTransition(
        EntitlementInstanceState.REDEMPTION_REQUESTED,
        EntitlementInstanceState.REDEEMED_FULL
      )
      await tx.updateEntitlementState(
        ent.id,
        EntitlementInstanceState.REDEMPTION_REQUESTED,
        EntitlementInstanceState.REDEEMED_FULL,
        now
      )

      return {
        result: buildResult(ent, input, now, idempotencyKey, false),
        shouldEmit: true,
      }
    })

    if (result.shouldEmit) {
      // Post-COMMIT emit (cross-cut #3). Best-effort retry; propagates on
      // second failure so the caller observes the error (observable > silent drop).
      let emitError: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.events.emit(result.result.event)
          emitError = undefined
          break
        } catch (err) {
          emitError = err
        }
      }
      if (emitError !== undefined) {
        throw Object.assign(
          new Error(
            `Auto-redeem committed but event emit failed for ` +
              `idempotency_key=${result.result.event.idempotency_key} — ` +
              `state is mutated; retry the emit or check event bus. ` +
              `Underlying: ${emitError instanceof Error ? emitError.message : String(emitError)}`
          ),
          { cause: emitError }
        )
      }
    }

    return result.result
  }
}

function buildIdempotencyKey(entitlementId: string, bookingRef: string): string {
  return `entitlement:${entitlementId}:auto-redeem:${bookingRef}`
}

function buildRedemptionId(idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .toUpperCase()
  return `RDM-${digest.slice(0, 8)}`
}

function buildResult(
  ent: RedeemableEntitlement,
  input: RedeemEntitlementInput,
  now: Date,
  idempotencyKey: string,
  idempotent: boolean
): RedeemEntitlementResult {
  const occurredAt = now.toISOString()
  const redemptionId = buildRedemptionId(idempotencyKey)
  const event: RedeemEventEnvelope = {
    schema_version: "1",
    event_type: ENTITLEMENT_REDEEMED_EVENT_TYPE,
    occurred_at: occurredAt,
    actor: "system:auto-redeem",
    scope: {
      instance_id: ent.id,
      market_id: ent.market_id ?? input.market_id ?? "unknown",
    },
    idempotency_key: idempotencyKey,
    payload: {
      entitlement_id: ent.id,
      redemption_id: redemptionId,
      redeemed_at: occurredAt,
      // VOUCHER_SERVICE: 1 service unit consumed; currency is market-contextual.
      // When the subscriber is wired to a real booking-confirmation event,
      // currency should be resolved from market context.
      currency: input.currency ?? "PLN",
      amount_minor: input.amount_minor ?? 1,
      remaining_minor_after: 0,
      new_status: "REDEEMED",
      idempotency_key: idempotencyKey,
      actor_hint: "system:auto-redeem:booking-confirm",
    },
  }
  return {
    entitlement_id: ent.id,
    new_state: EntitlementInstanceState.REDEEMED_FULL,
    event,
    idempotent,
  }
}

// ---------------------------------------------------------------------------
// Postgres store (production wiring)
// ---------------------------------------------------------------------------

type QueryResult<T> = Promise<{ rows: T[]; rowCount?: number | null }>
type PgClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>
  ) => QueryResult<T>
  release: () => void
}
type PgPool = {
  connect: () => Promise<PgClient>
}

export class PostgresRedeemEntitlementStore implements RedeemEntitlementStore {
  constructor(private readonly pool: PgPool) {}

  async withTransaction<T>(
    fn: (tx: RedeemEntitlementTx) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const result = await fn(new PostgresRedeemEntitlementTx(client))
      await client.query("COMMIT")
      return result
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  }
}

class PostgresRedeemEntitlementTx implements RedeemEntitlementTx {
  constructor(private readonly client: PgClient) {}

  async getEntitlementForUpdate(
    id: string
  ): Promise<RedeemableEntitlement | null> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT id, state, policy_snapshot, order_id, market_id
         FROM entitlement_instance
        WHERE id = $1
        FOR UPDATE`,
      [id]
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      id: row.id as string,
      state: row.state as EntitlementInstanceState,
      policy_snapshot: snapshotPolicy(
        row.policy_snapshot as Record<string, unknown>
      ),
      order_id: (row.order_id ?? null) as string | null,
      market_id: (row.market_id ?? null) as string | null,
    }
  }

  async updateEntitlementState(
    id: string,
    fromState: EntitlementInstanceState,
    toState: EntitlementInstanceState,
    now: Date
  ): Promise<void> {
    const result = await this.client.query(
      `UPDATE entitlement_instance
          SET state = $3, updated_at = $4
        WHERE id = $1 AND state = $2`,
      [id, fromState, toState, now]
    )
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error(
        `updateEntitlementState ${id}: ${fromState}→${toState} affected ` +
          `${result.rowCount ?? 0} rows (expected 1)`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory store (testing)
// ---------------------------------------------------------------------------

export class InMemoryRedeemEntitlementStore implements RedeemEntitlementStore {
  private rows: Map<string, RedeemableEntitlement>

  constructor(rows: RedeemableEntitlement[] = []) {
    this.rows = new Map(rows.map((r) => [r.id, { ...r }]))
  }

  get(id: string): RedeemableEntitlement | undefined {
    return this.rows.get(id)
  }

  async withTransaction<T>(
    fn: (tx: RedeemEntitlementTx) => Promise<T>
  ): Promise<T> {
    const snapshot = new Map(
      [...this.rows.entries()].map(([id, r]) => [id, { ...r }])
    )
    try {
      return await fn(new InMemoryRedeemEntitlementTx(this.rows))
    } catch (err) {
      this.rows = snapshot
      throw err
    }
  }
}

class InMemoryRedeemEntitlementTx implements RedeemEntitlementTx {
  constructor(
    private readonly rows: Map<string, RedeemableEntitlement>
  ) {}

  async getEntitlementForUpdate(
    id: string
  ): Promise<RedeemableEntitlement | null> {
    const row = this.rows.get(id)
    return row ? { ...row } : null
  }

  async updateEntitlementState(
    id: string,
    fromState: EntitlementInstanceState,
    toState: EntitlementInstanceState,
    now: Date
  ): Promise<void> {
    const row = this.rows.get(id)
    if (!row || row.state !== fromState) {
      throw new Error(
        `updateEntitlementState ${id}: expected state ${fromState}, got ${row?.state ?? "not found"}`
      )
    }
    this.rows.set(id, { ...row, state: toState })
    void now
  }
}

// ---------------------------------------------------------------------------
// Factory (production container wiring)
// ---------------------------------------------------------------------------

type EventBusLike = {
  emit?: (message: {
    name: string
    data: RedeemEventEnvelope
  }) => Promise<unknown>
}

export function createRedeemEntitlementWorkflowFromScope(scope: {
  resolve: (key: string) => unknown
}): RedeemEntitlementWorkflow {
  const pool = scope.resolve("__pg_pool__") as PgPool
  let eventBus: EventBusLike | undefined
  try {
    eventBus = scope.resolve(Modules.EVENT_BUS) as EventBusLike
  } catch {
    eventBus = undefined
  }
  return new RedeemEntitlementWorkflow(
    new PostgresRedeemEntitlementStore(pool),
    {
      async emit(envelope) {
        await eventBus?.emit?.({
          name: ENTITLEMENT_REDEEMED_EVENT_TYPE,
          data: envelope,
        })
      },
    }
  )
}
