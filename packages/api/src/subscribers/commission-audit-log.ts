import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { randomUUID } from "node:crypto"

type Logger = {
  info?: (message: string, meta?: Record<string, unknown>) => void
  warn?: (message: string, meta?: Record<string, unknown>) => void
}

type PgConnection = {
  raw?: <T = unknown>(sql: string, bindings?: unknown[]) => Promise<T>
}

function eventNameOf(event: unknown): string {
  return (event as { name?: string })?.name ?? "commission.unknown"
}

function eventDataOf(event: unknown): Record<string, unknown> {
  const data = (event as { data?: unknown })?.data
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {}
}

async function auditTableExists(db: PgConnection): Promise<boolean> {
  if (typeof db.raw !== "function") return false
  const result = await db.raw("select to_regclass('public.commission_audit_log') as regclass")
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] })?.rows
  const first = Array.isArray(rows) ? (rows[0] as { regclass?: string | null } | undefined) : undefined
  return Boolean(first?.regclass)
}

function firstRowOf<T extends Record<string, unknown>>(result: unknown): T | undefined {
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] })?.rows
  return Array.isArray(rows) ? (rows[0] as T | undefined) : undefined
}

async function resolveMarketId(db: PgConnection, data: Record<string, unknown>): Promise<string | null> {
  const directMarketId = data.market_id
  if (typeof directMarketId === "string" && directMarketId.length > 0) {
    return directMarketId
  }

  const directSellerId = data.seller_id
  if (typeof directSellerId === "string" && directSellerId.length > 0) {
    const sellerResult = await db.raw?.(
      "select metadata #>> '{gp,market_id}' as market_id from seller where id = ? limit 1",
      [directSellerId],
    )
    const sellerRow = firstRowOf<{ market_id?: string | null }>(sellerResult)
    if (sellerRow?.market_id) return sellerRow.market_id
  }

  const commissionLineId = data.commission_line_id ?? data.id
  if (typeof commissionLineId !== "string" || commissionLineId.length === 0) {
    return null
  }

  const lineResult = await db.raw?.(
    `select s.metadata #>> '{gp,market_id}' as market_id
       from commission_line cl
       join order_line_item oli on oli.id = cl.item_id
       join seller s on s.id = oli.metadata->>'seller_id'
      where cl.id = ?
      limit 1`,
    [commissionLineId],
  )
  return firstRowOf<{ market_id?: string | null }>(lineResult)?.market_id ?? null
}

export default async function commissionAuditLog({ event, container }: SubscriberArgs): Promise<void> {
  const logger = (container.resolve(ContainerRegistrationKeys.LOGGER) as Logger | undefined) ?? console
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as PgConnection
  const eventName = eventNameOf(event)
  const data = eventDataOf(event)

  try {
    if (!(await auditTableExists(db))) {
      logger.info?.("[commission-audit-log] commission_audit_log table absent; logging event only", {
        event: eventName,
      })
      return
    }

    const marketId = await resolveMarketId(db, data)
    if (!marketId) {
      logger.warn?.("[commission-audit-log] missing market_id; event not persisted", {
        event: eventName,
      })
      return
    }

    await db.raw?.(
      `insert into commission_audit_log (
         id, market_id, event_name, commission_line_id, order_id, seller_id, payload, created_at
       )
       select ?, scope.market_id, ?, ?, ?, ?, ?::jsonb, now()
         from (select ?::text as market_id) scope
        where scope.market_id = ?`,
      [
        randomUUID(),
        eventName,
        data.commission_line_id ?? data.id ?? null,
        data.order_id ?? null,
        data.seller_id ?? null,
        JSON.stringify(data),
        marketId,
        marketId,
      ],
    )
  } catch (error) {
    logger.warn?.("[commission-audit-log] failed to persist commission event", {
      event: eventName,
      error: (error as Error)?.message ?? String(error),
    })
  }
}

export const config: SubscriberConfig = {
  event: [
    "commission.commission-line.created",
    "commission.commission-line.updated",
    "commission.commission-rate.created",
    "commission.commission-rate.updated",
    "commission.commission-rule.created",
    "commission.commission-rule.updated",
    "commission.created",
    "commission.updated",
    "commission_line.created",
    "commission_line.updated",
    "commission-line.created",
    "commission-line.updated",
    "commission.line.created",
    "commission.line.updated",
    "commission_rate.created",
    "commission_rate.updated",
    "commission-rate.created",
    "commission-rate.updated",
    "commission.rule.created",
    "commission.rule.updated",
    "commission_rule.created",
    "commission_rule.updated",
    "commission-rule.created",
    "commission-rule.updated",
  ],
  context: {
    subscriberId: "commission-audit-log",
  },
}
