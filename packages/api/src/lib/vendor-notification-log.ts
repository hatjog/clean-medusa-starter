/**
 * Story v160-cleanup-7-vendor-lifecycle-prod-wiring follow-up — durable
 * vendor notification audit log persistence.
 *
 * Closes the AC4 gap from Stories 7.1/7.2/7.3 where audit entries were
 * generated but only kept in process-local arrays + console.info. Now
 * `appendNotificationLog` writes to the append-only
 * `vendor_notification_log` table; `listNotificationLog` reads it.
 *
 * Append-only enforced by Postgres trigger (see migration
 * 20260505000000_VendorNotificationLogTable). Caller MUST pass a Knex
 * instance from request scope; in-memory fallback is intentionally NOT
 * provided to prevent silent regression to non-durable audit trails.
 *
 * Story v160-cleanup-40-nudge-dedup (TF-94 P0):
 *   - `findRecentNotificationLog` — cooldown window lookup for dedup gate (AC1)
 *   - `assertNotificationLogTableReady` — fail-closed readiness probe (AC7)
 *   - `NotificationLogTableUnavailableError` — typed error for 503 routing (AC7)
 *   - `resolveNudgeCooldownHours` — per-step cooldown with env override (AC1)
 *   - `NUDGE_DEDUP_COOLDOWN_HOURS_DEFAULT` / `NUDGE_DEDUP_WINDOW_MAX_DAYS` (AC1, AC6)
 */

import type { Knex } from "knex"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import type { VendorNotificationLogEntry } from "../modules/vendor-notifications"
import type { NudgeCadenceStep } from "../modules/vendor-notifications/email-templates/nudge-cadence/i18n"

const TABLE = "vendor_notification_log"

type Scope = { resolve: (key: string) => unknown }

// ---------------------------------------------------------------------------
// Dedup constants (AC1 + AC6)
// ---------------------------------------------------------------------------

/** Default cooldown per nudge step — 24 h. Operator overrideable via env. */
export const NUDGE_DEDUP_COOLDOWN_HOURS_DEFAULT = 24

/** Hard upper bound on dedup query window — 7 days. Prevents unbounded scans (AC6). */
export const NUDGE_DEDUP_WINDOW_MAX_DAYS = 7

/**
 * Resolve effective cooldown hours for a nudge step (AC1).
 *
 * Priority: caller-supplied override > GP_NUDGE_DEDUP_COOLDOWN_JSON env > default 24h.
 * Populated from GP_NUDGE_DEDUP_COOLDOWN_JSON env var (JSON object) at runtime.
 */
export function resolveNudgeCooldownHours(
  step: NudgeCadenceStep,
  overrides?: Partial<Record<NudgeCadenceStep, number>>,
): number {
  // Review F3: validate finite + positive; reject NaN/Infinity/negative/zero.
  // Invalid values fall through to next priority tier so the dedup gate
  // cannot be silently disabled by a misconfigured env (TF-94 P0 fail-open
  // prevention — a negative cooldown would produce a future `since` and
  // miss every prior row, defeating the gate).
  const isValidHours = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v > 0
  if (overrides && isValidHours(overrides[step])) {
    return overrides[step] as number
  }
  const envRaw = process.env.GP_NUDGE_DEDUP_COOLDOWN_JSON
  if (envRaw) {
    try {
      const parsed = JSON.parse(envRaw) as Partial<Record<NudgeCadenceStep, number>>
      if (isValidHours(parsed[step])) return parsed[step] as number
    } catch {
      // ignore malformed env — fall through to default
    }
  }
  return NUDGE_DEDUP_COOLDOWN_HOURS_DEFAULT
}

// ---------------------------------------------------------------------------
// Typed error for fail-closed route handling (AC7)
// ---------------------------------------------------------------------------

/** Thrown by assertNotificationLogTableReady when the table is unavailable (AC7). */
export class NotificationLogTableUnavailableError extends Error {
  readonly code = "NUDGE_DEDUP_UNAVAILABLE" as const
  constructor(cause?: string) {
    super(
      `vendor_notification_log table is not available${cause ? `: ${cause}` : ""}. ` +
        "Run pending migrations before dispatching nudges.",
    )
    this.name = "NotificationLogTableUnavailableError"
  }
}

// ---------------------------------------------------------------------------
// Existing types
// ---------------------------------------------------------------------------

export type AppendNotificationLogInput = Omit<
  VendorNotificationLogEntry,
  "id" | "sent_at"
> & {
  id?: string
  sent_at?: string
  metadata?: Record<string, unknown>
}

export type ListNotificationLogFilters = {
  vendor_id?: string
  notification_type?: VendorNotificationLogEntry["notification_type"]
  status?: VendorNotificationLogEntry["status"]
  limit?: number
  offset?: number
}

function resolveDb(scope: Scope): Knex {
  return scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
}

/**
 * Append a notification audit row. Returns the persisted row including
 * server-assigned id + sent_at when caller didn't provide them.
 *
 * Throws on DB failure — caller may retry or escalate; silent swallow
 * would re-introduce the durability gap that closure of AC4 required to
 * eliminate.
 */
export async function appendNotificationLog(
  scope: Scope,
  input: AppendNotificationLogInput,
): Promise<VendorNotificationLogEntry> {
  const db = resolveDb(scope)
  const insert: Record<string, unknown> = {
    vendor_id: input.vendor_id,
    vendor_handle: input.vendor_handle ?? null,
    notification_type: input.notification_type,
    locale: input.locale,
    recipient_email: input.recipient_email,
    status: input.status,
    error_message: input.error_message ?? null,
    triggered_by: input.triggered_by,
    metadata: input.metadata ?? null,
  }
  if (input.id) insert.id = input.id
  if (input.sent_at) insert.sent_at = input.sent_at
  if (typeof input.forced === "boolean") insert.forced = input.forced

  const [row] = await db<VendorNotificationLogEntry>(TABLE)
    .insert(insert)
    .returning("*")

  if (!row) {
    throw new Error("vendor_notification_log_insert_returned_no_row")
  }
  return row
}

/**
 * Best-effort variant — when DB write fails, returns the input as a
 * synthetic entry so callers that want graceful degradation (e.g. when
 * the DB is down mid-dispatch) can keep responding to the admin client
 * with the audit_log_id they would have had. Use this ONLY for routes
 * where surfacing 5xx would block legitimate user flow.
 *
 * In normal operation prefer `appendNotificationLog` (throws on failure)
 * so silent dropouts are visible to operators via 5xx + alerting.
 */
export async function appendNotificationLogBestEffort(
  scope: Scope,
  input: AppendNotificationLogInput,
): Promise<{ entry: VendorNotificationLogEntry; persisted: boolean; error?: string }> {
  try {
    const entry = await appendNotificationLog(scope, input)
    return { entry, persisted: true }
  } catch (err) {
    const fallback: VendorNotificationLogEntry = {
      id: input.id ?? `audit_local_${Date.now()}`,
      vendor_id: input.vendor_id,
      vendor_handle: input.vendor_handle ?? null,
      notification_type: input.notification_type,
      sent_at: input.sent_at ?? new Date().toISOString(),
      locale: input.locale,
      recipient_email: input.recipient_email,
      status: input.status,
      error_message: input.error_message ?? null,
      triggered_by: input.triggered_by,
    }
    return { entry: fallback, persisted: false, error: (err as Error).message }
  }
}

export async function listNotificationLog(
  scope: Scope,
  filters: ListNotificationLogFilters = {},
): Promise<VendorNotificationLogEntry[]> {
  const db = resolveDb(scope)
  let q = db<VendorNotificationLogEntry>(TABLE)
    .select("*")
    .orderBy("sent_at", "desc")
  if (filters.vendor_id) q = q.where({ vendor_id: filters.vendor_id })
  if (filters.notification_type) q = q.where({ notification_type: filters.notification_type })
  if (filters.status) q = q.where({ status: filters.status })
  if (typeof filters.limit === "number") q = q.limit(filters.limit)
  if (typeof filters.offset === "number") q = q.offset(filters.offset)
  return q
}

// ---------------------------------------------------------------------------
// Dedup helpers — Story v160-cleanup-40-nudge-dedup (AC1, AC6, AC7)
// ---------------------------------------------------------------------------

export type FindRecentNotificationLogInput = {
  vendor_id: string
  notification_type: VendorNotificationLogEntry["notification_type"]
  /** ISO 8601 lower bound on sent_at. Clamped to now−7d internally (AC6). */
  since_iso: string
}

/**
 * Query vendor_notification_log for rows matching (vendor_id, notification_type)
 * with sent_at >= since_iso, limited to the AC6 7-day hard window.
 *
 * Only 'sent' status rows are returned — 'failed' and 'deduplicated' rows
 * do NOT block a new dispatch attempt (per story Risk section).
 *
 * Uses idx_vendor_notification_log_vendor_type_sent for O(log n) plan.
 */
export async function findRecentNotificationLog(
  scope: Scope,
  input: FindRecentNotificationLogInput,
): Promise<VendorNotificationLogEntry[]> {
  const db = resolveDb(scope)

  const requestedSince = new Date(input.since_iso)
  const hardWindowSince = new Date(
    Date.now() - NUDGE_DEDUP_WINDOW_MAX_DAYS * 24 * 60 * 60 * 1000,
  )
  // GREATEST(requested, now−7d): if caller's cooldown > 7d, clamp to 7d (AC6)
  const effectiveSince =
    requestedSince < hardWindowSince ? hardWindowSince : requestedSince

  return db<VendorNotificationLogEntry>(TABLE)
    .select("*")
    .where({ vendor_id: input.vendor_id, notification_type: input.notification_type, status: "sent" })
    .where("sent_at", ">=", effectiveSince.toISOString())
    .orderBy("sent_at", "desc")
}

/**
 * Probe that vendor_notification_log table is accessible. Throws
 * NotificationLogTableUnavailableError ONLY when the underlying error indicates
 * a missing table (Postgres SQLSTATE 42P01 / `undefined_table`, or message
 * matching `relation .* does not exist`). All other errors (connection
 * timeout, auth failure, lock contention) are re-thrown so the global
 * error handler returns a 500 with the real cause — operators paging on
 * NUDGE_DEDUP_UNAVAILABLE can trust that the migration is genuinely
 * missing rather than chasing a transient network blip (Review F2).
 */
export async function assertNotificationLogTableReady(scope: Scope): Promise<void> {
  const db = resolveDb(scope)
  try {
    // Bounded probe — no full seq scan
    await db<VendorNotificationLogEntry>(TABLE).select("id").limit(1)
  } catch (err) {
    if (isMissingTableError(err)) {
      throw new NotificationLogTableUnavailableError((err as Error).message ?? "")
    }
    throw err
  }
}

/**
 * Identify a Postgres "relation does not exist" condition. Matches both
 * SQLSTATE 42P01 (preferred — pg driver populates `code` on PostgresError)
 * and the message-string fallback for drivers that omit the code.
 */
function isMissingTableError(err: unknown): boolean {
  if (!err) return false
  const e = err as { code?: string; message?: string }
  if (e.code === "42P01") return true
  const msg = (e.message ?? "").toLowerCase()
  return /relation\s+.*does not exist/.test(msg) || msg.includes("undefined_table")
}
