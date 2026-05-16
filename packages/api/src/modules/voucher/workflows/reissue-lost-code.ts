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
      await this.events.emit(result.result.event)
    }

    return result.result
  }
}

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

  const event: EventEnvelope = {
    schema_version: "1",
    event_type: ENTITLEMENT_LOST_CODE_REISSUED_EVENT_TYPE,
    occurred_at: occurredAt,
    actor: "market_operator",
    scope: {
      instance_id: args.old.id,
      market_id: args.old.market_id ?? args.market_id ?? "platform",
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
    await this.client.query(
      `INSERT INTO entitlement_instance (${columns.join(", ")})
       VALUES (${placeholders})
       ON CONFLICT (id) DO NOTHING`,
      values
    )
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
