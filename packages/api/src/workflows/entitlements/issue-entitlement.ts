import { createHash } from "node:crypto"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"

import {
  EntitlementInstanceState,
  EntitlementType,
  assertTransition,
  snapshotPolicy,
} from "../../modules/voucher/models/entitlement"

type QueryResult<T> = Promise<{ rows: T[]; rowCount?: number | null }>
export type PgClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>
  ) => QueryResult<T>
  release?: () => void
}
type PgPool = {
  connect: () => Promise<PgClient>
}
type KnexLike = {
  raw: (
    sql: string,
    bindings?: ReadonlyArray<unknown>
  ) => Promise<{ rows?: unknown[]; rowCount?: number | null } | unknown[]>
  transaction: <T>(handler: (trx: KnexLike) => Promise<T>) => Promise<T>
}

export type EntitlementProfilePayload = {
  profile_id?: string
  entitlement_type?: EntitlementType | string
  policy?: Record<string, unknown>
  currency?: string
  amount_minor?: number
  line_item_id?: string | null
}

export type IssueEntitlementInput = {
  event_id: string
  order_id: string
  payment_id?: string
  payment_intent_id?: string
  market_id?: string | null
  amount_minor?: number | null
  currency?: string | null
  entitlement_profile?: EntitlementProfilePayload | null
}

export type IssueEntitlementResult = {
  entitlement_id: string
  idempotent: boolean
}

export class MissingEntitlementProfileError extends Error {
  constructor(orderId: string) {
    super(
      `payment.captured order ${orderId} has no entitlement_profile augmentation; ` +
        `Story 2.1 declarative profile enrichment must provide it before issuing`
    )
    this.name = "MissingEntitlementProfileError"
  }
}

export async function issueEntitlementWithinPaymentTransaction(
  client: PgClient,
  payload: IssueEntitlementInput,
  now: Date
): Promise<IssueEntitlementResult> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM entitlement_instance WHERE order_id = $1 LIMIT 1 FOR UPDATE`,
    [payload.order_id]
  )
  if (existing.rows[0]?.id) {
    return { entitlement_id: existing.rows[0].id, idempotent: true }
  }

  const profile = await resolveEntitlementProfile(client, payload)
  if (!profile?.profile_id || !profile.entitlement_type || !profile.policy) {
    throw new MissingEntitlementProfileError(payload.order_id)
  }

  assertTransition(EntitlementInstanceState.ISSUED, EntitlementInstanceState.ACTIVE)
  const entitlementId = buildEntitlementId(payload.order_id, payload.event_id)
  const snapshot = snapshotPolicy({
    ...profile.policy,
    currency: profile.currency ?? payload.currency ?? "PLN",
    amount_minor: profile.amount_minor ?? payload.amount_minor ?? 0,
    source_event_id: payload.event_id,
  })

  await client.query(
    `INSERT INTO entitlement_instance
       (id, entitlement_profile_id, entitlement_type, order_id, state,
        policy_snapshot, market_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $8)`,
    [
      entitlementId,
      profile.profile_id,
      profile.entitlement_type,
      payload.order_id,
      EntitlementInstanceState.ACTIVE,
      JSON.stringify(snapshot),
      payload.market_id ?? null,
      now,
    ]
  )

  return { entitlement_id: entitlementId, idempotent: false }
}

async function resolveEntitlementProfile(
  client: PgClient,
  payload: IssueEntitlementInput
): Promise<EntitlementProfilePayload | null | undefined> {
  if (
    payload.entitlement_profile?.profile_id &&
    payload.entitlement_profile.entitlement_type &&
    payload.entitlement_profile.policy
  ) {
    return payload.entitlement_profile
  }

  const row = await client.query<{ metadata: Record<string, unknown> | null }>(
    `SELECT oli.metadata
       FROM order_item oi
       JOIN order_line_item oli ON oli.id = oi.item_id
      WHERE oi.order_id = $1
        AND oi.deleted_at IS NULL
        AND oli.deleted_at IS NULL
      ORDER BY oi.created_at ASC
      LIMIT 1`,
    [payload.order_id]
  )
  const metadata = row.rows[0]?.metadata
  if (!metadata || typeof metadata !== "object") return payload.entitlement_profile

  const embedded = metadata.entitlement_profile
  if (isEntitlementProfilePayload(embedded)) {
    return embedded
  }

  const profile_id =
    readString(metadata.entitlement_profile_id) ?? readString(metadata.profile_id)
  const entitlement_type = readString(metadata.entitlement_type)
  const policy = readObject(metadata.entitlement_policy) ?? readObject(metadata.policy)
  if (!profile_id || !entitlement_type || !policy) return payload.entitlement_profile

  return {
    profile_id,
    entitlement_type,
    policy,
    currency: readString(metadata.currency) ?? payload.currency ?? undefined,
    amount_minor:
      typeof metadata.amount_minor === "number"
        ? metadata.amount_minor
        : payload.amount_minor ?? undefined,
    line_item_id: readString(metadata.line_item_id),
  }
}

function isEntitlementProfilePayload(value: unknown): value is EntitlementProfilePayload {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return Boolean(
    readString(record.profile_id) &&
      readString(record.entitlement_type) &&
      readObject(record.policy)
  )
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export async function compensateIssuedEntitlement(
  client: PgClient,
  result: IssueEntitlementResult | undefined
): Promise<void> {
  if (!result || result.idempotent) return
  await client.query(`DELETE FROM entitlement_instance WHERE id = $1`, [
    result.entitlement_id,
  ])
}

function buildEntitlementId(orderId: string, eventId: string): string {
  const digest = createHash("sha256").update(`${orderId}:${eventId}`).digest("hex")
  return `ent_${digest.slice(0, 24)}`
}

export const issueEntitlementStep = createStep<
  IssueEntitlementInput,
  IssueEntitlementResult,
  IssueEntitlementResult
>(
  "gp-issue-entitlement",
  async (input, { container }) => {
    const result = await withResolvedTransaction(
      container as { resolve: (key: string) => unknown },
      async (client) => issueEntitlementWithinPaymentTransaction(
        client,
        input,
        new Date()
      )
    )
    return new StepResponse(result, result)
  },
  async (result, { container }) => {
    if (!result) return
    await withResolvedTransaction(container as { resolve: (key: string) => unknown }, async (client) => {
      await compensateIssuedEntitlement(client, result)
    })
  }
)

export const issueEntitlementWorkflow = createWorkflow<
  IssueEntitlementInput,
  IssueEntitlementResult,
  []
>("gp-issue-entitlement-workflow", function (input) {
  const result = issueEntitlementStep(input)
  return new WorkflowResponse(result)
})

async function withResolvedTransaction<T>(
  container: { resolve: (key: string) => unknown },
  handler: (client: PgClient) => Promise<T>
): Promise<T> {
  const db = resolvePgDatabase(container)
  if (isPgPool(db)) {
    const client = await db.connect()
    try {
      await client.query("BEGIN")
      const result = await handler(client)
      await client.query("COMMIT")
      return result
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw err
    } finally {
      client.release?.()
    }
  }

  return db.transaction(async (trx) => handler(createKnexPgClient(trx)))
}

function resolvePgDatabase(container: { resolve: (key: string) => unknown }): PgPool | KnexLike {
  try {
    return container.resolve("__pg_pool__") as PgPool
  } catch {
    return container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as KnexLike
  }
}

function isPgPool(value: PgPool | KnexLike): value is PgPool {
  return typeof (value as PgPool).connect === "function"
}

function createKnexPgClient(db: KnexLike): PgClient {
  return {
    query: async <T = Record<string, unknown>>(
      text: string,
      values: ReadonlyArray<unknown> = []
    ) => {
      const query = toKnexSql(text, values)
      const result = await db.raw(query.sql, query.bindings)
      if (Array.isArray(result)) {
        return { rows: result as T[], rowCount: result.length }
      }
      const rows = (result.rows ?? []) as T[]
      return { rows, rowCount: result.rowCount ?? rows.length }
    },
    release: () => undefined,
  }
}

function toKnexSql(
  sql: string,
  values: ReadonlyArray<unknown>
): { sql: string; bindings: unknown[] } {
  const bindings: unknown[] = []
  const text = sql.replace(/\$(\d+)/g, (_match, index: string) => {
    bindings.push(values[Number(index) - 1])
    return "?"
  })
  return { sql: text, bindings }
}
