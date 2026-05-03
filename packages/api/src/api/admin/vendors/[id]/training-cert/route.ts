/**
 * Story v160-7-6: POST /admin/vendors/[id]/training-cert — admin approves/rejects cert.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

type ReviewBody = {
  decision: "approve" | "reject"
  admin_note?: string
  rejection_reason?: string
}

type ReviewResponse = {
  vendor_id: string
  decision: "approved" | "rejected"
  audit_log_id: string
}

export async function POST(
  req: MedusaRequest<ReviewBody>,
  res: MedusaResponse<ReviewResponse | { error: string }>,
): Promise<void> {
  const { id } = req.params as { id: string }
  const body = (req.body ?? {}) as Partial<ReviewBody>

  if (body.decision !== "approve" && body.decision !== "reject") {
    res.status(400).json({
      error: "decision must be 'approve' or 'reject'",
    })
    return
  }

  if (
    body.decision === "reject" &&
    (!body.rejection_reason || body.rejection_reason.trim().length < 20)
  ) {
    res.status(400).json({
      error: "rejection_reason is required and must be ≥ 20 characters",
    })
    return
  }

  const finalDecision: "approved" | "rejected" =
    body.decision === "approve" ? "approved" : "rejected"
  const auditLogId = `training_cert_${finalDecision}_${id}_${Date.now()}`

  if (process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.info(
      `[training_cert_${finalDecision}] vendor=${id} note=${body.admin_note ?? "—"} reason=${body.rejection_reason ?? "—"}`,
    )
  }

  res.json({
    vendor_id: id,
    decision: finalDecision,
    audit_log_id: auditLogId,
  })
}
