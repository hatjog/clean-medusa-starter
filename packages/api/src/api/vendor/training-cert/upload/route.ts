/**
 * Story v160-cleanup-39-magicbyte-validator: POST /vendor/training-cert/upload
 *
 * Closes TF-93 (magic-byte sniffing) + TF-109 (JWT-derived vendor scope).
 *
 * Guard chain (return-on-first-fail per AC4):
 *   1. withVendorAuth  — resolves vendor_id from x-vendor-token (401 on fail)
 *   2. Cross-vendor    — any client vendor identifier must match JWT vendor_id (403)
 *   3. Size guard      — buffer.byteLength > maxBytes → 413 (cheap check first, AC3)
 *   4. Magic-byte      — sniffMagicBytes null → 415 (AC2)
 *   5. Extension check — filename ext ↔ sniffedType mismatch → 415 (AC1 depth)
 *
 * Auth failures (401) do NOT write an audit row — no resolved vendor_id.
 * All other outcomes (200, 403, 413, 415) write an append-only audit row (AC6).
 *
 * Client-supplied Content-Type / mimeType is NEVER used for accept/reject (AC1).
 */

import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"

import { withVendorAuth, type VendorAuthContext } from "../../../../lib/vendor-auth"
import { sniffMagicBytes } from "../../../../lib/magic-byte-sniffer"
import { getMaxUploadBytes, EXTENSION_TYPE_MAP } from "../../../../lib/training-cert-upload-config"
import { validateCertBytes } from "../../../../lib/training-cert-validator"
import { appendNotificationLogBestEffort } from "../../../../lib/vendor-notification-log"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RequestWithVendorAuth = MedusaRequest & {
  vendorAuth?: VendorAuthContext
  file?: {
    buffer: Buffer
    originalname: string
    mimetype: string
    size: number
  }
}

type UploadSuccessResponse = {
  vendor_id: string
  file_path: string
  status: "pending_review"
  audit_log_id: string
}

type UploadErrorResponse = {
  error: string
  code: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractBuffer(req: RequestWithVendorAuth): {
  buffer: Buffer | null
  filename: string | null
  clientMimeType: string | null
} {
  if (req.file?.buffer) {
    return {
      buffer: req.file.buffer,
      filename: req.file.originalname ?? null,
      clientMimeType: req.file.mimetype ?? null,
    }
  }

  const body = (req.body ?? {}) as Record<string, unknown>
  const fileData = body.fileData as string | undefined
  const filename = body.filename as string | undefined
  const clientMimeType = body.mimeType as string | undefined

  if (!fileData || typeof fileData !== "string") {
    return { buffer: null, filename: filename ?? null, clientMimeType: clientMimeType ?? null }
  }

  try {
    const buf = Buffer.from(fileData, "base64")
    return { buffer: buf, filename: filename ?? "upload.bin", clientMimeType: clientMimeType ?? null }
  } catch {
    return { buffer: null, filename: filename ?? null, clientMimeType: clientMimeType ?? null }
  }
}

async function writeAuditLog(
  req: MedusaRequest,
  opts: {
    vendorId: string
    status: "sent" | "rejected"
    errorMessage: string | null
    clientMimeType: string | null
    filename: string | null
    sizeBytes: number
  },
): Promise<string> {
  const auditId = `training_cert_${opts.status}_${opts.vendorId}_${Date.now()}`

  await appendNotificationLogBestEffort(req.scope, {
    id: auditId,
    vendor_id: opts.vendorId,
    notification_type: "training_cert_uploaded",
    locale: "pl",
    recipient_email: "system",
    status: opts.status,
    error_message: opts.errorMessage,
    triggered_by: opts.vendorId,
    metadata: {
      filename: opts.filename,
      size_bytes: opts.sizeBytes,
      client_mime_type: opts.clientMimeType,
    },
  })

  return auditId
}

// ---------------------------------------------------------------------------
// Route handler (wrapped via withVendorAuth)
// ---------------------------------------------------------------------------

async function uploadHandler(
  req: RequestWithVendorAuth,
  res: MedusaResponse<UploadSuccessResponse | UploadErrorResponse>,
  _next: MedusaNextFunction,
): Promise<void> {
  const vendorId = req.vendorAuth!.vendor_id

  // Guard 2: Cross-vendor scope check
  const body = (req.body ?? {}) as Record<string, unknown>
  const bodyVendorId = body.vendor_id as string | undefined
  if (bodyVendorId !== undefined && bodyVendorId !== vendorId) {
    await writeAuditLog(req, {
      vendorId,
      status: "rejected",
      errorMessage: "cross_vendor_scope_mismatch",
      clientMimeType: (body.mimeType as string | undefined) ?? null,
      filename: (body.filename as string | undefined) ?? null,
      sizeBytes: 0,
    })
    res.status(403).json({
      error: "Vendor scope mismatch",
      code: "cross_vendor_scope_mismatch",
    })
    return
  }

  // Extract file buffer
  const { buffer, filename, clientMimeType } = extractBuffer(req)

  if (!buffer || buffer.length === 0) {
    res.status(400).json({
      error: "No file data received. Send multipart/form-data or base64 fileData field.",
      code: "missing_file",
    })
    return
  }

  if (!filename) {
    res.status(400).json({
      error: "filename is required",
      code: "missing_filename",
    })
    return
  }

  const sizeBytes = buffer.byteLength

  // Guard 3: Size guard before sniff (cheap first, AC3)
  const maxBytes = getMaxUploadBytes()
  if (sizeBytes > maxBytes) {
    await writeAuditLog(req, {
      vendorId,
      status: "rejected",
      errorMessage: "size_exceeded",
      clientMimeType,
      filename,
      sizeBytes,
    })
    res.status(413).json({
      error: `File too large (${sizeBytes} bytes, max ${maxBytes})`,
      code: "size_exceeded",
    })
    return
  }

  // Guard 4+5: Magic-byte sniff + extension check (AC1, AC2)
  const sniffedType = sniffMagicBytes(buffer)
  const validation = validateCertBytes({ filename, sizeBytes, sniffedType }, maxBytes)

  if (!validation.valid) {
    await writeAuditLog(req, {
      vendorId,
      status: "rejected",
      errorMessage: validation.errorCode ?? "validation_error",
      clientMimeType,
      filename,
      sizeBytes,
    })

    const httpStatus = validation.errorCode === "size_exceeded" ? 413 : 415
    res.status(httpStatus).json({
      error:
        validation.errorCode === "size_exceeded"
          ? `File too large (${sizeBytes} bytes, max ${maxBytes})`
          : validation.errorCode === "magic_byte_mismatch"
          ? "Unsupported file type (magic-byte mismatch)"
          : "File extension does not match file content",
      code: validation.errorCode ?? "validation_error",
    })
    return
  }

  // Success
  const extEntry = Object.entries(EXTENSION_TYPE_MAP).find(
    ([, type]) => type === sniffedType,
  )
  const ext = extEntry ? extEntry[0] : ".bin"
  const filePath = `vendor-training-certs/${vendorId}/${Date.now()}${ext}`

  const auditLogId = await writeAuditLog(req, {
    vendorId,
    status: "sent",
    errorMessage: null,
    clientMimeType,
    filename,
    sizeBytes,
  })

  res.json({
    vendor_id: vendorId,
    file_path: filePath,
    status: "pending_review",
    audit_log_id: auditLogId,
  })
}

// Export the POST handler wrapped in withVendorAuth.
// withVendorAuth handles 401 for missing / invalid tokens.
export const POST = withVendorAuth(uploadHandler)
