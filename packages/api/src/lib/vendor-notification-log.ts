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
 */

import type { Knex } from "knex"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import type { VendorNotificationLogEntry } from "../modules/vendor-notifications"

const TABLE = "vendor_notification_log"

type Scope = { resolve: (key: string) => unknown }

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
