/**
 * Story v160-8-2: GET /admin/operator/consents — live consent status report.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { extractActorIdOrThrow } from "../../../../lib/capability-check"
import {
  buildOperatorConsentReport,
  type OperatorConsentDecisionStatus,
} from "../../../../lib/operator-consent-report"

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  try {
    extractActorIdOrThrow(req)
  } catch {
    res.status(401).json({
      code: "UNAUTHORIZED",
      message: "Valid admin session required",
    })
    return
  }

  const { decision, search, sort, page, limit } = req.query as {
    decision?: OperatorConsentDecisionStatus
    search?: string
    sort?: string
    page?: string
    limit?: string
  }

  const report = await buildOperatorConsentReport(
    req.scope as { resolve: (key: string) => unknown },
    { decision, search, sort, page, limit },
  )

  res.setHeader("Cache-Control", "private, max-age=30")
  res.json(report)
}
