/**
 * GET /vendor/competitive-insights — JWT-derived vendor scope.
 *
 * Story v160-cleanup-38-jwt-vendor-scope (TF-92, TF-103, TF-110):
 *
 *   AC1  — withVendorAuth HOF wraps handler; token required, no fallback.
 *   AC2  — x-vendor-id header COMPLETELY IGNORED; vendor scope comes from
 *          req.vendorAuth.vendor_id (JWT-derived via resolveVendorId).
 *   AC3  — cross-vendor scope guard: if caller passes vendor_id in body/query
 *          that differs from authenticated vendor_id → 403 immediately.
 *   AC4  — real Mercur 2 query via resolveInsightSnapshots (Knex loader);
 *          no dev-fixture path in this handler.
 *   AC5  — 401 outcomes are NOT written to audit log (withVendorAuth handles
 *          these before the handler is invoked).
 *   AC6  — every successful query and every 403 rejection writes a row to
 *          vendor_notification_log with notification_type='competitive_insights_query'.
 *
 * References:
 *   - ADR-025: "vendor" in GP core; "seller" only in Mercur auth context
 *   - ADR-034: Federated sessions; HMAC backend-to-backend
 *   - cleanup-39/48: withVendorAuth HOF (x-vendor-token / HMAC validation)
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import {
  getCompetitiveInsights,
  type CompetitiveInsightsData,
} from "../../../lib/competitive-insights-aggregator"
import { resolveInsightSnapshots } from "../../../lib/competitive-insights-source"
import { withVendorAuth } from "../../../lib/vendor-auth"
import type { VendorAuthContext } from "../../../lib/vendor-auth"
import { appendNotificationLog } from "../../../lib/vendor-notification-log"

type RequestWithVendorAuth = MedusaRequest & {
  vendorAuth?: VendorAuthContext
}

type CompetitiveInsightsResponse = CompetitiveInsightsData & {
  data_source: "mercur_query" | "empty"
}

/**
 * GET handler — must be exported as a named `GET` constant (not a function declaration)
 * so Medusa's file-based router picks it up correctly.
 */
export const GET = withVendorAuth(async (
  req: RequestWithVendorAuth,
  res: MedusaResponse<CompetitiveInsightsResponse>,
): Promise<void> => {
  // vendorAuth is guaranteed to be present here — withVendorAuth returns 401 otherwise.
  const { vendor_id: vendorId, seller_id: sellerId } = req.vendorAuth!

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
    } as unknown as CompetitiveInsightsResponse)
    return
  }

  // AC4 — real Mercur 2 query via Knex loader.
  let result: Awaited<ReturnType<typeof resolveInsightSnapshots>>
  try {
    result = await resolveInsightSnapshots(req.scope, [sellerId])
  } catch (err) {
    // DB failure → 503; do NOT write an audit row (no vendor data accessed)
    const logger = req.scope?.resolve("logger") as
      | { error?: (m: string) => void }
      | undefined
    logger?.error?.(
      `[competitive-insights] resolveInsightSnapshots failed: ${String(err)}`,
    )
    res.status(503).json({
      code: "insights_source_unavailable",
      message: "Competitive insights data temporarily unavailable",
    } as unknown as CompetitiveInsightsResponse)
    return
  }

  const { snapshots, data_source: dataSource } = result

  // AC3 continued — aggregator computes per-vendor metrics; privacy-preserving
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
})
