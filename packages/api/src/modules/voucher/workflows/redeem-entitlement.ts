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
import {
  assertTransferabilityAllowed,
  type RedeemContext,
} from "../entitlement-boundary"
import {
  ENTITLEMENT_STATE_CHANGED_EVENT_TYPE,
  emitTransitionEventAfterCommit,
  wireEntitlementTransitionPersisted,
  type TransitionAuditEnvelope,
  type TransitionEventEnvelope,
  type TransitionScope,
} from "../entitlement-transition-wiring"

export const ENTITLEMENT_REDEEMED_EVENT_TYPE =
  "gp.entitlements.entitlement_redeemed.v1" as const

export type RedeemEventEnvelope = {
  schema_version: "1"
  event_type: typeof ENTITLEMENT_REDEEMED_EVENT_TYPE
  occurred_at: string
  /** Must be one of the envelope.v1.schema.json `actor` enum values. */
  actor: "system"
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
  /**
   * v1.9.0 Wave F6 / HIGH-05: identity bound at ISSUED time. Drives
   * `assertTransferabilityAllowed` enforcement for `personalized`/`hybrid`
   * policies. Null = bearer-issued instance (legacy or explicit bearer).
   */
  recipient_customer_id?: string | null
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
  /**
   * v1.9.0 Wave F6 / HIGH-05: identity of the party attempting redemption.
   * Required for `personalized`/`hybrid` transferability enforcement. When the
   * upstream booking-confirmation event lacks customer identity (anonymous
   * bearer flows), pass `null` — `bearer` policies accept that; `personalized`
   * policies throw `TransferabilityError`.
   */
  redeeming_customer_id?: string | null
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
  appendAudit(audit: TransitionAuditEnvelope): Promise<void>
  updateEntitlementState(
    id: string,
    fromState: EntitlementInstanceState,
    toState: EntitlementInstanceState,
    now: Date
  ): Promise<void>
}

export type RedeemEntitlementEventEmitter = {
  emit: (envelope: RedeemEventEnvelope | TransitionEventEnvelope) => Promise<void>
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

      // v1.9.0 Wave F6 HIGH-05 — enforce transferability AFTER lock acquisition,
      // BEFORE any state transition. The guard reads from the immutable
      // policy_snapshot per regulamin § 12 (NOT the live profile). Throws
      // TransferabilityError on `personalized` mismatch; soft-flags `hybrid`
      // mismatch via return value (currently unused in auto-redeem flow but
      // captured for future audit hook).
      const redeemCtx: RedeemContext = {
        customer_id: input.redeeming_customer_id ?? null,
        recipient_customer_id: ent.recipient_customer_id ?? null,
      }
      assertTransferabilityAllowed(ent.policy_snapshot, redeemCtx)

      // Idempotency: already REDEEMED_FULL → no-op, do not re-emit.
      if (ent.state === EntitlementInstanceState.REDEEMED_FULL) {
        return {
          result: buildResult(ent, input, now, idempotencyKey, true),
          shouldEmit: false,
        }
      }

      const scope: TransitionScope = {
        instance_id: ent.id,
        market_id: ent.market_id ?? input.market_id ?? "unknown",
        sales_channel_id: null,
        vendor_id: null,
        location_id: null,
      }
      const transitionEvents: TransitionEventEnvelope[] = []

      // Step 1: ACTIVE → REDEMPTION_REQUESTED (skip if already there).
      if (ent.state === EntitlementInstanceState.ACTIVE) {
        assertTransition(
          EntitlementInstanceState.ACTIVE,
          EntitlementInstanceState.REDEMPTION_REQUESTED
        )
        const { event } = await wireEntitlementTransitionPersisted(
          { appendAudit: tx.appendAudit.bind(tx), clock: () => now },
          {
            from: EntitlementInstanceState.ACTIVE,
            to: EntitlementInstanceState.REDEMPTION_REQUESTED,
            entitlement_id: ent.id,
            scope,
            actor: "system",
            actor_hint: "system:auto-redeem:booking-confirm",
            occurred_at: now.toISOString(),
            transition_seq: `${idempotencyKey}:request`,
          }
        )
        await tx.updateEntitlementState(
          ent.id,
          EntitlementInstanceState.ACTIVE,
          EntitlementInstanceState.REDEMPTION_REQUESTED,
          now
        )
        transitionEvents.push(event)
      } else if (ent.state !== EntitlementInstanceState.REDEMPTION_REQUESTED) {
        // State does not allow transition to REDEEMED_FULL — throws EntitlementTransitionError.
        assertTransition(ent.state, EntitlementInstanceState.REDEEMED_FULL)
      }

      // Step 2: REDEMPTION_REQUESTED → REDEEMED_FULL.
      assertTransition(
        EntitlementInstanceState.REDEMPTION_REQUESTED,
        EntitlementInstanceState.REDEEMED_FULL
      )
      const { event } = await wireEntitlementTransitionPersisted(
        { appendAudit: tx.appendAudit.bind(tx), clock: () => now },
        {
          from: EntitlementInstanceState.REDEMPTION_REQUESTED,
          to: EntitlementInstanceState.REDEEMED_FULL,
          entitlement_id: ent.id,
          scope,
          actor: "system",
          actor_hint: "system:auto-redeem:booking-confirm",
          occurred_at: now.toISOString(),
          transition_seq: `${idempotencyKey}:redeem`,
        }
      )
      await tx.updateEntitlementState(
        ent.id,
        EntitlementInstanceState.REDEMPTION_REQUESTED,
        EntitlementInstanceState.REDEEMED_FULL,
        now
      )
      transitionEvents.push(event)

      return {
        result: buildResult(ent, input, now, idempotencyKey, false),
        shouldEmit: true,
        transitionEvents,
      }
    })

    if (result.shouldEmit) {
      // Post-COMMIT emit (cross-cut #3). Transition events use the shared
      // best-effort helper, so a double emit failure never creates a phantom
      // pre-commit event and does not roll back the committed state.
      for (const event of result.transitionEvents ?? []) {
        await emitTransitionEventAfterCommit(this.events.emit, event)
      }

      // Legacy redeemed event remains observable for existing subscribers.
      // Best-effort retry; propagates on
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
  // NOTE (L2): market_id is not in the entitlement_instance DDL (confirmed by T0 recon:
  // DDL = id, entitlement_profile_id, entitlement_type, order_id, state, policy_snapshot,
  // created_at, updated_at). So ent.market_id will always be null/undefined until the
  // column is added. At wiring time (v1.9.0+), pass market_id via RedeemEntitlementInput
  // from the booking-confirmation event context.
  const resolvedMarketId = ent.market_id ?? input.market_id
  if (!resolvedMarketId) {
    // "unknown" satisfies schema minLength:1 but is semantically incorrect.
    // This fallback must be resolved when the subscriber is wired to a real event.
    // Apply-path: derive market_id from the booking-confirmation event payload.
  }
  const event: RedeemEventEnvelope = {
    schema_version: "1",
    event_type: ENTITLEMENT_REDEEMED_EVENT_TYPE,
    occurred_at: occurredAt,
    // "system" is the correct envelope.v1.schema.json enum value for automated actors.
    // The actor_hint in payload carries the specific sub-actor identity.
    actor: "system",
    scope: {
      instance_id: ent.id,
      market_id: resolvedMarketId ?? "unknown",
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
    // v1.9.0 Wave F6 HIGH-05 — surface recipient_customer_id so the
    // transferability guard can resolve `personalized` mismatch at the
    // redemption point.
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT id, state, policy_snapshot, order_id, market_id, recipient_customer_id
         FROM entitlement_instance
        WHERE id = $1
        FOR UPDATE`,
      [id]
    )
    const row = result.rows[0]
    if (!row) return null
    const rawSnapshot = row.policy_snapshot
    if (
      rawSnapshot === null ||
      rawSnapshot === undefined ||
      typeof rawSnapshot !== "object" ||
      Array.isArray(rawSnapshot)
    ) {
      throw new Error(
        `entitlement_instance ${row.id as string}: policy_snapshot is not a valid object ` +
          `(got ${rawSnapshot === null ? "null" : typeof rawSnapshot})`
      )
    }
    return {
      id: row.id as string,
      state: row.state as EntitlementInstanceState,
      policy_snapshot: snapshotPolicy(rawSnapshot as Record<string, unknown>),
      order_id: (row.order_id ?? null) as string | null,
      market_id: (row.market_id ?? null) as string | null,
      recipient_customer_id: (row.recipient_customer_id ?? null) as string | null,
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

  async appendAudit(audit: TransitionAuditEnvelope): Promise<void> {
    await this.client.query(
      `INSERT INTO voucher_event (id, voucher_code, entitlement_id, event_type, payload, occurred_at, created_at)
       VALUES ($1, NULL, $2, $3, $4::jsonb, $5, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        audit.idempotency_key,
        audit.entitlement_id,
        audit.event_type,
        JSON.stringify(audit),
        audit.occurred_at,
      ]
    )
  }
}

// ---------------------------------------------------------------------------
// In-memory store (testing)
// ---------------------------------------------------------------------------

export class InMemoryRedeemEntitlementStore implements RedeemEntitlementStore {
  private rows: Map<string, RedeemableEntitlement>
  private audits: TransitionAuditEnvelope[]

  constructor(rows: RedeemableEntitlement[] = []) {
    this.rows = new Map(rows.map((r) => [r.id, { ...r }]))
    this.audits = []
  }

  get(id: string): RedeemableEntitlement | undefined {
    return this.rows.get(id)
  }

  listAudits(): TransitionAuditEnvelope[] {
    return [...this.audits]
  }

  async withTransaction<T>(
    fn: (tx: RedeemEntitlementTx) => Promise<T>
  ): Promise<T> {
    const snapshot = new Map(
      [...this.rows.entries()].map(([id, r]) => [id, { ...r }])
    )
    const auditsLen = this.audits.length
    try {
      return await fn(new InMemoryRedeemEntitlementTx(this.rows, this.audits))
    } catch (err) {
      this.rows = snapshot
      this.audits.length = auditsLen
      throw err
    }
  }
}

class InMemoryRedeemEntitlementTx implements RedeemEntitlementTx {
  constructor(
    private readonly rows: Map<string, RedeemableEntitlement>,
    private readonly audits: TransitionAuditEnvelope[]
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

  async appendAudit(audit: TransitionAuditEnvelope): Promise<void> {
    this.audits.push(audit)
  }
}

// ---------------------------------------------------------------------------
// Factory (production container wiring)
// ---------------------------------------------------------------------------

type EventBusLike = {
  emit?: (message: {
    name: string
    data: RedeemEventEnvelope | TransitionEventEnvelope
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
          name:
            envelope.event_type === ENTITLEMENT_STATE_CHANGED_EVENT_TYPE
              ? ENTITLEMENT_STATE_CHANGED_EVENT_TYPE
              : ENTITLEMENT_REDEEMED_EVENT_TYPE,
          data: envelope,
        })
      },
    }
  )
}
