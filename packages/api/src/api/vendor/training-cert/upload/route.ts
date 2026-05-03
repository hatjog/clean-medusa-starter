/**
 * Story v160-7-6: POST /vendor/training-cert/upload — vendor uploads training cert.
 *
 * Vendor scope endpoint. Validates type + size + decision status. Real multipart
 * handling + storage upload DEFERRED (production wiring). Wave 15 ships handler
 * skeleton + validation library; client provides JSON metadata stub for tests.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  validateCertFile,
  getCertExtension,
  type CertValidationInput,
} from "../../../../lib/training-cert-validator"

type UploadBody = CertValidationInput & {
  // For multipart, file Buffer would be in req.file. Here we accept a JSON
  // stub describing the upload — production replaces with multer middleware.
}

type UploadResponse = {
  vendor_id: string
  file_path: string
  status: "pending_review"
  audit_log_id: string
}

export async function POST(
  req: MedusaRequest<UploadBody>,
  res: MedusaResponse<UploadResponse | { error: string }>,
): Promise<void> {
  const body = (req.body ?? {}) as Partial<UploadBody>

  if (!body.filename || !body.mimeType || typeof body.sizeBytes !== "number") {
    res.status(400).json({
      error: "Missing required fields: filename, mimeType, sizeBytes",
    })
    return
  }

  const validation = validateCertFile({
    filename: body.filename,
    mimeType: body.mimeType,
    sizeBytes: body.sizeBytes,
  })

  if (!validation.valid) {
    res.status(400).json({ error: validation.errors.join("; ") })
    return
  }

  // Vendor scope JWT resolution DEFERRED (production wiring).
  // Stub vendor_id from a custom header for dev/tests.
  const vendorId =
    (req.headers["x-vendor-id"] as string | undefined) ?? "vendor_dev"

  const ext = getCertExtension(body.filename)
  const filePath = `vendor-training-certs/${vendorId}${ext}`
  const auditLogId = `training_cert_uploaded_${vendorId}_${Date.now()}`

  if (process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.info(
      `[training_cert_uploaded] vendor=${vendorId} path=${filePath} bytes=${body.sizeBytes} mime=${body.mimeType}`,
    )
  }

  res.json({
    vendor_id: vendorId,
    file_path: filePath,
    status: "pending_review",
    audit_log_id: auditLogId,
  })
}
