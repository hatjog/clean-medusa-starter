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
 * Dispatch logic extracted to `src/lib/t30-dispatch-service.ts` (cleanup-5)
 * so `triggerT30Kickoff()` (Story 8.2) calls the REAL dispatcher in-process
 * instead of reading phantom `GP_KICKOFF_VENDOR_COUNT` env var.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  dispatchT30Notifications,
  fetchEligibleVendors,
  isWindowOpen,
  NotificationProviderNotReadyError,
  resolveFlagFlipDate,
  T30DispatcherFixtureModeError,
  type T30Logger,
} from "../../../../../lib/t30-dispatch-service"
import { extractActorIdOrThrow } from "../../../../../lib/capability-check"

type TriggerRequestBody = {
  dry_run?: boolean
  vendor_ids?: string[]
  override?: boolean
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = (req.body ?? {}) as TriggerRequestBody
  const dryRun = body.dry_run === true

  let triggeredBy: string
  try {
    triggeredBy = extractActorIdOrThrow(req)
  } catch {
    res.status(401).json({ code: "UNAUTHORIZED", message: "Valid admin session required" })
    return
  }

  const logger =
    (req.scope.resolve(ContainerRegistrationKeys.LOGGER) as T30Logger | undefined) ??
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

  if (dryRun) {
    const eligible = await fetchEligibleVendors(body.vendor_ids)
    res.status(200).json({
      dry_run: true,
      eligible_count: eligible.length,
      vendors: eligible,
    })
    return
  }

  try {
    const result = await dispatchT30Notifications({
      triggered_by: triggeredBy,
      vendor_ids: body.vendor_ids,
      flag_flip_iso: flagFlipIso,
      logger,
      scope: req.scope as { resolve: (key: string) => unknown },
    })
    res.status(200).json({
      triggered: result.triggered,
      skipped: result.skipped,
      failed: result.failed,
      audit_log_ids: result.audit_log_ids,
    })
  } catch (err) {
    if (
      err instanceof T30DispatcherFixtureModeError ||
      err instanceof NotificationProviderNotReadyError
    ) {
      res.status(503).json({
        code: err.code,
        message: err.message,
      })
      return
    }
    throw err
  }
}
