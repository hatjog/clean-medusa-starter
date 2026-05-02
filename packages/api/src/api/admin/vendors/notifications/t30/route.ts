/**
 * Story v160-7-1: T-30 migration notification admin route.
 *
 * POST /admin/vendors/notifications/t30
 *   Body: { dry_run?: boolean, vendor_ids?: string[] }
 *   Response: { triggered, skipped, failed, audit_log_ids }
 *
 * GET /admin/vendors/notifications/t30/preview
 *   (in `preview/route.ts` sibling)
 *
 * Stub-tier impl per Sprint 4 Wave 13 batch:
 *   - Reads `GP_FLAG_FLIP_DATE` env var (ISO YYYY-MM-DD)
 *   - Returns deterministic dry-run payload + audit log skeleton
 *   - Real vendor list fetch + Medusa notification dispatch is
 *     authored as workflow stub (lib/vendor-notifications/) for
 *     Phase B activation gate; production wiring deferred to
 *     Story 7.1 follow-up.
 *
 * Per Story 7.1 Dev Note:
 *   "Email provider integration (SendGrid? SMTP?) MUST be configured
 *    w backend env. T1.4 audit confirms provider; if not configured,
 *    AC3 still authors workflow but actual dispatch w dev = no-op
 *    (logs "would send to <email>")."
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { randomUUID } from "node:crypto"

import {
  renderT30Html,
  renderT30Subject,
  renderT30Text,
  type VendorNotificationLogEntry,
  type T30EmailLocale,
} from "../../../../../modules/vendor-notifications"

type TriggerRequestBody = {
  dry_run?: boolean
  vendor_ids?: string[]
}

type Logger = {
  info?: (message: string, meta?: Record<string, unknown>) => void
  warn?: (message: string, meta?: Record<string, unknown>) => void
}

interface VendorRow {
  id: string
  handle: string
  email: string
  preferred_locale: T30EmailLocale | null
}

const T30_OPT_IN_URL_PLACEHOLDER = "https://admin.bonbeauty.example/vendors/opt-in"

function resolveFlagFlipDate(): { flagFlipDate: Date | null; iso: string } {
  const raw = process.env.GP_FLAG_FLIP_DATE
  if (!raw) return { flagFlipDate: null, iso: "" }
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return { flagFlipDate: null, iso: raw }
  return { flagFlipDate: d, iso: raw }
}

function isWindowOpen(flagFlipDate: Date | null): boolean {
  if (!flagFlipDate) return false
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
  return Date.now() + thirtyDaysMs >= flagFlipDate.getTime()
}

function extractActorId(req: MedusaRequest): string {
  const ctx = (req as { auth_context?: { actor_id?: string } }).auth_context
  return ctx?.actor_id ?? "unknown_admin"
}

/**
 * Stub vendor fetch — production swap-in queries Mercur 2 vendor table by
 * lifecycle_status='open'. Until Story 7.1 follow-up, returns an empty list
 * in dev when no env-fixture is provided. Tests may inject via
 * `process.env.GP_T30_DEV_FIXTURE_VENDORS_JSON`.
 */
async function fetchEligibleVendors(
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
  logger: Logger,
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

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = (req.body ?? {}) as TriggerRequestBody
  const dryRun = body.dry_run === true
  const triggeredBy = extractActorId(req)

  const logger =
    (req.scope.resolve(ContainerRegistrationKeys.LOGGER) as Logger | undefined) ??
    {}

  const { flagFlipDate, iso: flagFlipIso } = resolveFlagFlipDate()
  if (!flagFlipDate) {
    res.status(400).json({
      code: "FLAG_FLIP_DATE_NOT_CONFIGURED",
      message:
        "GP_FLAG_FLIP_DATE env var is not set or invalid (expected YYYY-MM-DD).",
    })
    return
  }
  if (!isWindowOpen(flagFlipDate)) {
    res.status(409).json({
      code: "WINDOW_NOT_OPEN",
      message: "T-30 window has not opened yet (flag_flip_date - 30 days > now).",
    })
    return
  }

  const eligible = await fetchEligibleVendors(body.vendor_ids)

  if (dryRun) {
    res.status(200).json({
      dry_run: true,
      eligible_count: eligible.length,
      vendors: eligible,
    })
    return
  }

  const auditLogIds: string[] = []
  let triggered = 0
  let skipped = 0
  let failed = 0

  for (const vendor of eligible) {
    const locale: T30EmailLocale = vendor.preferred_locale ?? "pl"
    const dispatchResult = await dispatchEmailStub(
      vendor,
      locale,
      flagFlipIso,
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
      triggered_by: triggeredBy,
    }
    auditLogIds.push(entry.id)
    if (dispatchResult.ok) {
      triggered += 1
    } else {
      failed += 1
    }
    // Persistence target: Path B GP-owned table (Story 7.1 Dev Note T3.4
    // decision deferred to follow-up). Stub log for now.
    logger.info?.("[t30] audit entry", entry as unknown as Record<string, unknown>)
  }

  res.status(200).json({
    triggered,
    skipped,
    failed,
    audit_log_ids: auditLogIds,
  })
}
