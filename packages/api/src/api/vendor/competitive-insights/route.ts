/**
 * GET /vendor/competitive-insights — Mercur seller-context vendor scope.
 *
 * Story v160-cleanup-38-jwt-vendor-scope (TF-92, TF-103, TF-110):
 *
 *   AC1  — JWT bearer route; Mercur ensureSellerMiddleware provides seller context.
 *   AC2  — x-vendor-id header COMPLETELY IGNORED; vendor scope comes from
 *          req.seller_context.seller_id resolved through gp_core.resolveVendorId.
 *   AC3  — cross-vendor scope guard: if caller passes vendor_id in body/query
 *          that differs from authenticated vendor_id → 403 immediately.
 *   AC4  — real Mercur 2 query via resolveInsightSnapshots (Knex loader);
 *          no dev-fixture path in this handler.
 *   AC5  — 401 outcomes are NOT written to audit log.
 *   AC6  — every successful query and every 403 rejection writes a row to
 *          vendor_notification_log with notification_type='competitive_insights_query'.
 *
 * References:
 *   - ADR-025: "vendor" in GP core; "seller" only in Mercur auth context
 *   - ADR-109a V3 / Story 6.2: browser-context vendor widget uses JWT bearer only.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import {
  getCompetitiveInsights,
  type CompetitiveInsightsData,
} from "../../../lib/competitive-insights-aggregator"
import { resolveInsightSnapshots } from "../../../lib/competitive-insights-source"
import { NotImplementedError } from "../../../modules/gp-core/service"
import { appendNotificationLog } from "../../../lib/vendor-notification-log"

type RequestWithSellerContext = MedusaRequest & {
  seller_context?: {
    seller_id?: string
  }
}

type GpCoreServiceLike = {
  resolveVendorId: (sellerId: string) => Promise<string>
}

type LoggerLike = {
  warn?: (message: string) => void
  error?: (message: string) => void
}

type CompetitiveInsightsResponse = CompetitiveInsightsData & {
  data_source: "mercur_query" | "empty"
}

// Error shape for non-200 responses (403, 503) — separate from the success type.
type ErrorResponse = {
  code: string
  message: string
}

function resolveLogger(scope: MedusaRequest["scope"] | undefined): LoggerLike {
  if (!scope) return console

  try {
    return (scope.resolve("logger") as LoggerLike | undefined) ?? console
  } catch {
    return console
  }
}

function resolveGpCore(scope: MedusaRequest["scope"] | undefined): GpCoreServiceLike | null {
  if (!scope) return null

  try {
    return scope.resolve("gp_core") as GpCoreServiceLike | null
  } catch {
    return null
  }
}

/**
 * GET handler — must be exported as a named `GET` constant (not a function declaration)
 * so Medusa's file-based router picks it up correctly.
 */
export const GET = async (
  req: RequestWithSellerContext,
  res: MedusaResponse<CompetitiveInsightsResponse>,
): Promise<void> => {
  const sellerId = req.seller_context?.seller_id
  if (!sellerId) {
    res.status(401).json({
      code: "UNAUTHORIZED",
      message: "Seller context not present",
    } as unknown as ErrorResponse & CompetitiveInsightsResponse)
    return
  }

  const logger = resolveLogger(req.scope)
  const gpCore = resolveGpCore(req.scope)
  if (!gpCore) {
    logger.warn?.("[competitive-insights] gp_core service not available")
    res.status(503).json({
      code: "vendor_auth_service_unavailable",
      message: "Vendor authentication service unavailable",
    } as unknown as ErrorResponse & CompetitiveInsightsResponse)
    return
  }

  let vendorId: string
  try {
    vendorId = await gpCore.resolveVendorId(sellerId)
  } catch (error) {
    if (error instanceof NotImplementedError) {
      logger.warn?.(`[competitive-insights] resolveVendorId stub: ${error.message}`)
      res.status(501).json({
        code: "vendor_id_resolution_not_implemented",
        message: "Vendor ID resolution not yet implemented",
      } as unknown as ErrorResponse & CompetitiveInsightsResponse)
      return
    }

    logger.error?.(`[competitive-insights] resolveVendorId failed: ${String(error)}`)
    res.status(500).json({
      code: "vendor_auth_failed",
      message: "Vendor authentication failed",
    } as unknown as ErrorResponse & CompetitiveInsightsResponse)
    return
  }

  // AC3 — cross-vendor scope guard.
  // If the caller supplied a vendor_id in the body or query string that differs
  // from their authenticated vendor_id, reject immediately.
  // NOTE: x-vendor-id header is NOT read at all (AC2 — ignored).
  const requestedVendorId =
    (req.body as Record<string, unknown> | undefined)?.["vendor_id"] as string | undefined ??
    (req.query["vendor_id"] as string | undefined)

  if (requestedVendorId !== undefined && requestedVendorId !== vendorId) {
    // Write rejected audit row before returning 403
    await appendNotificationLog(req.scope, {
      vendor_id: vendorId,
      notification_type: "competitive_insights_query",
      locale: "pl",
      recipient_email: "system",
      status: "rejected",
      error_message: "cross_vendor_scope_mismatch",
      triggered_by: vendorId,
      metadata: { requested_vendor_id: requestedVendorId },
    }).catch(() => {
      // Best-effort: audit failure must not block the 403 response.
    })

    res.status(403).json({
      code: "cross_vendor_scope_mismatch",
      message: "Requested vendor_id does not match authenticated vendor",
    } as unknown as ErrorResponse & CompetitiveInsightsResponse)
    return
  }

  // AC4 — real Mercur 2 query via Knex loader.
  let result: Awaited<ReturnType<typeof resolveInsightSnapshots>>
  try {
    result = await resolveInsightSnapshots(req.scope, [sellerId])
  } catch (err) {
    // DB failure → 503; do NOT write an audit row (no vendor data accessed)
    const logger = req.scope.resolve("logger") as
      | { error?: (m: string) => void }
      | undefined
    logger?.error?.(
      `[competitive-insights] resolveInsightSnapshots failed: ${String(err)}`,
    )
    res.status(503).json({
      code: "insights_source_unavailable",
      message: "Competitive insights data temporarily unavailable",
    } as unknown as ErrorResponse & CompetitiveInsightsResponse)
    return
  }

  const { snapshots, data_source: dataSource } = result

  // AC4 continued — aggregator computes per-vendor metrics; privacy-preserving
  // (aggregates only, no individual competitor prices in the response).
  const insightsData = getCompetitiveInsights(vendorId, snapshots)

  // AC6 — write success audit row.
  await appendNotificationLog(req.scope, {
    vendor_id: vendorId,
    notification_type: "competitive_insights_query",
    locale: "pl",
    recipient_email: "system",
    status: "sent",
    triggered_by: vendorId,
    metadata: {
      category_count: insightsData.categories.length,
      data_source: dataSource,
    },
  }).catch(() => {
    // Best-effort: audit failure must not block the 200 response.
  })

  res.json({ ...insightsData, data_source: dataSource })
}
