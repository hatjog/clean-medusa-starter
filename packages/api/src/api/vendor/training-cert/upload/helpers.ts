import { randomUUID } from "node:crypto"

import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { withVendorAuth, type VendorAuthContext } from "../../../../lib/vendor-auth"
import { sniffMagicBytes } from "../../../../lib/magic-byte-sniffer"
import { getMaxUploadBytes } from "../../../../lib/training-cert-upload-config"
import {
  validateCertBytes,
  ALLOWED_CERT_EXTENSIONS,
} from "../../../../lib/training-cert-validator"
import {
  appendNotificationLog,
  appendNotificationLogBestEffort,
} from "../../../../lib/vendor-notification-log"

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

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

type ExtractResult =
  | {
      buffer: Buffer
      filename: string | null
      clientMimeType: string | null
      error?: undefined
    }
  | {
      buffer: null
      filename: string | null
      clientMimeType: string | null
      error: "missing_file" | "invalid_base64"
    }

function extractBuffer(req: RequestWithVendorAuth): ExtractResult {
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
    return {
      buffer: null,
      filename: filename ?? null,
      clientMimeType: clientMimeType ?? null,
      error: "missing_file",
    }
  }

  const stripped = fileData.replace(/\s+/g, "")
  if (
    stripped.length === 0 ||
    !BASE64_RE.test(stripped) ||
    stripped.length % 4 !== 0
  ) {
    return {
      buffer: null,
      filename: filename ?? null,
      clientMimeType: clientMimeType ?? null,
      error: "invalid_base64",
    }
  }

  try {
    const buf = Buffer.from(stripped, "base64")
    if (buf.length === 0) {
      return {
        buffer: null,
        filename: filename ?? null,
        clientMimeType: clientMimeType ?? null,
        error: "missing_file",
      }
    }
    return {
      buffer: buf,
      filename: filename ?? "upload.bin",
      clientMimeType: clientMimeType ?? null,
    }
  } catch {
    return {
      buffer: null,
      filename: filename ?? null,
      clientMimeType: clientMimeType ?? null,
      error: "invalid_base64",
    }
  }
}

function extractAllowedExtension(filename: string): string | null {
  const lower = filename.toLowerCase()
  const sorted = [...ALLOWED_CERT_EXTENSIONS].sort((a, b) => b.length - a.length)
  for (const ext of sorted) {
    if (lower.endsWith(ext)) return ext
  }
  return null
}

type AuditPayload = {
  vendorId: string
  status: "sent" | "rejected"
  errorMessage: string | null
  clientMimeType: string | null
  filename: string | null
  sizeBytes: number
}

function buildAuditInput(opts: AuditPayload, auditId: string) {
  return {
    id: auditId,
    vendor_id: opts.vendorId,
    notification_type: "training_cert_uploaded" as const,
    locale: "pl" as const,
    recipient_email: "system",
    status: opts.status,
    error_message: opts.errorMessage,
    triggered_by: opts.vendorId,
    metadata: {
      filename: opts.filename,
      size_bytes: opts.sizeBytes,
      client_mime_type: opts.clientMimeType,
    },
  }
}

async function writeRejectAudit(
  req: MedusaRequest,
  opts: AuditPayload,
): Promise<string> {
  const auditId = randomUUID()
  await appendNotificationLogBestEffort(req.scope, buildAuditInput(opts, auditId))
  return auditId
}

async function writeSuccessAudit(
  req: MedusaRequest,
  opts: AuditPayload,
): Promise<string> {
  const auditId = randomUUID()
  await appendNotificationLog(req.scope, buildAuditInput(opts, auditId))
  return auditId
}

export async function uploadHandler(
  req: RequestWithVendorAuth,
  res: MedusaResponse<UploadSuccessResponse | UploadErrorResponse>,
  _next: MedusaNextFunction,
): Promise<void> {
  const vendorId = req.vendorAuth!.vendor_id

  const extracted = extractBuffer(req)
  const { buffer, filename, clientMimeType } = extracted
  const sizeBytes = buffer ? buffer.byteLength : 0

  const body = (req.body ?? {}) as Record<string, unknown>
  const query = (req.query ?? {}) as Record<string, unknown>
  const bodyVendorId =
    typeof body.vendor_id === "string" ? body.vendor_id : undefined
  const queryVendorId =
    typeof query.vendor_id === "string" ? query.vendor_id : undefined
  const claimedVendorId = bodyVendorId ?? queryVendorId
  if (claimedVendorId !== undefined && claimedVendorId !== vendorId) {
    await writeRejectAudit(req, {
      vendorId,
      status: "rejected",
      errorMessage: "cross_vendor_scope_mismatch",
      clientMimeType,
      filename,
      sizeBytes,
    })
    res.status(403).json({
      error: "Vendor scope mismatch",
      code: "cross_vendor_scope_mismatch",
    })
    return
  }

  if (!buffer || buffer.length === 0) {
    res.status(400).json({
      error:
        extracted.error === "invalid_base64"
          ? "fileData is not valid base64"
          : "No file data received. Send multipart/form-data or base64 fileData field.",
      code: extracted.error ?? "missing_file",
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

  const maxBytes = getMaxUploadBytes()
  if (sizeBytes > maxBytes) {
    await writeRejectAudit(req, {
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

  const sniffedType = sniffMagicBytes(buffer)
  const validation = validateCertBytes(
    { filename, sizeBytes, sniffedType },
    maxBytes,
  )

  if (!validation.valid) {
    await writeRejectAudit(req, {
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

  const ext = extractAllowedExtension(filename) ?? ".bin"
  const filePath = `vendor-training-certs/${vendorId}/${Date.now()}${ext}`

  let auditLogId: string
  try {
    auditLogId = await writeSuccessAudit(req, {
      vendorId,
      status: "sent",
      errorMessage: null,
      clientMimeType,
      filename,
      sizeBytes,
    })
  } catch {
    res.status(500).json({
      error: "Failed to persist upload audit row",
      code: "audit_persistence_failed",
    })
    return
  }

  res.json({
    vendor_id: vendorId,
    file_path: filePath,
    status: "pending_review",
    audit_log_id: auditLogId,
  })
}

export const postTrainingCertUpload = withVendorAuth(uploadHandler)
