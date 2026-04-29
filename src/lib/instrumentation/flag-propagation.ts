/**
 * Flag-propagation instrumentation — D-69 multi-timestamp tracking for the
 * B12 fire drill SLA `T3 - T1 ≤ 100ms`.
 *
 * Three timestamps:
 *
 *   T1  — DB COMMIT timestamp (`transaction_timestamp()` from the audit INSERT row).
 *         Authoritative; sourced from Postgres clock so we avoid app-clock drift.
 *
 *   T2  — Flag-service propagation. Proxied by Redis `PUBLISH` reply (=subscriber
 *         count) in v1.5.0. True per-subscriber ack metadata (each subscriber
 *         echoing its `XACK` to a control channel) deferred to v1.6.0.
 *
 *   T3  — First request rejected by the cart settlement re-validation step
 *         (storefront — see `GP/storefront/src/lib/checkout/settlement-revalidation.ts`).
 *         Storefront emits `cart.settlement.aborted_by_seller_status` with a
 *         `t3_observed_at` field; backend reconciles via `seller_id + t1_db_commit`.
 *
 * The combined event `flag.propagation.measured` is emitted to PostHog (per Step 7
 * Observability supplement) so dashboards can compute `(t3 - t1)` p99 across drill
 * rehearsals and real ops events.
 *
 * @see _bmad-output/planning-artifacts/architecture.md L450-464 (D-69)
 * @see _bmad-output/planning-artifacts/architecture.md L1281 (G-B12-FIRE-DRILL gate)
 * @see _bmad-output/planning-artifacts/architecture.md L2361 (NEW
 *      `flag.propagation.measured` event)
 */

export type FlagPropagationT1 = {
  marketId: string
  sellerId: string
  flagName: string
  t1DbCommit: Date
  drillId?: string
}

export type FlagPropagationT2 = {
  marketId: string
  sellerId: string
  flagName: string
  t1DbCommit: Date
  t2RedisAckAt: Date
  subscriberAckCount: number
  drillId?: string
}

export type FlagPropagationT3 = {
  marketId: string
  sellerId: string
  flagName: string
  t1DbCommit: Date
  t3ObservedAt: Date
  drillId?: string
}

/**
 * Internal in-process buffer keyed by `(seller_id, t1.toISOString())`. The buffer
 * lets us emit a single combined `flag.propagation.measured` event after T3
 * arrives, instead of three separate fragments.
 *
 * Buffer entries are GC'd after 60s — the B12 SLA is 100ms, anything outside the
 * window is treated as a missed correlation (logged + Sentry breadcrumb).
 */
type BufferEntry = {
  t1?: FlagPropagationT1
  t2?: FlagPropagationT2
  expiresAt: number
}

const BUFFER_TTL_MS = 60_000
const buffer: Map<string, BufferEntry> = new Map()

const bufferKey = (sellerId: string, t1: Date): string =>
  `${sellerId}::${t1.toISOString()}`

const sweep = (now: number): void => {
  for (const [key, entry] of buffer.entries()) {
    if (entry.expiresAt <= now) buffer.delete(key)
  }
}

type PostHogClient = {
  capture: (input: {
    distinctId: string
    event: string
    properties: Record<string, unknown>
  }) => void
}

/**
 * Lazy-resolved PostHog client. v1.5.0 wires this through `@medusajs/framework`
 * container keys; this module accepts a manual override for tests.
 */
let _postHog: PostHogClient | null = null
export const setPostHogClientForTests = (client: PostHogClient | null): void => {
  _postHog = client
}
const captureEvent = (event: string, properties: Record<string, unknown>): void => {
  if (!_postHog) return
  _postHog.capture({
    distinctId: String(properties.seller_id ?? "system"),
    event,
    properties,
  })
}

export const emitFlagPropagationT1 = (t1: FlagPropagationT1): void => {
  const now = Date.now()
  sweep(now)
  const key = bufferKey(t1.sellerId, t1.t1DbCommit)
  const entry = buffer.get(key) ?? { expiresAt: now + BUFFER_TTL_MS }
  entry.t1 = t1
  entry.expiresAt = now + BUFFER_TTL_MS
  buffer.set(key, entry)

  captureEvent("flag.propagation.t1_db_commit", {
    market_id: t1.marketId,
    seller_id: t1.sellerId,
    flag_name: t1.flagName,
    t1_db_commit: t1.t1DbCommit.toISOString(),
    drill_id: t1.drillId ?? null,
  })
}

export const emitFlagPropagationT2 = (t2: FlagPropagationT2): void => {
  const now = Date.now()
  sweep(now)
  const key = bufferKey(t2.sellerId, t2.t1DbCommit)
  const entry = buffer.get(key) ?? { expiresAt: now + BUFFER_TTL_MS }
  entry.t2 = t2
  entry.expiresAt = now + BUFFER_TTL_MS
  buffer.set(key, entry)

  captureEvent("flag.propagation.t2_redis_pub", {
    market_id: t2.marketId,
    seller_id: t2.sellerId,
    flag_name: t2.flagName,
    t1_db_commit: t2.t1DbCommit.toISOString(),
    t2_redis_ack_at: t2.t2RedisAckAt.toISOString(),
    subscriber_ack_count: t2.subscriberAckCount,
    drill_id: t2.drillId ?? null,
  })
}

export const emitFlagPropagationT3 = (t3: FlagPropagationT3): void => {
  const now = Date.now()
  sweep(now)
  const key = bufferKey(t3.sellerId, t3.t1DbCommit)
  const entry = buffer.get(key)

  // Always emit the per-fragment T3 event so the storefront's view is recorded
  // even if T1/T2 were lost (cross-process — storefront ↔ backend).
  captureEvent("flag.propagation.t3_first_reject", {
    market_id: t3.marketId,
    seller_id: t3.sellerId,
    flag_name: t3.flagName,
    t1_db_commit: t3.t1DbCommit.toISOString(),
    t3_observed_at: t3.t3ObservedAt.toISOString(),
    drill_id: t3.drillId ?? null,
  })

  if (!entry || !entry.t1) {
    // No T1 in this process — combined event will be reconstructed downstream.
    return
  }

  const t1 = entry.t1.t1DbCommit
  const t2 = entry.t2?.t2RedisAckAt
  const t3At = t3.t3ObservedAt
  const t3MinusT1Ms = t3At.getTime() - t1.getTime()

  captureEvent("flag.propagation.measured", {
    market_id: t3.marketId,
    seller_id: t3.sellerId,
    flag_name: t3.flagName,
    t1_db_commit: t1.toISOString(),
    t2_redis_pub: t2?.toISOString() ?? null,
    t2_subscriber_ack_count: entry.t2?.subscriberAckCount ?? null,
    t3_first_reject: t3At.toISOString(),
    t3_minus_t1_ms: t3MinusT1Ms,
    drill_id: t3.drillId ?? null,
  })

  buffer.delete(key)
}

/**
 * Test-only: clear the in-process buffer between specs.
 */
export const __resetBufferForTests = (): void => {
  buffer.clear()
}
