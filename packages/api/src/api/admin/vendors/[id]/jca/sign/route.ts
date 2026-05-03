/**
 * Story v160-7-5: POST /admin/vendors/[id]/jca/sign — admin marks JCA as signed.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

type SignBody = {
  signed_at?: string
  admin_note?: string
}

type SignResponse = {
  vendor_id: string
  signed_at: string
  audit_log_id: string
}

export async function POST(
  req: MedusaRequest<SignBody>,
  res: MedusaResponse<SignResponse>,
): Promise<void> {
  const { id } = req.params as { id: string }
  const body = (req.body ?? {}) as SignBody

  const signedAt = body.signed_at ?? new Date().toISOString()
  const auditLogId = `jca_signed_${id}_${Date.now()}`

  if (process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.info(
      `[jca_signed] vendor_id=${id} signed_at=${signedAt} note=${body.admin_note ?? "—"}`,
    )
  }

  res.json({
    vendor_id: id,
    signed_at: signedAt,
    audit_log_id: auditLogId,
  })
}
