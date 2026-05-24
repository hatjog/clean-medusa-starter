import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { extractActorIdOrThrow } from "../../../../../lib/capability-check"
import { resolveAdminMarketContext } from "../../../../../lib/admin-market-context"
import {
  EntitlementTransitionError,
  RetentionAmountBoundaryError,
  RetentionEntitlementNotFoundError,
  createIssueRetentionWorkflowFromScope,
} from "../../../../../modules/voucher/workflows/issue-retention"

type IssueRetentionBody = {
  amount?: unknown
  reason?: unknown
  reason_code?: unknown
  retention_voucher_template_id?: unknown
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const entitlementId = (req.params as { id?: string })?.id
  if (!entitlementId) {
    res.status(400).json({
      code: "INVALID_INPUT",
      message: "entitlement id required",
    })
    return
  }

  const body = (req.body ?? {}) as IssueRetentionBody

  const amount =
    typeof body.amount === "number" && Number.isFinite(body.amount)
      ? body.amount
      : undefined
  if (amount === undefined || amount <= 0) {
    res.status(422).json({
      code: "RETENTION_AMOUNT_INVALID",
      message: "amount must be a finite number greater than 0",
    })
    return
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : ""
  if (!reason) {
    res.status(400).json({
      code: "REASON_REQUIRED",
      message: "reason is required for retention voucher audit",
    })
    return
  }

  const reasonCode =
    typeof body.reason_code === "string" && body.reason_code.trim()
      ? body.reason_code.trim()
      : undefined
  const retentionVoucherTemplateId =
    typeof body.retention_voucher_template_id === "string" &&
    body.retention_voucher_template_id.trim()
      ? body.retention_voucher_template_id.trim()
      : undefined

  let adminUserId: string
  try {
    adminUserId = extractActorIdOrThrow(req)
  } catch {
    res.status(401).json({
      code: "UNAUTHORIZED",
      message: "Valid admin session required",
    })
    return
  }

  // cc-4 F-03: bind market_id server-side via admin_market_grants check.
  const marketResult = await resolveAdminMarketContext(req)
  if (!marketResult.ok) {
    res.status(marketResult.status).json({
      code: marketResult.code,
      message: marketResult.message,
    })
    return
  }

  let workflow
  try {
    workflow = createIssueRetentionWorkflowFromScope(
      req.scope as { resolve: (key: string) => unknown }
    )
  } catch {
    res.status(500).json({
      code: "PG_POOL_UNAVAILABLE",
      message: "pg pool not registered",
    })
    return
  }

  try {
    const result = await workflow.issueRetention({
      entitlement_id: entitlementId,
      amount,
      reason,
      reason_code: reasonCode,
      retention_voucher_template_id: retentionVoucherTemplateId,
      admin_user_id: adminUserId,
      market_id: marketResult.market_id,
    })

    res.status(200).json({
      original_entitlement_id: result.original_entitlement_id,
      retention_entitlement_id: result.retention_entitlement_id,
      retention_code: result.retention_code,
      amount: result.amount,
    })
  } catch (err) {
    if (err instanceof RetentionEntitlementNotFoundError) {
      res.status(404).json({
        code: "ENTITLEMENT_NOT_FOUND",
        message: err.message,
      })
      return
    }
    if (err instanceof EntitlementTransitionError) {
      res.status(409).json({
        code: "INVALID_ENTITLEMENT_TRANSITION",
        message: err.message,
      })
      return
    }
    if (err instanceof RetentionAmountBoundaryError) {
      res.status(422).json({
        code: "RETENTION_AMOUNT_BOUNDARY_VIOLATION",
        message: err.message,
      })
      return
    }
    res.status(500).json({
      code: "RETENTION_ISSUE_FAILED",
      message: err instanceof Error ? err.message : "Retention issue failed",
    })
  }
}
