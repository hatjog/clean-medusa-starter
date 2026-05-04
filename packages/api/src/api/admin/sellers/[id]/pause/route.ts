/**
 * POST /admin/sellers/:id/pause — D-69 atomic admin pause flow.
 *
 * TODO Story v160-1-7.1 (post-1.8 smoke verification): DROP custom PAT-17 —
 * replace with native Mercur 2 seller status workflow (4 statuses:
 * pending_approval/open/suspended/terminated) per ADR-090 §PAT-17 row.
 * Physical drop deferred until story v160-1-8 (DB drop+reload + medusa develop)
 * confirms native Mercur 2 admin endpoints preserve atomic semantics + B12 fire
 * drill SLA + flag-propagation T1/T2/T3 telemetry. Removing this file before
 * runtime verification re-introduces FM-9 risk (multi-vendor checkout race).
 *
 * Atomic transaction shape (per architecture.md L450-464 + ADR-074):
 *
 *   BEGIN;
 *   SELECT id, status, version FROM seller WHERE id = $1 FOR UPDATE;
 *   UPDATE seller SET status = 'paused', version = version + 1 WHERE id = $1;
 *   INSERT INTO seller_status_change_audit (
 *     id, market_id, seller_id, prev_status, new_status,
 *     affected_orders, runtime_context, reason, changed_by, changed_at
 *   ) VALUES (
 *     $uuid, $market_id, $seller_id, $prev_status, 'paused',
 *     (SELECT COALESCE(jsonb_agg(o.id ORDER BY o.created_at ASC), '[]'::jsonb)
 *        FROM orders o WHERE o.seller_id = $seller_id AND o.status = 'in_flight'),
 *     $runtime_context, $reason, $actor_id, transaction_timestamp()
 *   );
 *   COMMIT;
 *
 *   -- Then OUTSIDE the tx:
 *   redis.publish('seller.status.changed', payload);
 *
 * The Redis PUBLISH is intentionally outside the tx — keeping pub/sub inside the
 * tx holds the underlying connection open while subscribers process the message,
 * which would extend the SELECT FOR UPDATE row-lock window and starve other
 * checkout writers (B12 fire drill SLA risk).
 *
 * T1 (= DB COMMIT timestamp via `transaction_timestamp()`) and T2 (= first pub/sub
 * subscriber ack) are emitted via `lib/instrumentation/flag-propagation.ts`. T3
 * (= first cart-settlement abort observed) is recorded in the storefront and
 * correlated by `seller_id` + `t1_db_commit`.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { randomUUID } from "node:crypto"

import { emitFlagPropagationT1, emitFlagPropagationT2 } from "../../../../../lib/instrumentation/flag-propagation"

type PauseRequestBody = {
  reason?: string
  /**
   * When set, the caller is signalling that this pause is part of a B12 fire
   * drill rehearsal — the propagation event payload includes a `drill_id` so
   * downstream PostHog dashboards can isolate drill noise from real ops events.
   */
  drill_id?: string
}

type PgClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>
  ) => Promise<{ rows: T[] }>
  release?: () => void
}

type PgPool = {
  connect: () => Promise<PgClient>
}

type RedisPublisher = {
  publish: (channel: string, message: string) => Promise<number>
}

type Logger = {
  info?: (message: string, meta?: Record<string, unknown>) => void
  warn?: (message: string, meta?: Record<string, unknown>) => void
  error?: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * cleanup-3: Fail-closed actor resolution — phantom-actor fallback removed.
 * operatorAuthMiddleware on /admin/sellers/* guarantees actor_id is present.
 * Throwing here makes missing-actor visible as 500 rather than a phantom attribution.
 */
const extractActorId = (req: MedusaRequest): string => {
  const ctx = (req as { auth_context?: { actor_id?: string } }).auth_context
  const actorId = ctx?.actor_id
  if (!actorId) {
    throw new Error("actor_id missing from auth_context — request must be authenticated")
  }
  return actorId
}

const extractMarketId = (req: MedusaRequest): string => {
  // Mercur convention: market id is supplied via `X-Gp-Market-Id` header (Step 5
  // Supplement L1721) OR derived from the seller row in the same tx (fallback).
  const header = req.headers["x-gp-market-id"]
  if (typeof header === "string" && header.length > 0) return header
  if (Array.isArray(header) && header[0]) return header[0]
  return ""
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const sellerId = (req.params as { id?: string }).id
  if (!sellerId) {
    res.status(400).json({ code: "INVALID_INPUT", message: "seller id required" })
    return
  }

  const body = (req.body ?? {}) as PauseRequestBody
  const reason = body.reason?.trim()
  if (!reason) {
    res.status(400).json({
      code: "REASON_REQUIRED",
      message: "ADR-074 mandates an audit `reason` for every status transition",
    })
    return
  }

  const actorId = extractActorId(req)
  const marketId = extractMarketId(req)
  const logger = (req.scope.resolve(ContainerRegistrationKeys.LOGGER) as Logger | undefined) ?? {}

  // Resolve PG pool + Redis client from the Medusa container. The keys below
  // match the convention used by `gp-core` (see `src/modules/gp-core/service.ts`).
  let pool: PgPool
  let redis: RedisPublisher | undefined
  try {
    pool = req.scope.resolve("__pg_pool__") as PgPool
  } catch {
    res.status(500).json({ code: "PG_POOL_UNAVAILABLE", message: "pg pool not registered" })
    return
  }
  try {
    redis = req.scope.resolve("__redis_publisher__") as RedisPublisher
  } catch {
    redis = undefined // pub/sub fan-out will degrade gracefully (logged + Sentry breadcrumb).
  }

  const client = await pool.connect()
  const auditId = randomUUID()
  let prevStatus: string | undefined
  let t1DbCommit: Date | undefined
  let affectedOrders: string[] = []

  try {
    await client.query("BEGIN")

    // 1) Row-lock + read prior status (FOR UPDATE) so we serialize concurrent admin clicks.
    const sellerRows = await client.query<{
      id: string
      status: string
      version: number
      market_id: string
    }>(
      'SELECT id, status, version, market_id FROM seller WHERE id = $1 FOR UPDATE',
      [sellerId]
    )
    if (sellerRows.rows.length === 0) {
      await client.query("ROLLBACK")
      res.status(404).json({ code: "SELLER_NOT_FOUND", message: `seller ${sellerId} not found` })
      return
    }
    const sellerRow = sellerRows.rows[0]
    prevStatus = sellerRow.status
    const effectiveMarketId = marketId || sellerRow.market_id

    if (prevStatus === "paused") {
      // Idempotent — abort silently, do not re-emit propagation event.
      await client.query("ROLLBACK")
      res.status(200).json({ ok: true, idempotent: true, status: "paused" })
      return
    }

    if (prevStatus === "disabled") {
      // ADR-074: `disabled` is terminal — admin pause is a no-op.
      await client.query("ROLLBACK")
      res.status(409).json({
        code: "DISABLED_TERMINAL",
        message: "ADR-074 forbids paused→active OR disabled→paused without manual re-enable workflow",
      })
      return
    }

    // 2) Flip status + bump optimistic-lock `version`.
    await client.query(
      'UPDATE seller SET status = $1, version = version + 1 WHERE id = $2',
      ["paused", sellerId]
    )

    // 3) Audit row — `affected_orders` populated via subselect for atomicity.
    //    ORDER BY created_at ASC keeps determinism for the AC-FLAG-1.3-07 contract.
    const auditInsert = await client.query<{
      changed_at: Date
      affected_orders: string[]
    }>(
      `INSERT INTO seller_status_change_audit (
         id, market_id, seller_id, prev_status, new_status,
         affected_orders, runtime_context, reason, changed_by, changed_at
       ) VALUES (
         $1, $2, $3, $4, 'paused',
         COALESCE(
           (SELECT jsonb_agg(o.id ORDER BY o.created_at ASC)
              FROM orders o
             WHERE o.seller_id = $3 AND o.status = 'in_flight'),
           '[]'::jsonb
         ),
         $5::jsonb, $6, $7, transaction_timestamp()
       )
       RETURNING changed_at, affected_orders`,
      [
        auditId,
        effectiveMarketId,
        sellerId,
        prevStatus,
        JSON.stringify({ vendor_mor_enabled: true, drill_id: body.drill_id ?? null }),
        reason,
        actorId,
      ]
    )
    t1DbCommit = auditInsert.rows[0]?.changed_at
    affectedOrders = auditInsert.rows[0]?.affected_orders ?? []

    await client.query("COMMIT")
  } catch (err) {
    try {
      await client.query("ROLLBACK")
    } catch {
      // best-effort rollback; primary error is what we surface.
    }
    logger.error?.("seller.pause tx failed", { sellerId, err: (err as Error).message })
    res.status(500).json({ code: "TX_FAILED", message: (err as Error).message })
    return
  } finally {
    client.release?.()
  }

  // 4) Emit T1 instrumentation (post-COMMIT) so the SLA timer starts at the
  //    DB-canonical commit timestamp, not the application clock.
  emitFlagPropagationT1({
    marketId,
    sellerId,
    flagName: "seller.status",
    t1DbCommit: t1DbCommit ?? new Date(),
    drillId: body.drill_id,
  })

  // 5) Emit Redis pub/sub OUTSIDE the tx. T2 = first subscriber ack proxy
  //    (Redis `PUBLISH` reply = subscriber count). True per-subscriber ack
  //    deferred to v1.6.0 (see story implementation log).
  let t2SubscriberAckCount = 0
  if (redis) {
    try {
      t2SubscriberAckCount = await redis.publish(
        "seller.status.changed",
        JSON.stringify({
          schema: "seller.status.changed.v1",
          market_id: marketId,
          seller_id: sellerId,
          prior_status: prevStatus,
          new_status: "paused",
          actor_id: actorId,
          timestamp_t1_db_commit: t1DbCommit?.toISOString(),
          affected_orders: affectedOrders,
          drill_id: body.drill_id ?? null,
        })
      )
    } catch (err) {
      logger.warn?.("seller.pause redis publish failed (degraded)", {
        sellerId,
        err: (err as Error).message,
      })
    }
  } else {
    logger.warn?.("seller.pause redis publisher unavailable — propagation will rely on canary scrape", {
      sellerId,
    })
  }

  emitFlagPropagationT2({
    marketId,
    sellerId,
    flagName: "seller.status",
    t1DbCommit: t1DbCommit ?? new Date(),
    t2RedisAckAt: new Date(),
    subscriberAckCount: t2SubscriberAckCount,
    drillId: body.drill_id,
  })

  res.status(200).json({
    ok: true,
    seller_id: sellerId,
    prev_status: prevStatus,
    new_status: "paused",
    affected_orders: affectedOrders,
    audit_id: auditId,
    t1_db_commit: t1DbCommit?.toISOString(),
  })
}
