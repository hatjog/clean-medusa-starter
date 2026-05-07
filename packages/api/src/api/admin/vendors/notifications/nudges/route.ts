/**
 * Story v160-7-2: Nudge cadence admin route — POST trigger.
 * Story v160-cleanup-40-nudge-dedup: Dedup gate before dispatch (TF-94 P0).
 *
 * POST /admin/vendors/notifications/nudges
 *   Body: { step, dry_run?, vendor_ids?, override?, force? }
 *   Response: { step, triggered, skipped, deduplicated, forced, failed, audit_log_ids, deduplicated_entries }
 *
 * Dedup logic (AC1-AC7):
 *   1. After assertNotificationProviderReady(), BEFORE dispatch loop,
 *      call assertNotificationLogTableReady() — 503 NUDGE_DEDUP_UNAVAILABLE on fail.
 *   2. Per vendor: query findRecentNotificationLog(vendor_id, "nudge_<step>", since=now-cooldown).
 *   3. If prior 'sent' row found AND force !== true: skip dispatch, append 'deduplicated' row.
 *   4. If force === true AND prior row: dispatch anyway, audit row has forced=true + metadata.forced_by.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { randomUUID } from "node:crypto"

import {
  NUDGE_CADENCE_DAYS,
  renderNudgeCadenceHtml,
  renderNudgeCadenceSubject,
  renderNudgeCadenceText,
  type NudgeCadenceLocale,
  type NudgeCadenceStep,
} from "../../../../../modules/vendor-notifications/email-templates/nudge-cadence/i18n"
import { extractActorIdOrThrow, checkCapability } from "../../../../../lib/capability-check"
import {
  assertNotificationProviderReady,
  NotificationProviderNotReadyError,
} from "../../../../../lib/vendor-notification-provider-readiness"
import {
  appendNotificationLogBestEffort,
  assertNotificationLogTableReady,
  findRecentNotificationLog,
  resolveNudgeCooldownHours,
  NotificationLogTableUnavailableError,
} from "../../../../../lib/vendor-notification-log"
import type { VendorNotificationLogEntry } from "../../../../../modules/vendor-notifications"

type TriggerRequestBody = {
  step?: NudgeCadenceStep
  dry_run?: boolean
  vendor_ids?: string[]
  override?: boolean
  /** force=true bypasses cooldown dedup gate — operator escape hatch (AC4) */
  force?: boolean
}

type Logger = {
  info?: (message: string, meta?: Record<string, unknown>) => void
  warn?: (message: string, meta?: Record<string, unknown>) => void
}

interface NudgeEligibleVendor {
  id: string
  handle: string
  email: string
  preferred_locale: NudgeCadenceLocale | null
  decision_status: "open" | "opted_in" | "opted_out"
}

type DedupEntry = {
  vendor_id: string
  existing_log_id: string
  reason: "deduplicated"
}

const VALID_STEPS: ReadonlySet<NudgeCadenceStep> = new Set([
  "t21",
  "t14",
  "t7",
  "t3",
])
const NUDGE_OPT_IN_URL_PLACEHOLDER =
  "https://admin.bonbeauty.example/vendors/opt-in"

function resolveFlagFlipDate(): { iso: string | null } {
  const raw = process.env.GP_FLAG_FLIP_DATE
  if (!raw) return { iso: null }
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return { iso: null }
  return { iso: raw }
}

/**
 * Stub eligible-vendor fetcher — production swap-in queries Mercur 2 vendors
 * by lifecycle_status='open' AND decision_status NOT IN ('opted_in','opted_out').
 * Until Phase B activation, reads from GP_NUDGE_DEV_FIXTURE_VENDORS_JSON for tests.
 */
async function fetchEligibleVendors(
  _step: NudgeCadenceStep,
  _vendor_ids?: string[],
): Promise<NudgeEligibleVendor[]> {
  const fixture = process.env.GP_NUDGE_DEV_FIXTURE_VENDORS_JSON
  if (fixture) {
    try {
      return JSON.parse(fixture) as NudgeEligibleVendor[]
    } catch {
      return []
    }
  }
  return []
}

async function dispatchNudgeStub(
  vendor: NudgeEligibleVendor,
  step: NudgeCadenceStep,
  locale: NudgeCadenceLocale,
  flagFlipIso: string,
  logger: Logger,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = {
    vendor_name: vendor.handle,
    flag_flip_date: flagFlipIso,
    days_remaining: String(NUDGE_CADENCE_DAYS[step]),
    opt_in_url: NUDGE_OPT_IN_URL_PLACEHOLDER,
  }
  const subject = renderNudgeCadenceSubject(step, locale, ctx)
  const text = renderNudgeCadenceText(step, locale, ctx)
  const html = renderNudgeCadenceHtml(step, locale, ctx)
  logger.info?.("[nudge] would send notification", {
    vendor_id: vendor.id,
    step,
    locale,
    subject,
    text_length: text.length,
    html_length: html.length,
  })
  return { ok: true }
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = (req.body ?? {}) as TriggerRequestBody
  const step = body.step
  const dryRun = body.dry_run === true
  const force = body.force === true

  let triggeredBy: string
  try {
    triggeredBy = extractActorIdOrThrow(req)
  } catch {
    res.status(401).json({ code: "UNAUTHORIZED", message: "Valid admin session required" })
    return
  }

  // Review F1: force=true is a vendor-impacting capability (bypasses TF-94 P0
  // dedup gate). Require explicit capability grant — currently `lifecycle.override`
  // (v1.6.0: any admin user → granted; v1.7.0 will switch to capability_grants
  // table per capability-check.ts JSDoc). Authorization decision is logged to
  // the audit row via `triggered_by` + `forced=true` flag.
  if (body.force === true) {
    const allowed = await checkCapability(req, "lifecycle.override")
    if (!allowed) {
      res.status(403).json({
        code: "NUDGE_FORCE_NOT_PERMITTED",
        message:
          "force=true requires the lifecycle.override capability. Re-issue without force, or escalate to an authorized operator.",
      })
      return
    }
  }

  if (!step || !VALID_STEPS.has(step)) {
    res.status(400).json({
      code: "INVALID_STEP",
      message: "Body.step must be one of: t21, t14, t7, t3.",
    })
    return
  }

  const logger =
    (req.scope.resolve(ContainerRegistrationKeys.LOGGER) as Logger | undefined) ??
    {}
  const { iso: flagFlipIso } = resolveFlagFlipDate()
  if (!flagFlipIso) {
    res.status(400).json({
      code: "FLAG_FLIP_DATE_NOT_CONFIGURED",
      message: "GP_FLAG_FLIP_DATE env var is not set or invalid (YYYY-MM-DD).",
    })
    return
  }

  const eligible = await fetchEligibleVendors(step, body.vendor_ids)

  // Dry-run exits early — no dedup checks, no audit rows (AC5.d backward compat)
  if (dryRun) {
    res.status(200).json({
      dry_run: true,
      step,
      eligible_count: eligible.length,
      vendors: eligible,
    })
    return
  }

  // Provider readiness check (AC from cleanup-6e)
  try {
    assertNotificationProviderReady()
  } catch (err) {
    if (err instanceof NotificationProviderNotReadyError) {
      res.status(503).json({
        code: err.code,
        message: err.message,
      })
      return
    }
    throw err
  }

  // Fail-closed dedup infra check (AC7) — BEFORE dispatch loop
  const scope = req.scope as { resolve: (key: string) => unknown }
  try {
    await assertNotificationLogTableReady(scope)
  } catch (err) {
    if (err instanceof NotificationLogTableUnavailableError) {
      res.status(503).json({
        code: err.code,
        message: err.message,
      })
      return
    }
    throw err
  }

  const auditLogIds: string[] = []
  const dedupEntries: DedupEntry[] = []
  let triggered = 0
  let skipped = 0
  let failed = 0
  let deduplicated = 0
  let forcedCount = 0

  const cooldownHours = resolveNudgeCooldownHours(step)
  const notificationType =
    `nudge_${step}` as VendorNotificationLogEntry["notification_type"]

  for (const vendor of eligible) {
    if (
      vendor.decision_status === "opted_in" ||
      vendor.decision_status === "opted_out"
    ) {
      skipped += 1
      continue
    }

    // Dedup gate — AC1: query recent 'sent' rows inside cooldown window
    const since = new Date(Date.now() - cooldownHours * 60 * 60 * 1000)
    const recentRows = await findRecentNotificationLog(scope, {
      vendor_id: vendor.id,
      notification_type: notificationType,
      since_iso: since.toISOString(),
    })

    const priorSentRow = recentRows[0] // most recent first (ORDER BY sent_at DESC)

    if (priorSentRow && !force) {
      // AC2 — deduplicate: append audit row, do NOT dispatch.
      // Review F4: dedup audit row MUST be durable. Unlike the dispatch
      // path (where best-effort is acceptable because the email already
      // landed), losing the dedup row means losing the only evidence
      // that TF-94 P0 protection fired. If persistence fails, hard-throw
      // → global handler returns 500 and the suppression is NOT silently
      // recorded as success.
      const dedupId = randomUUID()
      const dedupPersisted = await appendNotificationLogBestEffort(scope, {
        id: dedupId,
        vendor_id: vendor.id,
        vendor_handle: vendor.handle ?? null,
        notification_type: notificationType,
        sent_at: new Date().toISOString(),
        locale: vendor.preferred_locale ?? "pl",
        recipient_email: vendor.email,
        status: "deduplicated",
        triggered_by: triggeredBy,
        metadata: { dedup_of: priorSentRow.id },
      })
      if (!dedupPersisted.persisted) {
        logger.warn?.("[nudge] dedup audit persist FAILED — refusing to silently suppress", {
          vendor_id: vendor.id,
          step,
          dedup_id: dedupId,
          error: dedupPersisted.error,
        })
        throw new Error(
          `dedup audit row failed to persist for vendor=${vendor.id} step=${step}: ${dedupPersisted.error ?? "unknown error"}`,
        )
      }
      auditLogIds.push(dedupPersisted.entry.id)
      dedupEntries.push({
        vendor_id: vendor.id,
        existing_log_id: priorSentRow.id,
        reason: "deduplicated",
      })
      deduplicated += 1
      logger.info?.("[nudge] deduplicated — prior sent row within cooldown", {
        vendor_id: vendor.id,
        step,
        existing_log_id: priorSentRow.id,
        cooldown_hours: cooldownHours,
      })
      continue
    }

    // Dispatch (either no prior row, or force=true bypass)
    const locale: NudgeCadenceLocale = vendor.preferred_locale ?? "pl"
    const result = await dispatchNudgeStub(
      vendor,
      step,
      locale,
      flagFlipIso,
      logger,
    )
    const id = randomUUID()
    if (result.ok) {
      triggered += 1
    } else {
      failed += 1
    }

    // AC4 — forced bypass: record bypass evidence in audit row.
    // Review F5: drop metadata.forced_by — `triggered_by` is the canonical
    // actor column; duplicating it in JSONB invites schema drift.
    // Review F6: when body.force === true but no prior row exists, the
    // operator's INTENT to force is captured via metadata.force_requested
    // (audit-friendly), while the row-level `forced` column remains the
    // strict "an actual bypass occurred" signal.
    const isForced = priorSentRow !== undefined && force
    const metadataParts: Record<string, unknown> = {}
    if (isForced) metadataParts.forced = true
    if (force) metadataParts.force_requested = true
    const metadata: Record<string, unknown> | undefined =
      Object.keys(metadataParts).length > 0 ? metadataParts : undefined

    if (isForced) {
      forcedCount += 1
    }

    const persisted = await appendNotificationLogBestEffort(scope, {
      id,
      vendor_id: vendor.id,
      vendor_handle: vendor.handle ?? null,
      notification_type: notificationType,
      sent_at: new Date().toISOString(),
      locale,
      recipient_email: vendor.email,
      status: result.ok ? "sent" : "failed",
      triggered_by: triggeredBy,
      forced: isForced,
      metadata,
    })
    auditLogIds.push(persisted.entry.id)
    logger.info?.(
      `[nudge] audit entry${persisted.persisted ? "" : " (in-memory)"}`,
      persisted.entry as unknown as Record<string, unknown>,
    )
    if (!persisted.persisted) {
      logger.warn?.("[nudge] audit persist failed", {
        error: persisted.error,
        audit_id: id,
      })
    }
  }

  res.status(200).json({
    step,
    triggered,
    skipped,
    deduplicated,
    forced: forcedCount,
    failed,
    audit_log_ids: auditLogIds,
    deduplicated_entries: dedupEntries,
  })
}
