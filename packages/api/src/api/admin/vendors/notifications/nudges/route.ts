/**
 * Story v160-7-2: Nudge cadence admin route — POST trigger.
 *
 * POST /admin/vendors/notifications/nudges
 *   Body: { step: 't21' | 't14' | 't7' | 't3'; dry_run?: boolean; vendor_ids?: string[] }
 *   Response: { step, triggered, skipped, failed, audit_log_ids }
 *
 * Stub-tier per Sprint 4 Wave 14 batch (matches Story 7.1 pattern):
 *   - Reads `GP_FLAG_FLIP_DATE` env var (ISO YYYY-MM-DD)
 *   - Returns deterministic dry-run payload + audit log skeleton
 *   - Real vendor list fetch + Medusa notification dispatch deferred to
 *     Phase B activation (workflow/cron infra).
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
import { extractActorIdOrThrow } from "../../../../../lib/capability-check"

type TriggerRequestBody = {
  step?: NudgeCadenceStep
  dry_run?: boolean
  vendor_ids?: string[]
  override?: boolean
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
 * by lifecycle_status='open' AND decision_status NOT IN ('opted_in','opted_out')
 * AND audit log dedup (no prior nudge_<step> entry). Until Phase B activation,
 * reads from `process.env.GP_NUDGE_DEV_FIXTURE_VENDORS_JSON` for tests.
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

  let triggeredBy: string
  try {
    triggeredBy = extractActorIdOrThrow(req)
  } catch {
    res.status(401).json({ code: "UNAUTHORIZED", message: "Valid admin session required" })
    return
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

  if (dryRun) {
    res.status(200).json({
      dry_run: true,
      step,
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
    if (
      vendor.decision_status === "opted_in" ||
      vendor.decision_status === "opted_out"
    ) {
      skipped += 1
      continue
    }
    const locale: NudgeCadenceLocale = vendor.preferred_locale ?? "pl"
    const result = await dispatchNudgeStub(
      vendor,
      step,
      locale,
      flagFlipIso,
      logger,
    )
    const id = randomUUID()
    auditLogIds.push(id)
    if (result.ok) {
      triggered += 1
    } else {
      failed += 1
    }
    logger.info?.("[nudge] audit entry", {
      id,
      vendor_id: vendor.id,
      vendor_handle: vendor.handle,
      notification_type: `nudge_${step}`,
      sent_at: new Date().toISOString(),
      locale,
      recipient_email: vendor.email,
      status: result.ok ? "sent" : "failed",
      triggered_by: triggeredBy,
    })
  }

  res.status(200).json({
    step,
    triggered,
    skipped,
    failed,
    audit_log_ids: auditLogIds,
  })
}
