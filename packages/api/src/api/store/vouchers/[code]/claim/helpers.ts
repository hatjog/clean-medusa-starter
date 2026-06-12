import type { MedusaRequest } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export interface ClaimAuditRow {
  idempotency_key: string
  code: string
  ip: string
  outcome:
    | "ok"
    | "idempotent_replay"
    | "replay_tampered"
    | "rate_limited"
    | "invalid_code"
    | "expired"
    | "already_claimed"
  occurred_at: string
}

export interface ClaimRouteResponse {
  status: number
  body: Record<string, unknown>
}

export type PgClientLike = {
  query: <T = Record<string, unknown>>(
    sql: string,
    values?: ReadonlyArray<unknown>
  ) => Promise<{ rows: T[]; rowCount?: number | null }>
  release?: () => void
}

type PgPoolLike = {
  connect: () => Promise<PgClientLike>
}

type KnexLike = {
  raw: (
    sql: string,
    bindings?: ReadonlyArray<unknown>
  ) => Promise<{ rows?: unknown[]; rowCount?: number | null } | unknown[]>
  transaction: <T>(handler: (trx: KnexLike) => Promise<T>) => Promise<T>
}

type BindingReplayRow = {
  binding_hash: string
  response_status: number | null
  response_body: Record<string, unknown> | string | null
}

/** In-memory idempotency binding store: single-instance fallback only. */
export const bindingStore = new Map<string, string>()

/** In-memory audit log: single-instance fallback only. */
export const auditLog: ClaimAuditRow[] = []

export const CLAIM_BINDING_TTL_HOURS = 24

function isPgPool(value: unknown): value is PgPoolLike {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as PgPoolLike).connect === "function"
  )
}

function resolveDb(req: MedusaRequest): unknown | null {
  try {
    return req.scope.resolve("__pg_pool__")
  } catch {
    try {
      return req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    } catch {
      return null
    }
  }
}

function ttlHours(): number {
  const raw = process.env.GP_VOUCHER_CLAIM_BINDING_TTL_HOURS
  if (!raw) return CLAIM_BINDING_TTL_HOURS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : CLAIM_BINDING_TTL_HOURS
}

function normalizeResponseBody(
  body: BindingReplayRow["response_body"]
): Record<string, unknown> | null {
  if (!body) return null
  if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>
  return body
}

export async function withClaimTransaction<T>(
  req: MedusaRequest,
  handler: (client: PgClientLike) => Promise<T>
): Promise<T | null> {
  const db = resolveDb(req)
  if (!db) return null

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

  const knex = db as KnexLike
  return knex.transaction(async (trx) =>
    handler({
      query: async <T = Record<string, unknown>>(
        sql: string,
        values: ReadonlyArray<unknown> = []
      ) => {
        const bindings: unknown[] = []
        const text = sql.replace(/\$(\d+)/g, (_m, idx: string) => {
          bindings.push(values[Number(idx) - 1])
          return "?"
        })
        const result = await trx.raw(text, bindings)
        if (Array.isArray(result)) {
          return { rows: result as T[], rowCount: result.length }
        }
        const rows = (result.rows ?? []) as T[]
        return { rows, rowCount: result.rowCount ?? rows.length }
      },
    })
  )
}

export async function appendClaimAudit(
  client: PgClientLike,
  row: ClaimAuditRow
): Promise<void> {
  await client.query(
    `INSERT INTO voucher_claim_audit
       (idempotency_key, code, ip, outcome, occurred_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [row.idempotency_key, row.code, row.ip, row.outcome, row.occurred_at]
  )
}

export async function appendClaimAuditWithFallback(
  req: MedusaRequest,
  row: ClaimAuditRow
): Promise<void> {
  const persisted = await withClaimTransaction(req, (client) =>
    appendClaimAudit(client, row)
  )
  if (persisted === null) {
    auditLog.push(row)
  }
}

export async function reserveClaimBinding(
  client: PgClientLike,
  input: {
    idempotencyKey: string
    bindingHash: string
    code: string
    claimedAt: string
  }
): Promise<
  | { inserted: true }
  | { inserted: false; bindingHash: string; response: ClaimRouteResponse | null }
> {
  const inserted = await client.query(
    `INSERT INTO voucher_claim_binding
       (idempotency_key, binding_hash, code, claimed_at, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5::text || ' hours')::interval, NOW(), NOW())
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      input.idempotencyKey,
      input.bindingHash,
      input.code,
      input.claimedAt,
      String(ttlHours()),
    ]
  )

  if ((inserted.rowCount ?? 0) > 0) return { inserted: true }

  const existing = await client.query<BindingReplayRow>(
    `SELECT binding_hash, response_status, response_body
       FROM voucher_claim_binding
      WHERE idempotency_key = $1
        AND expires_at > NOW()
      FOR UPDATE`,
    [input.idempotencyKey]
  )

  const row = existing.rows[0]
  if (!row) return { inserted: true }

  const body = normalizeResponseBody(row.response_body)
  return {
    inserted: false,
    bindingHash: row.binding_hash,
    response:
      row.response_status && body
        ? { status: Number(row.response_status), body }
        : null,
  }
}

export async function completeClaimBinding(
  client: PgClientLike,
  idempotencyKey: string,
  response: ClaimRouteResponse
): Promise<void> {
  await client.query(
    `UPDATE voucher_claim_binding
        SET response_status = $2,
            response_body = $3::jsonb,
            updated_at = NOW()
      WHERE idempotency_key = $1`,
    [idempotencyKey, response.status, JSON.stringify(response.body)]
  )
}

/** Exposed for tests only. */
export function _getAuditLog(): ReadonlyArray<ClaimAuditRow> {
  return auditLog
}

export function _clearAuditLog(): void {
  auditLog.splice(0, auditLog.length)
}

export function _clearBindingStore(): void {
  bindingStore.clear()
}
