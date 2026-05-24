/**
 * v1.9.0 wf5 (H-2 / F-CC1-003 / ra-E1) — webhook-before-order race recovery.
 *
 * Problem (closes Epic-1 HIGH H-2 + CC-1 F-CC1-003 + ra-E1 P1):
 *   For instant payment methods (BLIK, P24, Apple Pay, Google Pay), Stripe
 *   often delivers `payment_intent.succeeded` → our Path Y subscriber sees
 *   `payment.captured` BEFORE the storefront calls `/store/carts/:id/complete`
 *   to finalize the order. At that moment `payload.order_id` is missing and
 *   the audit subscriber persists the dedup row but cannot issue entitlement.
 *   Pre-fix this was a silent no-op (customer paid, no voucher, no signal).
 *
 *   v1.9.0 wf5 stripePaymentAuditWorkflow.processMutation now writes
 *   `envelope.entitlement_issue_deferred_reason="webhook_before_order"` onto
 *   the dedup row when the race fires. This subscriber listens to
 *   `order.placed`, scans `webhook_event_processed` rows that match the new
 *   order's payment_intent and have the deferred-reason key set, and
 *   re-invokes `issueEntitlementsForAllLineItems` retroactively.
 *
 * Design (per ADR-107 §Etap-2):
 *   - Joint gate: entitlement issuance requires BOTH `payment.captured` AND
 *     `order.placed` to have fired. Either order is acceptable; this
 *     subscriber implements the captured-first path.
 *   - Idempotent: the per-(order_id, line_item_id) UNIQUE index on
 *     entitlement_instance guarantees re-issue is a no-op if the captured
 *     event-side already created the row.
 *   - On success the deferred-reason key is replaced with
 *     `entitlement_issue_resolved_at` so an operator query can confirm
 *     recovery (and so we don't repeatedly retry on subsequent
 *     `order.placed` events for the same order).
 *
 * NOTE: this subscriber operates on the Mercur Medusa `order.placed` event
 * which the standard `on-order-completed.ts` subscriber also listens to. They
 * coexist: this one is the Stripe-specific recovery path; the other is a
 * no-op breadcrumb post-Wave-B revert (H-8 fix).
 */
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  issueEntitlementsForAllLineItems,
  MissingEntitlementProfileError,
} from "../workflows/entitlements/issue-entitlement"

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

type OrderPlacedPayload = {
  id?: string
  order_id?: string
  order_ids?: string[]
}

type QueryResult<T> = Promise<{ rows: T[]; rowCount?: number | null }>
type PgClient = {
  query: <T = Record<string, unknown>>(
    sql: string,
    values?: ReadonlyArray<unknown>
  ) => QueryResult<T>
  release?: () => void
}
type PgPool = { connect: () => Promise<PgClient> }
type KnexLike = {
  raw: (
    sql: string,
    bindings?: ReadonlyArray<unknown>
  ) => Promise<{ rows?: unknown[]; rowCount?: number | null } | unknown[]>
  transaction: <T>(handler: (trx: KnexLike) => Promise<T>) => Promise<T>
}

function resolveLogger(
  container: Record<string, unknown> | undefined
): LoggerLike {
  const direct = container?.logger as LoggerLike | undefined
  if (direct) return direct
  const resolver = container?.resolve as ((key: string) => unknown) | undefined
  if (typeof resolver === "function") {
    try {
      return (resolver("logger") as LoggerLike | undefined) ?? console
    } catch {
      return console
    }
  }
  return console
}

function extractOrderIds(data: OrderPlacedPayload): string[] {
  if (Array.isArray(data.order_ids) && data.order_ids.length > 0) {
    return data.order_ids
  }
  if (typeof data.order_id === "string" && data.order_id.length > 0) {
    return [data.order_id]
  }
  if (typeof data.id === "string" && data.id.length > 0) {
    return [data.id]
  }
  return []
}

function resolveDb(scope: {
  resolve: (key: string) => unknown
}): PgPool | KnexLike {
  try {
    return scope.resolve("__pg_pool__") as PgPool
  } catch {
    return scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as KnexLike
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
      const bindings: unknown[] = []
      const sql = text.replace(/\$(\d+)/g, (_m, idx: string) => {
        bindings.push(values[Number(idx) - 1])
        return "?"
      })
      const result = await db.raw(sql, bindings)
      if (Array.isArray(result)) {
        return { rows: result as T[], rowCount: result.length }
      }
      const rows = ((result as { rows?: unknown[] }).rows ?? []) as T[]
      return {
        rows,
        rowCount: (result as { rowCount?: number | null }).rowCount ?? rows.length,
      }
    },
  }
}

async function withTransaction<T>(
  db: PgPool | KnexLike,
  handler: (client: PgClient) => Promise<T>
): Promise<T> {
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

type DeferredCaptureRow = {
  event_id: string
  market_id: string | null
  payment_intent_id: string | null
  envelope: Record<string, unknown>
  amount_minor: number | null
  currency: string | null
  payment_id: string | null
}

/**
 * Scan webhook_event_processed for `payment.captured` rows that:
 *   - were marked `entitlement_issue_deferred_reason="webhook_before_order"`
 *     by the audit workflow,
 *   - have NOT been resolved yet (no `entitlement_issue_resolved_at` key),
 *   - whose payment_intent_id matches a payment belonging to this order.
 *
 * Returns the matching captured-rows. Multiple match is possible (one PI per
 * order is the norm, but we don't constrain).
 */
async function findDeferredCapturesForOrder(
  client: PgClient,
  orderId: string
): Promise<DeferredCaptureRow[]> {
  const result = await client.query<{
    event_id: string
    market_id: string | null
    envelope: Record<string, unknown>
    amount: number | null
    currency_code: string | null
    payment_id: string | null
    payment_intent_id: string | null
  }>(
    `
      SELECT
        wep.event_id,
        wep.market_id,
        wep.envelope,
        p.amount,
        p.currency_code,
        p.id AS payment_id,
        SUBSTRING(wep.envelope->>'scope' FROM 'payment_intent:(.+)') AS payment_intent_id
      FROM webhook_event_processed wep
      JOIN payment p
        ON wep.envelope->>'scope' = 'payment_intent:' || (p.data->>'id')
        AND p.deleted_at IS NULL
      JOIN order_payment_collection opc
        ON opc.payment_collection_id = p.payment_collection_id
        AND opc.deleted_at IS NULL
      WHERE opc.order_id = $1
        AND wep.provider = 'stripe'
        AND wep.envelope->>'event_type' = 'payment.captured'
        AND wep.envelope ? 'entitlement_issue_deferred_reason'
        AND NOT (wep.envelope ? 'entitlement_issue_resolved_at')
    `,
    [orderId]
  )

  return result.rows.map((r) => ({
    event_id: r.event_id,
    market_id: r.market_id,
    payment_intent_id: r.payment_intent_id,
    envelope: r.envelope,
    amount_minor: typeof r.amount === "number" ? r.amount : Number(r.amount ?? 0),
    currency: r.currency_code?.toUpperCase() ?? null,
    payment_id: r.payment_id,
  }))
}

async function markDeferredResolved(
  client: PgClient,
  eventId: string,
  resolvedAt: Date
): Promise<void> {
  await client.query(
    `UPDATE webhook_event_processed
        SET envelope = envelope || jsonb_build_object(
              'entitlement_issue_resolved_at', $2::text,
              'entitlement_issue_resolved_reason', 'order.placed_retry'
            )
      WHERE event_id = $1 AND provider = 'stripe'`,
    [eventId, resolvedAt.toISOString()]
  )
}

export default async function onOrderPlacedStripeRetry({
  event,
  container,
}: SubscriberArgs<OrderPlacedPayload>): Promise<void> {
  const logger = resolveLogger(container as unknown as Record<string, unknown>)
  const orderIds = extractOrderIds(event.data)
  if (orderIds.length === 0) {
    return
  }

  const scope = container as unknown as { resolve: (key: string) => unknown }
  const db = resolveDb(scope)

  for (const orderId of orderIds) {
    try {
      await withTransaction(db, async (client) => {
        const deferred = await findDeferredCapturesForOrder(client, orderId)
        if (deferred.length === 0) {
          return
        }

        for (const row of deferred) {
          try {
            const result = await issueEntitlementsForAllLineItems(
              client,
              {
                event_id: row.event_id,
                order_id: orderId,
                payment_id: row.payment_id ?? undefined,
                payment_intent_id: row.payment_intent_id ?? undefined,
                market_id: row.market_id,
                amount_minor: row.amount_minor,
                currency: row.currency,
                entitlement_profile: null,
              },
              new Date()
            )
            await markDeferredResolved(client, row.event_id, new Date())
            logger.info?.(
              `[on-order-placed-stripe-retry] order_id=${orderId} ` +
                `event_id=${row.event_id} retroactively issued ` +
                `${result.results.length} entitlement(s)`
            )
          } catch (err) {
            if (err instanceof MissingEntitlementProfileError) {
              logger.warn?.(
                `[on-order-placed-stripe-retry] order_id=${orderId} ` +
                  `event_id=${row.event_id} still missing entitlement_profile ` +
                  `after order.placed — operator action required: ${err.message}`
              )
              continue
            }
            throw err
          }
        }
      })
    } catch (err) {
      const error = err as Error
      logger.error?.(
        `[on-order-placed-stripe-retry] order_id=${orderId} failed: ` +
          `${error.name}: ${error.message}`
      )
      // Do NOT re-throw: a recovery-side failure must not crash the order.placed
      // event delivery and block other subscribers. The deferred row stays
      // marked, an operator can investigate via the audit envelope.
    }
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
