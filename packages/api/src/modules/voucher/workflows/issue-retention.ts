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
import {
  RETENTION_AMOUNT_PCT_MAX,
  RETENTION_AMOUNT_PCT_MIN,
  isRetentionAmountWithinBoundary,
} from "../entitlement-boundary"

export const ENTITLEMENT_RETENTION_ISSUED_EVENT_TYPE =
  "gp.entitlements.entitlement_retention_issued.v1" as const

/**
 * Sentinel scope.market_id used when no market context is available for a
 * platform-level admin operation (mirrors reissue-lost-code pattern L1).
 */
export const GP_PLATFORM_SCOPE_SENTINEL = "platform" as const

export type RetentionEventEnvelope = {
  schema_version: "1"
  event_type: typeof ENTITLEMENT_RETENTION_ISSUED_EVENT_TYPE
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
    original_entitlement_id: string
    retention_entitlement_id: string
    reason: string
    reason_code?: string
    amount: number
    admin_user_id: string
    issued_at: string
    retention_voucher_template_id?: string
    entitlement_type?: EntitlementType
    order_id?: string
  }
}

export type RetentionEntitlement = {
  id: string
  entitlement_profile_id: string
  entitlement_type: EntitlementType
  order_id: string | null
  state: EntitlementInstanceState
  policy_snapshot: EntitlementPolicySnapshot
  metadata?: Record<string, unknown> | null
  created_at: Date
  updated_at: Date
  issued_at?: Date | null
  expires_at?: Date | null
  market_id?: string | null
  sales_channel_id?: string | null
}

export type IssueRetentionInput = {
  entitlement_id: string
  amount: number
  reason: string
  reason_code?: string
  admin_user_id: string
  retention_voucher_template_id?: string
  idempotency_key?: string
  now?: Date
  market_id?: string | null
}

export type IssueRetentionResult = {
  original_entitlement_id: string
  retention_entitlement_id: string
  retention_code: string
  amount: number
  event: RetentionEventEnvelope
  idempotent: boolean
}

export class RetentionAmountBoundaryError extends Error {
  readonly amount: number
  readonly originalAmount: number | null

  constructor(amount: number, originalAmount: number | null) {
    const msg =
      originalAmount != null
        ? `Retention amount ${amount} violates incentive ratio boundary ` +
          `[${RETENTION_AMOUNT_PCT_MIN}%–${RETENTION_AMOUNT_PCT_MAX}%] of ` +
          `original value ${originalAmount}`
        : `Retention amount ${amount} must be > 0`
    super(msg)
    this.name = "RetentionAmountBoundaryError"
    this.amount = amount
    this.originalAmount = originalAmount
  }
}

export class RetentionEntitlementNotFoundError extends Error {
  constructor(id: string) {
    super(`entitlement_instance ${id} was not found`)
    this.name = "RetentionEntitlementNotFoundError"
  }
}

// Re-export for route convenience.
export { EntitlementTransitionError }

export interface IssueRetentionStore {
  withTransaction<T>(fn: (tx: IssueRetentionTx) => Promise<T>): Promise<T>
}

export interface IssueRetentionTx {
  getEntitlementForUpdate(id: string): Promise<RetentionEntitlement | null>
  getEntitlement(id: string): Promise<RetentionEntitlement | null>
  voidEntitlement(
    id: string,
    fromState: EntitlementInstanceState,
    now: Date
  ): Promise<void>
  createRetentionEntitlement(row: RetentionEntitlement): Promise<void>
}

export type RetentionEventEmitter = {
  emit: (envelope: RetentionEventEnvelope) => Promise<void>
}

/**
 * IssueRetentionWorkflow — mirrors ReissueLostCodeWorkflow (Story 2.5).
 *
 * Atomicity: void(old) + issue(new) in a single DB transaction; ROLLBACK
 * on any step failure compensates automatically (no orphaned VOIDED instance).
 * Event emitted post-COMMIT with best-effort retry (mirrors Story 2.5 M2).
 *
 * Key differences vs lost-code reissue (per Dev Notes):
 *   1. No 30-day window check — retention is not time-gated.
 *   2. Carries mandatory `amount` with boundary validation (AC4).
 *   3. Retention profile resolution (AC3): body override > metadata > verbatim snapshot fallback.
 *   4. Idempotency key: `entitlement:<old_id>:retention`.
 *   5. New code generated via same generator (GP-XXXX-XXXX-XXXX).
 */
export class IssueRetentionWorkflow {
  constructor(
    private readonly store: IssueRetentionStore,
    private readonly events: RetentionEventEmitter
  ) {}

  async issueRetention(
    input: IssueRetentionInput
  ): Promise<IssueRetentionResult> {
    const reason = input.reason.trim()
    if (!reason) throw new Error("reason is required")
    if (!input.admin_user_id.trim()) throw new Error("admin_user_id is required")

    const now = input.now ?? new Date()
    const idempotencyKey =
      input.idempotency_key?.trim() ||
      `entitlement:${input.entitlement_id}:retention`

    const retentionCode = generateRetentionEntitlementCode(
      input.entitlement_id,
      idempotencyKey
    )

    const result = await this.store.withTransaction(async (tx) => {
      const old = await tx.getEntitlementForUpdate(input.entitlement_id)
      if (!old) throw new RetentionEntitlementNotFoundError(input.entitlement_id)

      // Idempotency: if retention successor already exists, return it without mutation.
      const existing = await tx.getEntitlement(retentionCode)
      if (existing) {
        return {
          result: buildResult({
            old,
            next: existing,
            retentionCode,
            amount: input.amount,
            reason,
            reason_code: input.reason_code,
            retention_voucher_template_id:
              input.retention_voucher_template_id,
            admin_user_id: input.admin_user_id,
            idempotencyKey,
            now,
            market_id: input.market_id,
            idempotent: true,
          }),
          shouldEmit: false,
        }
      }

      // AC4 boundary: amount > 0 (always) + incentive ratio (when original resolvable).
      // Original amount is carried in policy_snapshot when present; DDL drift
      // means the `amount` column may not exist — degrade to amount > 0 only.
      const originalAmount = resolveOriginalAmount(old)
      if (!isRetentionAmountWithinBoundary(input.amount, originalAmount)) {
        throw new RetentionAmountBoundaryError(input.amount, originalAmount)
      }

      // AC2 void old entitlement (assertTransition throws EntitlementTransitionError
      // when the source state does not permit VOIDED).
      assertTransition(old.state, EntitlementInstanceState.VOIDED)
      await tx.voidEntitlement(old.id, old.state, now)

      // AC3 retention profile resolution:
      //   (a) body override → retention_voucher_template_id from input
      //   (b) source metadata.retention_voucher_template_id
      //   (c) fallback: verbatim snapshot copy (current BonBeauty state)
      const templateId =
        input.retention_voucher_template_id ??
        resolveMetadataTemplateId(old.metadata) ??
        null

      // When a named template is declared, TTL/policy should ideally be loaded
      // from the profile catalog (v1.9.0+ Voucher Runda 2). In v1.8.0 the
      // catalog is OOS, so we always copy the source policy_snapshot verbatim
      // regardless of whether templateId is set, and document this in the
      // Completion Notes. This is the AC3 fallback path for all BonBeauty cases.
      const retentionPolicy = snapshotPolicy(
        old.policy_snapshot as Record<string, unknown>
      )

      const next: RetentionEntitlement = {
        id: retentionCode,
        entitlement_profile_id: old.entitlement_profile_id,
        entitlement_type: old.entitlement_type,
        order_id: old.order_id,
        state: EntitlementInstanceState.ACTIVE,
        policy_snapshot: retentionPolicy,
        created_at: now,
        updated_at: now,
        // Optional columns preserved when present (DDL-drift safe):
        market_id: old.market_id ?? null,
        sales_channel_id: old.sales_channel_id ?? null,
        // issued_at / expires_at — retention is a new voucher; TTL from
        // retention profile (v1.9.0+) or fallback source snapshot. In v1.8.0
        // copy expires_at from source as the safest fallback (prevents zero TTL).
        issued_at: now,
        expires_at: old.expires_at ?? null,
      }
      await tx.createRetentionEntitlement(next)

      return {
        result: buildResult({
          old,
          next,
          retentionCode,
          amount: input.amount,
          reason,
          reason_code: input.reason_code,
          retention_voucher_template_id: templateId ?? undefined,
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
      // Post-COMMIT emit (mirrors Story 2.5 M2 best-effort pattern).
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
            `Retention issue committed but audit event emit failed for ` +
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
 * Generate a deterministic, human-readable retention entitlement successor code.
 * Mirrors generateReadableEntitlementCode from reissue-lost-code (same algorithm,
 * different idempotency_key prefix → guaranteed distinct from reissue codes).
 */
export function generateRetentionEntitlementCode(
  oldEntitlementId: string,
  idempotencyKey: string
): string {
  const digest = createHash("sha256")
    .update(`${oldEntitlementId}:${idempotencyKey}`)
    .digest("hex")
    .toUpperCase()
  return `GP-${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`
}

/**
 * Resolve the original entitlement's monetary value for incentive ratio check.
 * Returns null when not resolvable from the current DDL (DDL drift posture).
 * In v1.8.0 the `amount` column does not exist on entitlement_instance; the
 * policy_snapshot may carry the value in some profiles. This is best-effort.
 */
function resolveOriginalAmount(
  row: RetentionEntitlement
): number | null {
  // Try policy_snapshot.amount if present (some profiles carry it).
  const snap = row.policy_snapshot as Record<string, unknown>
  if (typeof snap.amount === "number" && Number.isFinite(snap.amount) && snap.amount > 0) {
    return snap.amount
  }
  // DDL drift: no `amount` column on the row in v1.8.0 DDL.
  return null
}

/**
 * Resolve retention_voucher_template_id from instance metadata (AC3 priority b).
 */
function resolveMetadataTemplateId(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  if (!metadata) return null
  const id = metadata["retention_voucher_template_id"]
  if (typeof id === "string" && id.trim()) return id.trim()
  return null
}

function buildResult(args: {
  old: RetentionEntitlement
  next: RetentionEntitlement
  retentionCode: string
  amount: number
  reason: string
  reason_code?: string
  retention_voucher_template_id?: string
  admin_user_id: string
  idempotencyKey: string
  now: Date
  market_id?: string | null
  idempotent: boolean
}): IssueRetentionResult {
  const occurredAt = args.now.toISOString()
  const payload: RetentionEventEnvelope["payload"] = {
    original_entitlement_id: args.old.id,
    retention_entitlement_id: args.next.id,
    reason: args.reason,
    amount: args.amount,
    admin_user_id: args.admin_user_id,
    issued_at: occurredAt,
    entitlement_type: args.old.entitlement_type,
  }
  if (args.reason_code) payload.reason_code = args.reason_code
  if (args.retention_voucher_template_id)
    payload.retention_voucher_template_id = args.retention_voucher_template_id
  if (args.old.order_id) payload.order_id = args.old.order_id

  const event: RetentionEventEnvelope = {
    schema_version: "1",
    event_type: ENTITLEMENT_RETENTION_ISSUED_EVENT_TYPE,
    occurred_at: occurredAt,
    actor: "market_operator",
    scope: {
      instance_id: args.old.id,
      market_id:
        args.old.market_id ?? args.market_id ?? GP_PLATFORM_SCOPE_SENTINEL,
    },
    idempotency_key: args.idempotencyKey,
    payload,
  }

  return {
    original_entitlement_id: args.old.id,
    retention_entitlement_id: args.next.id,
    retention_code: args.retentionCode,
    amount: args.amount,
    event,
    idempotent: args.idempotent,
  }
}

// ---------------------------------------------------------------------------
// Postgres store implementation
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

export class PostgresIssueRetentionStore implements IssueRetentionStore {
  constructor(private readonly pool: PgPool) {}

  async withTransaction<T>(fn: (tx: IssueRetentionTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const result = await fn(new PostgresIssueRetentionTx(client))
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

const OPTIONAL_RETENTION_COLUMNS = [
  "issued_at",
  "expires_at",
  "market_id",
  "sales_channel_id",
] as const

class PostgresIssueRetentionTx implements IssueRetentionTx {
  private optionalColumns: Set<string> | null = null

  constructor(private readonly client: PgClient) {}

  async getEntitlementForUpdate(id: string): Promise<RetentionEntitlement | null> {
    const columns = await this.selectColumns()
    return this.getEntitlementBySql(
      `SELECT ${columns}
         FROM entitlement_instance
        WHERE id = $1
        FOR UPDATE`,
      [id]
    )
  }

  async getEntitlement(id: string): Promise<RetentionEntitlement | null> {
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

  async createRetentionEntitlement(row: RetentionEntitlement): Promise<void> {
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

    for (const column of OPTIONAL_RETENTION_COLUMNS) {
      if (!optionalColumns.has(column)) continue
      columns.push(column)
      values.push(row[column])
    }

    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ")
    const result = await this.client.query(
      `INSERT INTO entitlement_instance (${columns.join(", ")})
       VALUES (${placeholders})`,
      values
    )
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error(
        `createRetentionEntitlement ${row.id} affected ${result.rowCount ?? 0} rows — expected 1`
      )
    }
  }

  private async getEntitlementBySql(
    sql: string,
    params: ReadonlyArray<unknown>
  ): Promise<RetentionEntitlement | null> {
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
      metadata: null, // not in base DDL; metadata column not present in v1.8.0
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
      ...OPTIONAL_RETENTION_COLUMNS.filter((c) => optionalColumns.has(c)),
    ].join(", ")
  }

  private async getOptionalColumns(): Promise<Set<string>> {
    if (this.optionalColumns) return this.optionalColumns
    const result = await this.client.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'entitlement_instance'
          AND column_name = ANY($1::text[])`,
      [OPTIONAL_RETENTION_COLUMNS]
    )
    this.optionalColumns = new Set(result.rows.map((r) => r.column_name))
    return this.optionalColumns
  }
}

// ---------------------------------------------------------------------------
// In-memory store for unit tests
// ---------------------------------------------------------------------------

export class InMemoryIssueRetentionStore implements IssueRetentionStore {
  private rows: Map<string, RetentionEntitlement>

  constructor(rows: RetentionEntitlement[] = []) {
    this.rows = new Map(rows.map((r) => [r.id, cloneEntitlement(r)]))
  }

  get(id: string): RetentionEntitlement | undefined {
    const row = this.rows.get(id)
    return row ? cloneEntitlement(row) : undefined
  }

  all(): RetentionEntitlement[] {
    return [...this.rows.values()].map(cloneEntitlement)
  }

  async withTransaction<T>(fn: (tx: IssueRetentionTx) => Promise<T>): Promise<T> {
    const snapshot = new Map(
      [...this.rows.entries()].map(([id, r]) => [id, cloneEntitlement(r)])
    )
    try {
      return await fn(new InMemoryIssueRetentionTx(this.rows))
    } catch (err) {
      this.rows = snapshot
      throw err
    }
  }
}

class InMemoryIssueRetentionTx implements IssueRetentionTx {
  constructor(private readonly rows: Map<string, RetentionEntitlement>) {}

  async getEntitlementForUpdate(id: string): Promise<RetentionEntitlement | null> {
    return this.getEntitlement(id)
  }

  async getEntitlement(id: string): Promise<RetentionEntitlement | null> {
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

  async createRetentionEntitlement(row: RetentionEntitlement): Promise<void> {
    if (!this.rows.has(row.id)) {
      this.rows.set(row.id, cloneEntitlement(row))
    }
  }
}

function cloneEntitlement(row: RetentionEntitlement): RetentionEntitlement {
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

// ---------------------------------------------------------------------------
// Factory for route/scope wiring
// ---------------------------------------------------------------------------

type EventBusLike = {
  emit?: (message: { name: string; data: RetentionEventEnvelope }) => Promise<unknown>
}

export function createIssueRetentionWorkflowFromScope(scope: {
  resolve: (key: string) => unknown
}): IssueRetentionWorkflow {
  const pool = scope.resolve("__pg_pool__") as PgPool
  let eventBus: EventBusLike | undefined
  try {
    eventBus = scope.resolve(Modules.EVENT_BUS) as EventBusLike
  } catch {
    eventBus = undefined
  }
  return new IssueRetentionWorkflow(new PostgresIssueRetentionStore(pool), {
    async emit(envelope) {
      await eventBus?.emit?.({
        name: ENTITLEMENT_RETENTION_ISSUED_EVENT_TYPE,
        data: envelope,
      })
    },
  })
}
