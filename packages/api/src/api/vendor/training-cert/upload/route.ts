/**
 * Story v160-cleanup-39-magicbyte-validator: POST /vendor/training-cert/upload
 *
 * Closes TF-93 (magic-byte sniffing) + TF-109 (JWT-derived vendor scope).
 *
 * Guard chain (return-on-first-fail per AC4):
 *   1. withVendorAuth  — resolves vendor_id from x-vendor-token (401 on fail)
 *   2. Cross-vendor    — any client vendor identifier (body OR query) must
 *                        match JWT vendor_id (403)
 *   3. Size guard      — buffer.byteLength > maxBytes → 413 (cheap check first, AC3)
 *   4. Magic-byte      — sniffMagicBytes null → 415 (AC2)
 *   5. Extension check — filename ext ↔ sniffedType mismatch → 415 (AC1 depth)
 *
 * Auth failures (401) do NOT write an audit row — no resolved vendor_id.
 * All other outcomes (200, 403, 413, 415) write an append-only audit row (AC6).
 *
 * Client-supplied Content-Type / mimeType is NEVER used for accept/reject (AC1).
 *
 * Review fixes (2026-05-07):
 *   F1 — success-path audit uses throwing appendNotificationLog (durable)
 *   F2 — audit_log_id uses crypto.randomUUID (collision-safe)
 *   F3 — cross-vendor reject carries real sizeBytes
 *   F4 — query.vendor_id also cross-checked
 *   F7 — success extension preserves caller's original (.jpeg vs .jpg)
 *   F9 — base64 fallback rejected with 400 invalid_base64 instead of silent truncation
 *
 * TODO(TF-109-followup, Story 3.x): vendor-auth.ts::extractSellerIdFromToken
 * still treats the raw header as the seller_id without HMAC/JWT signature
 * verification. The route-level scope guard here is correct, but the
 * underlying token authenticity check belongs to the auth-layer hardening
 * tracked under Story 3.x. TF-109 is route-scope-closed; auth-layer-deferred.
 */

import { randomUUID } from "node:crypto"

import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"

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

/** Strict base64 alphabet (RFC 4648). Used to reject malformed fallback
 * payloads with a clean 400 instead of silently coercing to a partial
 * buffer (review F9). */
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

  // Strip whitespace (some clients line-wrap base64 payloads) before validation.
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

/** Returns the storage extension preserving caller's choice (review F7).
 * Iterates longest-first so `.jpeg` matches before `.jpg`. */
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

/** Reject paths: best-effort write so a transient DB failure cannot mask
 * the underlying security verdict (still return 4xx to client). */
async function writeRejectAudit(
  req: MedusaRequest,
  opts: AuditPayload,
): Promise<string> {
  const auditId = randomUUID()
  await appendNotificationLogBestEffort(req.scope, buildAuditInput(opts, auditId))
  return auditId
}

/** Success path: durable write — AC6 requires every non-401 outcome to
 * have an append-only row. A persistence failure surfaces as a 5xx so
 * operators see it; do NOT advertise a phantom audit_log_id (F1). */
async function writeSuccessAudit(
  req: MedusaRequest,
  opts: AuditPayload,
): Promise<string> {
  const auditId = randomUUID()
  await appendNotificationLog(req.scope, buildAuditInput(opts, auditId))
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

  // Extract buffer up-front so audit rows for ALL reject paths carry the
  // real sizeBytes (review F3).
  const extracted = extractBuffer(req)
  const { buffer, filename, clientMimeType } = extracted
  const sizeBytes = buffer ? buffer.byteLength : 0

  // Guard 2: Cross-vendor scope check — body OR query (review F4 / AC4).
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

  // Guard 3: Size guard before sniff (cheap first, AC3)
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

  // Guard 4+5: Magic-byte sniff + extension check (AC1, AC2)
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

  // Success — preserve caller's original extension (review F7).
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

// Export the POST handler wrapped in withVendorAuth.
// withVendorAuth handles 401 for missing / invalid tokens.
export const POST = withVendorAuth(uploadHandler)

// Export uploadHandler for unit-test direct invocation (review F5).
// Tests inject a stub vendorAuth onto req and bypass the HOF — this proves
// the inner handler logic (not a parallel simulator) is the one under test.
export { uploadHandler }
