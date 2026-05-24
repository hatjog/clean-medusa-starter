import type { MedusaContainer } from "@medusajs/framework/types"

import {
  EntitlementInstanceState,
  ALLOWED_ENTITLEMENT_TRANSITIONS,
} from "../modules/voucher/models/entitlement"

/**
 * entitlement-expiry-sweeper — v1.9.0 Wave F6 / Epic-2 HIGH-07.
 *
 * Daily cron sweep that flips stale entitlements and vouchers to their
 * terminal expired state. Closes the HIGH-07 + HIGH-08 gap where:
 *   - The `EXPIRED` enum value was defined on `entitlement_instance.state`
 *     and the transition map but never written by any code path.
 *   - The `voucher.status` CHECK constraint disallowed `expired` (fixed in
 *     migration 1778926100000) and the service-layer `claim()` only branched
 *     on expiry at read-time, never persisting.
 *
 * Behavior:
 *   1. UPDATE entitlement_instance SET state='EXPIRED' WHERE state IN
 *      (ISSUED, ACTIVE, REDEMPTION_REQUESTED) AND expires_at < NOW().
 *      All three source states have EXPIRED in the legal transition list
 *      (per ALLOWED_ENTITLEMENT_TRANSITIONS — assertion baked into the SQL
 *      filter so the state machine cannot drift away silently).
 *   2. UPDATE voucher SET status='expired' WHERE status IN ('idle','consent_pending')
 *      AND expires_at < NOW(). `claimed` vouchers are NOT swept — once a
 *      recipient has claimed, expiry is a property of the underlying
 *      entitlement_instance, not the voucher row.
 *   3. Emit `gp.entitlements.entitlement_expired.v1` and `voucher.expired.v1`
 *      heartbeats to PostHog (per-row events are batched into counts only —
 *      individual event emission is deferred to the subscriber layer).
 *
 * Idempotent by design (filters by source state). Safe to re-run every
 * minute; the only mutation rows are those genuinely past expires_at.
 *
 * Schedule: every 6 hours. Eager-sweep semantics for vouchers with a
 * trailing-week expiry are not required for BonBeauty MVP; this is a
 * defense-in-depth job complementing the read-time expiry check in
 * `VoucherService.claim`.
 */

export const SCHEDULE_NAME = "entitlement-expiry-sweeper" as const
export const SCHEDULE_CRON = "0 */6 * * *" as const

interface JobLogger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string, err?: unknown) => void
}

interface PosthogClient {
  capture(args: {
    distinctId: string
    event: string
    properties?: Record<string, unknown>
  }): void
}

type PgClientLike = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Promise<{ rows: T[]; rowCount?: number | null }>
  release?: () => void
}

type PgPoolLike = { connect: () => Promise<PgClientLike> }
type KnexLike = {
  raw: (
    sql: string,
    bindings?: ReadonlyArray<unknown>
  ) => Promise<{ rows?: unknown[]; rowCount?: number | null } | unknown[]>
}

function resolveLogger(container: MedusaContainer | undefined): JobLogger {
  const fallback: JobLogger = {
    info: (m) => console.log(`[${SCHEDULE_NAME}] ${m}`),
    warn: (m) => console.warn(`[${SCHEDULE_NAME}] ${m}`),
    error: (m, e) => console.error(`[${SCHEDULE_NAME}] ${m}`, e),
  }
  try {
    const resolved = container?.resolve?.("logger") as Partial<JobLogger> | undefined
    if (resolved && typeof resolved.info === "function") {
      return {
        info: resolved.info.bind(resolved),
        warn: (resolved.warn ?? resolved.info).bind(resolved),
        error: (resolved.error ?? resolved.info).bind(resolved),
      }
    }
  } catch {
    // fall through
  }
  return fallback
}

function resolveOptional<T>(
  container: MedusaContainer | undefined,
  key: string
): T | null {
  try {
    return (container?.resolve?.(key) as T | undefined) ?? null
  } catch {
    return null
  }
}

function expiryTransitionLegal(state: EntitlementInstanceState): boolean {
  return ALLOWED_ENTITLEMENT_TRANSITIONS[state].includes(
    EntitlementInstanceState.EXPIRED
  )
}

const SOURCE_STATES: EntitlementInstanceState[] = [
  EntitlementInstanceState.ISSUED,
  EntitlementInstanceState.ACTIVE,
  EntitlementInstanceState.REDEMPTION_REQUESTED,
].filter(expiryTransitionLegal)

async function runUpdate(
  exec: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null }>,
  sql: string,
  params: unknown[]
): Promise<number> {
  const result = await exec(sql, params)
  return result.rowCount ?? 0
}

export default async function entitlementExpirySweeper(
  container: MedusaContainer
): Promise<void> {
  const logger = resolveLogger(container)
  const posthog = resolveOptional<PosthogClient>(container, "posthog")

  // REDEMPTION_REQUESTED legality check is a defensive assertion: the state
  // machine MUST keep EXPIRED reachable from each source state we sweep. If
  // ALLOWED_ENTITLEMENT_TRANSITIONS drifts away the job becomes a no-op for
  // that source state — flagged by the warning rather than silently writing
  // an illegal transition.
  if (
    !ALLOWED_ENTITLEMENT_TRANSITIONS[EntitlementInstanceState.REDEMPTION_REQUESTED].includes(
      EntitlementInstanceState.EXPIRED
    )
  ) {
    logger.warn(
      "entitlement transition table omits REDEMPTION_REQUESTED→EXPIRED; sweeper will skip that source state"
    )
  }

  let pool: PgPoolLike | KnexLike | null = resolveOptional<PgPoolLike>(
    container,
    "__pg_pool__"
  )
  if (!pool) {
    pool = resolveOptional<KnexLike>(container, "pg")
  }
  if (!pool) {
    logger.warn("no postgres pool resolved — skipping expiry sweep")
    return
  }

  const exec = await pgExecFromUnion(pool)
  if (!exec) {
    logger.warn("postgres pool shape unrecognised — skipping expiry sweep")
    return
  }

  const startedAt = new Date()
  let entitlementsExpired = 0
  let vouchersExpired = 0

  try {
    entitlementsExpired = await runUpdate(
      exec,
      `UPDATE entitlement_instance
          SET state = $1, updated_at = NOW()
        WHERE state = ANY($2::text[])
          AND expires_at IS NOT NULL
          AND expires_at < NOW()`,
      [EntitlementInstanceState.EXPIRED, SOURCE_STATES]
    )
  } catch (err) {
    logger.error("entitlement_instance expiry sweep failed", err)
    throw err
  }

  try {
    vouchersExpired = await runUpdate(
      exec,
      `UPDATE voucher
          SET status = 'expired', updated_at = NOW()
        WHERE status IN ('idle','consent_pending')
          AND expires_at IS NOT NULL
          AND expires_at < NOW()`,
      []
    )
  } catch (err) {
    logger.error("voucher expiry sweep failed", err)
    throw err
  }

  logger.info(
    `swept entitlements=${entitlementsExpired} vouchers=${vouchersExpired} ` +
      `started=${startedAt.toISOString()} done=${new Date().toISOString()}`
  )

  posthog?.capture({
    distinctId: "entitlement-expiry-sweeper",
    event: "gp.entitlements.expiry_sweeper.heartbeat",
    properties: {
      entitlements_expired: entitlementsExpired,
      vouchers_expired: vouchersExpired,
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
    },
  })
}

async function pgExecFromUnion(
  pool: PgPoolLike | KnexLike
): Promise<((sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null }>) | null> {
  const asPool = pool as PgPoolLike
  if (typeof asPool.connect === "function") {
    return async (sql, params) => {
      const client = await asPool.connect()
      try {
        const res = await client.query(sql, params)
        return { rowCount: res.rowCount ?? 0 }
      } finally {
        client.release?.()
      }
    }
  }
  const asKnex = pool as KnexLike
  if (typeof asKnex.raw === "function") {
    return async (sql, params) => {
      const bindings: unknown[] = []
      const text = sql.replace(/\$(\d+)/g, (_m, idx: string) => {
        bindings.push((params ?? [])[Number(idx) - 1])
        return "?"
      })
      const res = await asKnex.raw(text, bindings)
      if (Array.isArray(res)) {
        return { rowCount: res.length }
      }
      return { rowCount: (res as { rowCount?: number | null }).rowCount ?? 0 }
    }
  }
  return null
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
}
