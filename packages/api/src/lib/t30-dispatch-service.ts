/**
 * Story v160-cleanup-5: T-30 dispatch service (in-process).
 *
 * Extracts the dispatch logic from the Story 7.1 admin route so that
 * `triggerT30Kickoff()` (Story 8.2) can call the REAL dispatcher instead of
 * reading a phantom `GP_KICKOFF_VENDOR_COUNT` env var.
 *
 * Design:
 *   - Route `POST /admin/vendors/notifications/t30` now delegates to this
 *     service (thin adapter layer only — no logic duplication).
 *   - `triggerT30Kickoff()` calls `dispatchT30Notifications()` directly
 *     (in-process, no HTTP round-trip).
 *   - Production hard-block: when `NODE_ENV === "production"` and no real
 *     vendor list is reachable (fixture mode), the service throws
 *     `T30DispatcherFixtureModeError` which kickoff translates to HTTP 503.
 *
 * @see Story 7.1 — T-30 migration notification admin route
 * @see Story 8.2 — T-30 kickoff trigger workflow
 * @see CRIT-7.4 epic-7-adversarial-review-2026-05-04.md
 */

import { randomUUID } from "node:crypto"
import {
  renderT30Html,
  renderT30Subject,
  renderT30Text,
  type VendorNotificationLogEntry,
  type T30EmailLocale,
} from "../modules/vendor-notifications"
import {
  assertNotificationProviderReady,
  NotificationProviderNotReadyError,
} from "./vendor-notification-provider-readiness"

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface VendorRow {
  id: string
  handle: string
  email: string
  preferred_locale: T30EmailLocale | null
}

export interface T30DispatchResult {
  triggered: number
  skipped: number
  failed: number
  audit_log_ids: string[]
  /** In-memory audit log entries (for integration tests and kickoff coupling). */
  audit_entries: VendorNotificationLogEntry[]
}

export interface T30DispatchOptions {
  triggered_by: string
  vendor_ids?: string[]
  flag_flip_iso: string
  logger?: T30Logger
}

export type T30Logger = {
  info?: (message: string, meta?: Record<string, unknown>) => void
  warn?: (message: string, meta?: Record<string, unknown>) => void
}

/** Thrown when production env detects fixture mode (no real vendor data). */
export class T30DispatcherFixtureModeError extends Error {
  readonly code = "T30_FIXTURE_MODE_IN_PRODUCTION"
  constructor() {
    super(
      "T-30 dispatcher is in fixture/stub mode but NODE_ENV=production. " +
        "Real vendor data source (Mercur 2 vendor table) must be wired before kickoff.",
    )
    this.name = "T30DispatcherFixtureModeError"
  }
}

export { NotificationProviderNotReadyError }

// ---------------------------------------------------------------------------
// Internal helpers (also exported for use in the admin route)
// ---------------------------------------------------------------------------

const T30_OPT_IN_URL_PLACEHOLDER =
  "https://admin.bonbeauty.example/vendors/opt-in"

export function resolveFlagFlipDate(): { flagFlipDate: Date | null; iso: string } {
  const raw = process.env.GP_FLAG_FLIP_DATE
  if (!raw) return { flagFlipDate: null, iso: "" }
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return { flagFlipDate: null, iso: raw }
  return { flagFlipDate: d, iso: raw }
}

export function isWindowOpen(flagFlipDate: Date | null): boolean {
  if (!flagFlipDate) return false
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
  return Date.now() + thirtyDaysMs >= flagFlipDate.getTime()
}

/**
 * Checks whether the dispatcher is operating in fixture/stub mode.
 * Fixture mode = `GP_T30_DEV_FIXTURE_VENDORS_JSON` is set OR no real DB
 * vendor source is configured.
 *
 * Currently always true because real Mercur 2 vendor query is deferred to
 * v1.7.0+. The flag lets `triggerT30Kickoff` hard-block in production.
 */
export function isFixtureMode(): boolean {
  // When real vendor query is implemented this should return false.
  // For now: fixture mode is active unless explicitly overridden by test env.
  return !process.env.GP_T30_REAL_VENDOR_SOURCE_ENABLED
}

/**
 * Fetch eligible vendors.
 * Production: queries Mercur 2 vendor table (deferred to v1.7.0+).
 * Dev/test: reads `GP_T30_DEV_FIXTURE_VENDORS_JSON` or returns [].
 */
export async function fetchEligibleVendors(
  _vendor_ids?: string[],
): Promise<VendorRow[]> {
  const fixture = process.env.GP_T30_DEV_FIXTURE_VENDORS_JSON
  if (fixture) {
    try {
      return JSON.parse(fixture) as VendorRow[]
    } catch {
      return []
    }
  }
  return []
}

async function dispatchEmailStub(
  vendor: VendorRow,
  locale: T30EmailLocale,
  flagFlipIso: string,
  logger: T30Logger,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = {
    vendor_name: vendor.handle,
    flag_flip_date: flagFlipIso,
    opt_in_url: T30_OPT_IN_URL_PLACEHOLDER,
  }
  const subject = renderT30Subject(locale, ctx)
  const html = renderT30Html(locale, ctx)
  const text = renderT30Text(locale, ctx)

  // Real Medusa notification module dispatch deferred to Story 7.1 follow-up.
  // Dev no-op: log + breadcrumb so smoke testing exercises the audit log path.
  logger.info?.("[t30] would send notification", {
    vendor_id: vendor.id,
    locale,
    subject,
    html_length: html.length,
    text_length: text.length,
  })
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Main exported service function
// ---------------------------------------------------------------------------

/**
 * Execute T-30 notification dispatch in-process.
 *
 * Called from:
 *   1. `POST /admin/vendors/notifications/t30` (admin route) — existing path
 *   2. `triggerT30Kickoff()` (Story 8.2) — new path replacing env-var phantom
 *
 * Throws `T30DispatcherFixtureModeError` when `NODE_ENV === "production"` and
 * fixture mode is active (no real vendor data source).
 */
export async function dispatchT30Notifications(
  opts: T30DispatchOptions,
): Promise<T30DispatchResult> {
  const { triggered_by, vendor_ids, flag_flip_iso, logger = {} } = opts

  // AC3: hard-block in production when fixture mode active.
  if (process.env.NODE_ENV === "production" && isFixtureMode()) {
    throw new T30DispatcherFixtureModeError()
  }

  assertNotificationProviderReady()

  const eligible = await fetchEligibleVendors(vendor_ids)

  const auditLogIds: string[] = []
  const auditEntries: VendorNotificationLogEntry[] = []
  let triggered = 0
  const skipped = 0
  let failed = 0

  for (const vendor of eligible) {
    const locale: T30EmailLocale = vendor.preferred_locale ?? "pl"
    const dispatchResult = await dispatchEmailStub(
      vendor,
      locale,
      flag_flip_iso,
      logger,
    )
    const entry: VendorNotificationLogEntry = {
      id: randomUUID(),
      vendor_id: vendor.id,
      vendor_handle: vendor.handle,
      notification_type: "t30_migration",
      sent_at: new Date().toISOString(),
      locale,
      recipient_email: vendor.email,
      status: dispatchResult.ok ? "sent" : "failed",
      error_message: dispatchResult.error ?? null,
      triggered_by,
    }
    auditLogIds.push(entry.id)
    auditEntries.push(entry)
    if (dispatchResult.ok) {
      triggered += 1
    } else {
      failed += 1
    }
    logger.info?.("[t30] audit entry", entry as unknown as Record<string, unknown>)
  }

  return { triggered, skipped, failed, audit_log_ids: auditLogIds, audit_entries: auditEntries }
}
