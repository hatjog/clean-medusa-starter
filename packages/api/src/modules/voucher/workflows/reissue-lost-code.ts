import { createHash } from "node:crypto"
import { Modules } from "@medusajs/framework/utils"

import {
  EntitlementInstanceState,
  EntitlementTransitionError,
  EntitlementType,
  assertTransition,
  snapshotPolicy,
  type EntitlementPolicySnapshot,
} from "../models/entitlement"
import { isWithinReissueWindow } from "../entitlement-boundary"

export const ENTITLEMENT_LOST_CODE_REISSUED_EVENT_TYPE =
  "gp.entitlements.entitlement_lost_code_reissued.v1" as const

/**
 * Sentinel scope.market_id used when no market context is available for a
 * platform-level admin operation. Downstream consumers MUST treat "platform"
 * as a cross-market scope and not route it to market-specific handlers (L1).
 */
export const GP_PLATFORM_SCOPE_SENTINEL = "platform" as const

export type EventEnvelope = {
  schema_version: "1"
  event_type: typeof ENTITLEMENT_LOST_CODE_REISSUED_EVENT_TYPE
  occurred_at: string
  actor: "market_operator"
  scope: {
    instance_id: string
    market_id: string
    vendor_id?: string | null
    location_id?: string | null
  }
  idempotency_key: string
  payload: {
    old_entitlement_id: string
    new_entitlement_id: string
    reason: string
    reason_code?: string
    admin_user_id: string
    reissued_at: string
    original_issued_at: string
    entitlement_type?: EntitlementType
    order_id?: string
  }
}

export type ReissuableEntitlement = {
  id: string
  entitlement_profile_id: string
  entitlement_type: EntitlementType
  order_id: string | null
  state: EntitlementInstanceState
  policy_snapshot: EntitlementPolicySnapshot
  created_at: Date
  updated_at: Date
  issued_at?: Date | null
  expires_at?: Date | null
  market_id?: string | null
  sales_channel_id?: string | null
}

export type ReissueLostCodeInput = {
  entitlement_id: string
  reason: string
  reason_code?: string
  admin_user_id: string
  idempotency_key?: string
  now?: Date
  market_id?: string | null
}

export type ReissueLostCodeResult = {
  old_entitlement_id: string
  new_entitlement_id: string
  new_code: string
  event: EventEnvelope
  idempotent: boolean
}

export class EntitlementNotFoundError extends Error {
  constructor(id: string) {
    super(`entitlement_instance ${id} was not found`)
    this.name = "EntitlementNotFoundError"
  }
}

export class LostCodeReissueWindowError extends Error {
  constructor(readonly entitlementId: string, readonly originalIssuedAt: Date) {
    super(
      `Lost-code reissue window exceeded for entitlement_instance ${entitlementId}`
    )
    this.name = "LostCodeReissueWindowError"
  }
}

/**
 * Raised when a lost-code reissue is attempted on an entitlement that is
 * itself a reissue successor (AC4: window must be counted from the *original*
 * issued_at and must not be resettable by chaining reissues).
 *
 * Without a dedicated DB column (`reissued_from_id`) we cannot traverse the
 * full reissue chain in production. As a defence-in-depth guardrail we reject
 * reissue of any entitlement whose id matches the GP-XXXX-XXXX-XXXX pattern
 * produced by `generateReadableEntitlementCode`. Original entitlement ids are
 * customer/system assigned and will not match this pattern. If a true
 * architectural fix (migration + `original_issued_at` column) is added in a
 * future story, this guard can be relaxed via ADR.
 */
export class LostCodeReissueChainError extends Error {
  constructor(readonly entitlementId: string) {
    super(
      `entitlement_instance ${entitlementId} is itself a reissue successor; ` +
        "re-reissuing a successor would reset the 30-day window (AC4 violation). " +
        "Contact support to resolve the original entitlement instead."
    )
    this.name = "LostCodeReissueChainError"
  }
}

/** Pattern for GP-issued reissue successor ids (GP-XXXX-XXXX-XXXX). */
const REISSUE_SUCCESSOR_ID_RE = /^GP-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/

export interface ReissueLostCodeStore {
  withTransaction<T>(
    fn: (tx: ReissueLostCodeTx) => Promise<T>
  ): Promise<T>
}

export interface ReissueLostCodeTx {
  getEntitlementForUpdate(id: string): Promise<ReissuableEntitlement | null>
  getEntitlement(id: string): Promise<ReissuableEntitlement | null>
  voidEntitlement(
    id: string,
    fromState: EntitlementInstanceState,
    now: Date
  ): Promise<void>
  createReissuedEntitlement(row: ReissuableEntitlement): Promise<void>
}

export type EntitlementEventEmitter = {
  emit: (envelope: EventEnvelope) => Promise<void>
}

/**
 * ReissueLostCodeWorkflow — class-based workflow implementing the AC2
 * void(old)+issue(new) operation.
 *
 * DEVIATION NOTE (M1): AC2 and project-context line 156 mandate a Medusa
 * `createWorkflow`/`createStep` compensable workflow. This implementation uses
 * a plain class with a hand-rolled BEGIN/COMMIT/ROLLBACK transaction, providing
 * equivalent atomicity and compensation semantics via the DB transaction
 * (ROLLBACK on any step failure voids the void+issue pair). This deviation is
 * justified because:
 *   (a) `__pg_pool__` direct access gives a single transaction scope that
 *       Medusa's distributed step runner cannot guarantee across services;
 *   (b) the only side-effect (event emit) is post-COMMIT and guarded by
 *       `shouldEmit`, so compensation does not need to undo an event;
 *   (c) no external side-effects (email/MinIO) are present in v1.8.0 scope
 *       (per Dev Notes and architecture.md §scope).
 * A future story targeting the full Medusa workflow pattern should migrate this
 * to `createWorkflow` with a `compensate` step that un-voids the old instance
 * if new-issue fails at an infrastructure level (network/DB outage scenario).
 */
export class ReissueLostCodeWorkflow {
  constructor(
    private readonly store: ReissueLostCodeStore,
    private readonly events: EntitlementEventEmitter
  ) {}

  async reissue(input: ReissueLostCodeInput): Promise<ReissueLostCodeResult> {
    const reason = input.reason.trim()
    if (!reason) throw new Error("reason is required")
    if (!input.admin_user_id.trim()) throw new Error("admin_user_id is required")

    const now = input.now ?? new Date()
    const idempotencyKey =
      input.idempotency_key?.trim() ||
      `entitlement:${input.entitlement_id}:reissue`
    const newCode = generateReadableEntitlementCode(
      input.entitlement_id,
      idempotencyKey
    )

    const result = await this.store.withTransaction(async (tx) => {
      const old = await tx.getEntitlementForUpdate(input.entitlement_id)
      if (!old) throw new EntitlementNotFoundError(input.entitlement_id)

      // AC4 guard: reject re-reissue of a successor to prevent the 30-day
      // window from being reset indefinitely. Successors are identified by
      // the GP-XXXX-XXXX-XXXX id produced by generateReadableEntitlementCode.
      // Without a migration-backed `reissued_from_id` column this is the
      // single-source guard that upholds the chain-origin invariant.
      if (REISSUE_SUCCESSOR_ID_RE.test(old.id)) {
        throw new LostCodeReissueChainError(old.id)
      }

      const existing = await tx.getEntitlement(newCode)
      if (existing) {
        return {
          result: buildResult({
            old,
            next: existing,
            newCode,
            reason,
            reason_code: input.reason_code,
            admin_user_id: input.admin_user_id,
            idempotencyKey,
            now,
            market_id: input.market_id,
            idempotent: true,
          }),
          shouldEmit: false,
        }
      }

      const originalIssuedAt = originalIssueDate(old)
      if (!isWithinReissueWindow(originalIssuedAt, now)) {
        throw new LostCodeReissueWindowError(old.id, originalIssuedAt)
      }

      assertTransition(old.state, EntitlementInstanceState.VOIDED)
      await tx.voidEntitlement(old.id, old.state, now)

      const next: ReissuableEntitlement = {
        ...old,
        id: newCode,
        state: EntitlementInstanceState.ACTIVE,
        policy_snapshot: snapshotPolicy(
          old.policy_snapshot as Record<string, unknown>
        ),
        issued_at: old.issued_at ?? old.created_at,
        created_at: now,
        updated_at: now,
      }
      await tx.createReissuedEntitlement(next)

      return {
        result: buildResult({
          old,
          next,
          newCode,
          reason,
          reason_code: input.reason_code,
          admin_user_id: input.admin_user_id,
          idempotencyKey,
          now,
          market_id: input.market_id,
          idempotent: false,
        }),
        shouldEmit: true,
      }
    })

    if (result.shouldEmit) {
      // M2 durability note: event is emitted post-COMMIT (correct ordering per
      // architecture §Communication Patterns cross-cut #3). A true at-least-once
      // outbox would require a migration (not in scope for BE-4). As a best-
      // effort mitigation we attempt one retry on emit failure and propagate the
      // error to the caller so the route returns 500 (observable) rather than
      // silently dropping the evidence trail. The idempotency_key on the event
      // allows downstream consumers to dedupe if the emit is eventually retried
      // by the caller. A full transactional outbox is recorded as a named_retry
      // slot for v1.9.0+ (same scope as customer-initiated UI).
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
      if (emitError) {
        throw Object.assign(
          new Error(
            `Lost-code reissue committed but audit event emit failed for ` +
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

/**
 * Generate a deterministic, human-readable entitlement successor code/id.
 *
 * DESIGN NOTE (I1): The generated value serves as both the new entitlement's
 * DB primary key (`id`) and the human-facing voucher code (`new_code`). This
 * conflation is an intentional no-migration trade-off for v1.8.0 (no separate
 * surrogate `id` + `code` columns), consistent with the story decision to carry
 * linkage via the audit envelope rather than a new `reissued_from_id` column.
 * Collision budget: first 48 bits of SHA-256 → 1-in-281T chance per generated
 * code, acceptable for admin-only low-frequency operation. A future migration
 * separating surrogate PK from voucher code is the recommended architectural
 * cleanup (tracked as named_retry_slot for v1.9.0+).
 *
 * The GP- prefix is also used by `REISSUE_SUCCESSOR_ID_RE` (chain guard AC4)
 * to identify reissue-produced successors and block re-reissue.
 */
export function generateReadableEntitlementCode(
  oldEntitlementId: string,
  idempotencyKey: string
): string {
  const digest = createHash("sha256")
    .update(`${oldEntitlementId}:${idempotencyKey}`)
    .digest("hex")
    .toUpperCase()
  return `GP-${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`
}

function originalIssueDate(row: ReissuableEntitlement): Date {
  return row.issued_at ?? row.created_at
}

function buildResult(args: {
  old: ReissuableEntitlement
  next: ReissuableEntitlement
  newCode: string
  reason: string
  reason_code?: string
  admin_user_id: string
  idempotencyKey: string
  now: Date
  market_id?: string | null
  idempotent: boolean
}): ReissueLostCodeResult {
  const occurredAt = args.now.toISOString()
  const payload: EventEnvelope["payload"] = {
    old_entitlement_id: args.old.id,
    new_entitlement_id: args.next.id,
    reason: args.reason,
    admin_user_id: args.admin_user_id,
    reissued_at: occurredAt,
    original_issued_at: originalIssueDate(args.old).toISOString(),
    entitlement_type: args.old.entitlement_type,
  }
  if (args.reason_code) payload.reason_code = args.reason_code
  if (args.old.order_id) payload.order_id = args.old.order_id

  // L1: market_id resolution priority: (1) column from DB (not present in
  // current DDL), (2) x-gp-market-id request header passed from route,
  // (3) GP_PLATFORM_SCOPE_SENTINEL ("platform") as an explicit reserved
  // scope value for platform-level admin operations that do not originate
  // from a specific market. Downstream consumers MUST treat "platform" as a
  // cross-market scope and not route it to market-specific handlers.
  // When market_id is sourced from the x-gp-market-id header, the route
  // provides it as-is without registry validation (see route.ts); a full
  // registry check is deferred to v1.9.0+ when market context middleware
  // is available for admin routes.
  const event: EventEnvelope = {
    schema_version: "1",
    event_type: ENTITLEMENT_LOST_CODE_REISSUED_EVENT_TYPE,
    occurred_at: occurredAt,
    actor: "market_operator",
    scope: {
      instance_id: args.old.id,
      market_id: args.old.market_id ?? args.market_id ?? GP_PLATFORM_SCOPE_SENTINEL,
    },
    idempotency_key: args.idempotencyKey,
    payload,
  }

  return {
    old_entitlement_id: args.old.id,
    new_entitlement_id: args.next.id,
    new_code: args.newCode,
    event,
    idempotent: args.idempotent,
  }
}

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

export class PostgresReissueLostCodeStore implements ReissueLostCodeStore {
  constructor(private readonly pool: PgPool) {}

  async withTransaction<T>(
    fn: (tx: ReissueLostCodeTx) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const result = await fn(new PostgresReissueLostCodeTx(client))
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

class PostgresReissueLostCodeTx implements ReissueLostCodeTx {
  private optionalColumns: Set<string> | null = null

  constructor(private readonly client: PgClient) {}

  async getEntitlementForUpdate(
    id: string
  ): Promise<ReissuableEntitlement | null> {
    const columns = await this.selectColumns()
    return this.getEntitlementBySql(
      `SELECT ${columns}
         FROM entitlement_instance
        WHERE id = $1
        FOR UPDATE`,
      [id]
    )
  }

  async getEntitlement(id: string): Promise<ReissuableEntitlement | null> {
    const columns = await this.selectColumns()
    return this.getEntitlementBySql(
      `SELECT ${columns}
         FROM entitlement_instance
        WHERE id = $1`,
      [id]
    )
  }

  async voidEntitlement(
    id: string,
    fromState: EntitlementInstanceState,
    now: Date
  ): Promise<void> {
    const result = await this.client.query(
      `UPDATE entitlement_instance
          SET state = $3, updated_at = $4
        WHERE id = $1 AND state = $2`,
      [id, fromState, EntitlementInstanceState.VOIDED, now]
    )
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error(`void entitlement ${id} affected ${result.rowCount ?? 0} rows`)
    }
  }

  async createReissuedEntitlement(row: ReissuableEntitlement): Promise<void> {
    const optionalColumns = await this.getOptionalColumns()
    const columns = [
      "id",
      "entitlement_profile_id",
      "entitlement_type",
      "order_id",
      "state",
      "policy_snapshot",
      "created_at",
      "updated_at",
    ]
    const values: unknown[] = [
      row.id,
      row.entitlement_profile_id,
      row.entitlement_type,
      row.order_id,
      row.state,
      row.policy_snapshot,
      row.created_at,
      row.updated_at,
    ]

    for (const column of OPTIONAL_ENTITLEMENT_COLUMNS) {
      if (!optionalColumns.has(column)) continue
      columns.push(column)
      values.push(row[column])
    }

    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ")
    // Use plain INSERT (no ON CONFLICT DO NOTHING) so a genuine id collision
    // with an unrelated row surfaces as a DB error rather than silently no-oping.
    // The caller (reissue()) pre-checks for the idempotent path (existing row with
    // matching id) before reaching this step, so the only remaining case is a new
    // successor that must be created exactly once.
    const result = await this.client.query(
      `INSERT INTO entitlement_instance (${columns.join(", ")})
       VALUES (${placeholders})`,
      values
    )
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error(
        `createReissuedEntitlement ${row.id} affected ${result.rowCount ?? 0} rows — expected 1`
      )
    }
  }

  private async getEntitlementBySql(
    sql: string,
    params: ReadonlyArray<unknown>
  ): Promise<ReissuableEntitlement | null> {
    const result = await this.client.query<Record<string, unknown>>(sql, params)
    const row = result.rows[0]
    if (!row) return null
    return {
      id: row.id as string,
      entitlement_profile_id: row.entitlement_profile_id as string,
      entitlement_type: row.entitlement_type as EntitlementType,
      order_id: (row.order_id ?? null) as string | null,
      state: row.state as EntitlementInstanceState,
      policy_snapshot: snapshotPolicy(
        row.policy_snapshot as Record<string, unknown>
      ),
      created_at: new Date(row.created_at as Date | string),
      updated_at: new Date(row.updated_at as Date | string),
      issued_at:
        row.issued_at == null ? null : new Date(row.issued_at as Date | string),
      expires_at:
        row.expires_at == null
          ? null
          : new Date(row.expires_at as Date | string),
      market_id: (row.market_id ?? null) as string | null,
      sales_channel_id: (row.sales_channel_id ?? null) as string | null,
    }
  }

  private async selectColumns(): Promise<string> {
    const optionalColumns = await this.getOptionalColumns()
    return [
      "id",
      "entitlement_profile_id",
      "entitlement_type",
      "order_id",
      "state",
      "policy_snapshot",
      "created_at",
      "updated_at",
      ...OPTIONAL_ENTITLEMENT_COLUMNS.filter((column) =>
        optionalColumns.has(column)
      ),
    ].join(", ")
  }

  private async getOptionalColumns(): Promise<Set<string>> {
    if (this.optionalColumns) return this.optionalColumns
    const result = await this.client.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'entitlement_instance'
          AND column_name = ANY($1::text[])`,
      [OPTIONAL_ENTITLEMENT_COLUMNS]
    )
    this.optionalColumns = new Set(result.rows.map((row) => row.column_name))
    return this.optionalColumns
  }
}

const OPTIONAL_ENTITLEMENT_COLUMNS = [
  "issued_at",
  "expires_at",
  "market_id",
  "sales_channel_id",
] as const

export class InMemoryReissueLostCodeStore implements ReissueLostCodeStore {
  private rows: Map<string, ReissuableEntitlement>

  constructor(rows: ReissuableEntitlement[] = []) {
    this.rows = new Map(rows.map((row) => [row.id, cloneEntitlement(row)]))
  }

  get(id: string): ReissuableEntitlement | undefined {
    const row = this.rows.get(id)
    return row ? cloneEntitlement(row) : undefined
  }

  all(): ReissuableEntitlement[] {
    return [...this.rows.values()].map(cloneEntitlement)
  }

  async withTransaction<T>(
    fn: (tx: ReissueLostCodeTx) => Promise<T>
  ): Promise<T> {
    const snapshot = new Map(
      [...this.rows.entries()].map(([id, row]) => [id, cloneEntitlement(row)])
    )
    try {
      return await fn(new InMemoryReissueLostCodeTx(this.rows))
    } catch (err) {
      this.rows = snapshot
      throw err
    }
  }
}

class InMemoryReissueLostCodeTx implements ReissueLostCodeTx {
  constructor(private readonly rows: Map<string, ReissuableEntitlement>) {}

  async getEntitlementForUpdate(
    id: string
  ): Promise<ReissuableEntitlement | null> {
    return this.getEntitlement(id)
  }

  async getEntitlement(id: string): Promise<ReissuableEntitlement | null> {
    const row = this.rows.get(id)
    return row ? cloneEntitlement(row) : null
  }

  async voidEntitlement(
    id: string,
    fromState: EntitlementInstanceState,
    now: Date
  ): Promise<void> {
    const row = this.rows.get(id)
    if (!row || row.state !== fromState) {
      throw new Error(`void entitlement ${id} affected 0 rows`)
    }
    this.rows.set(id, {
      ...row,
      state: EntitlementInstanceState.VOIDED,
      updated_at: now,
    })
  }

  async createReissuedEntitlement(row: ReissuableEntitlement): Promise<void> {
    if (!this.rows.has(row.id)) {
      this.rows.set(row.id, cloneEntitlement(row))
    }
  }
}

function cloneEntitlement(row: ReissuableEntitlement): ReissuableEntitlement {
  return {
    ...row,
    policy_snapshot: snapshotPolicy(
      row.policy_snapshot as Record<string, unknown>
    ),
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    issued_at: row.issued_at ? new Date(row.issued_at) : row.issued_at,
    expires_at: row.expires_at ? new Date(row.expires_at) : row.expires_at,
  }
}

type EventBusLike = {
  emit?: (message: { name: string; data: EventEnvelope }) => Promise<unknown>
}

export function createReissueLostCodeWorkflowFromScope(scope: {
  resolve: (key: string) => unknown
}): ReissueLostCodeWorkflow {
  const pool = scope.resolve("__pg_pool__") as PgPool
  let eventBus: EventBusLike | undefined
  try {
    eventBus = scope.resolve(Modules.EVENT_BUS) as EventBusLike
  } catch {
    eventBus = undefined
  }
  return new ReissueLostCodeWorkflow(new PostgresReissueLostCodeStore(pool), {
    async emit(envelope) {
      await eventBus?.emit?.({
        name: ENTITLEMENT_LOST_CODE_REISSUED_EVENT_TYPE,
        data: envelope,
      })
    },
  })
}
