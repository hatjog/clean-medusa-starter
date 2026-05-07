/**
 * POST /admin/sellers/:id/pause — compatibility proxy for Mercur 2 seller suspension.
 *
 * Story v160-1-7.1 keeps this route as a thin telemetry-preserving proxy while
 * replacing the legacy GP `paused` / `disabled` states with Mercur 2 native
 * `suspended` / `terminated`.
 *
 * Atomic transaction shape (per architecture.md L450-464 + ADR-074):
 *
 *   BEGIN;
 *   SELECT id, status, version FROM seller WHERE id = $1 FOR UPDATE;
 *   UPDATE seller SET status = 'suspended', version = version + 1 WHERE id = $1;
 *   INSERT INTO seller_status_change_audit (
 *     id, market_id, seller_id, prev_status, new_status,
 *     affected_orders, runtime_context, reason, changed_by, changed_at
 *   ) VALUES (
 *     $uuid, $market_id, $seller_id, $prev_status, 'suspended',
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
import { extractActorIdOrThrow, requireCapability } from "../../../../../lib/capability-check"

/**
 * Minimum character length for an override reason (AC4).
 * Enforce non-trivial justification — a single word is insufficient for
 * audit purposes given the high-risk nature of the capability.
 */
const OVERRIDE_REASON_MIN_LENGTH = 10

type PauseRequestBody = {
  reason?: string
  /**
   * When set, the caller is signalling that this pause is part of a B12 fire
   * drill rehearsal — the propagation event payload includes a `drill_id` so
   * downstream PostHog dashboards can isolate drill noise from real ops events.
   */
  drill_id?: string
  /**
   * When true, the caller is invoking the FR54 training-cert gate override
   * path. Requires capability `vendor.lifecycle.override_training_cert` and
   * a non-empty reason of at least 10 characters (AC1/AC4).
   */
  override?: boolean
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
  const isOverride = body.override === true

  if (!reason) {
    res.status(400).json({
      code: "REASON_REQUIRED",
      message: "ADR-074 mandates an audit `reason` for every status transition",
    })
    return
  }

  // AC4 — when override=true enforce a minimum-length reason that provides
  // meaningful justification for bypassing the FR54 training-cert gate.
  if (isOverride && reason.length < OVERRIDE_REASON_MIN_LENGTH) {
    res.status(400).json({
      code: "OVERRIDE_REASON_REQUIRED",
      message: `Override reason must be at least ${OVERRIDE_REASON_MIN_LENGTH} characters after trimming`,
    })
    return
  }

  let actorId: string
  try {
    actorId = extractActorIdOrThrow(req)
  } catch {
    res.status(401).json({ code: "UNAUTHORIZED", message: "Valid admin session required" })
    return
  }

  // AC1/AC2 — capability gate for the override path.
  // Must be evaluated BEFORE any DB write or audit row is emitted.
  if (isOverride) {
    const cap = await requireCapability(req, "vendor.lifecycle.override_training_cert")
    if (!cap.ok) {
      res.status(cap.status).json(cap.body)
      return
    }
  }
  const marketId = extractMarketId(req)
  const logger = (req.scope.resolve(ContainerRegistrationKeys.LOGGER) as unknown as Logger | undefined) ?? {}

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

    if (prevStatus === "suspended") {
      // Idempotent — abort silently, do not re-emit propagation event.
      await client.query("ROLLBACK")
      res.status(200).json({ ok: true, idempotent: true, status: "suspended" })
      return
    }

    if (prevStatus === "terminated") {
      // ADR-074: `terminated` is terminal — admin suspension is a no-op.
      await client.query("ROLLBACK")
      res.status(409).json({
        code: "TERMINATED_TERMINAL",
        message: "ADR-074 forbids suspended→open OR terminated→suspended without manual re-enable workflow",
      })
      return
    }

    // 2) Flip status + bump optimistic-lock `version`.
    await client.query(
      'UPDATE seller SET status = $1, version = version + 1 WHERE id = $2',
      ["suspended", sellerId]
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
         $1, $2, $3, $4, 'suspended',
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
        // AC3 — when override=true, extend runtime_context with override flag
        // and override_reason so the audit trail captures the justification.
        // No schema change required: runtime_context is a JSONB column.
        JSON.stringify({
          vendor_mor_enabled: true,
          drill_id: body.drill_id ?? null,
          ...(isOverride ? { override: true, override_reason: reason } : {}),
        }),
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
          new_status: "suspended",
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
    new_status: "suspended",
    affected_orders: affectedOrders,
    audit_id: auditId,
    t1_db_commit: t1DbCommit?.toISOString(),
  })
}
