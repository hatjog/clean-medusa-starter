import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { extractActorIdOrThrow } from "../../../../../lib/capability-check"
import {
  EntitlementNotFoundError,
  LostCodeReissueWindowError,
  createReissueLostCodeWorkflowFromScope,
} from "../../../../../modules/voucher/workflows/reissue-lost-code"
import { EntitlementTransitionError } from "../../../../../modules/voucher/models/entitlement"

type ReissueBody = {
  reason?: unknown
  reason_code?: unknown
  idempotency_key?: unknown
}

function marketIdFromHeader(req: MedusaRequest): string | null {
  const header = req.headers["x-gp-market-id"]
  if (typeof header === "string" && header.trim()) return header.trim()
  if (Array.isArray(header) && header[0]?.trim()) return header[0].trim()
  return null
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

  const body = (req.body ?? {}) as ReissueBody
  const reason = typeof body.reason === "string" ? body.reason.trim() : ""
  if (!reason) {
    res.status(400).json({
      code: "REASON_REQUIRED",
      message: "reason is required for lost-code reissue audit",
    })
    return
  }

  const reasonCode =
    typeof body.reason_code === "string" && body.reason_code.trim()
      ? body.reason_code.trim()
      : undefined
  const idempotencyKey =
    typeof body.idempotency_key === "string" && body.idempotency_key.trim()
      ? body.idempotency_key.trim()
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

  let workflow
  try {
    workflow = createReissueLostCodeWorkflowFromScope(
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
    const result = await workflow.reissue({
      entitlement_id: entitlementId,
      reason,
      reason_code: reasonCode,
      admin_user_id: adminUserId,
      idempotency_key: idempotencyKey,
      market_id: marketIdFromHeader(req),
    })

    res.status(200).json({
      old_entitlement_id: result.old_entitlement_id,
      new_entitlement_id: result.new_entitlement_id,
      new_code: result.new_code,
    })
  } catch (err) {
    if (err instanceof EntitlementNotFoundError) {
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
    if (err instanceof LostCodeReissueWindowError) {
      res.status(422).json({
        code: "LOST_CODE_REISSUE_WINDOW_EXCEEDED",
        message: err.message,
      })
      return
    }
    res.status(500).json({
      code: "LOST_CODE_REISSUE_FAILED",
      message: err instanceof Error ? err.message : "Lost-code reissue failed",
    })
  }
}
