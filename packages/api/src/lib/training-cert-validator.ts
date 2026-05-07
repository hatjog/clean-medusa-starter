/**
 * Story v160-7-6: Training certificate file validator.
 * Extended by v160-cleanup-39-magicbyte-validator (TF-93).
 *
 * Validates upload type + size before persistence. Used by upload route +
 * client-side validator (frontend can mirror this logic).
 *
 * The new `validateCertBytes` function is the authoritative accept/reject
 * check (based on magic-byte sniff).  The legacy `validateCertFile`
 * function remains for backwards-compatible callers but is NO LONGER
 * called by the upload route for the accept/reject decision.
 */

import type { SniffedType } from "./magic-byte-sniffer"
import { EXTENSION_TYPE_MAP } from "./training-cert-upload-config"

export const ALLOWED_CERT_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
] as const

export const ALLOWED_CERT_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png"] as const

export const MAX_CERT_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB

export interface CertValidationInput {
  filename: string
  mimeType: string
  sizeBytes: number
}

export interface CertValidationResult {
  valid: boolean
  errors: string[]
}

export function validateCertFile(
  input: CertValidationInput,
): CertValidationResult {
  const errors: string[] = []

  // MIME type check
  if (!ALLOWED_CERT_MIME_TYPES.includes(input.mimeType as typeof ALLOWED_CERT_MIME_TYPES[number])) {
    errors.push(
      `Invalid MIME type: ${input.mimeType}. Allowed: ${ALLOWED_CERT_MIME_TYPES.join(", ")}`,
    )
  }

  // Extension check (defense in depth)
  const lower = input.filename.toLowerCase()
  const matched = ALLOWED_CERT_EXTENSIONS.some((ext) => lower.endsWith(ext))
  if (!matched) {
    errors.push(
      `Invalid extension. Allowed: ${ALLOWED_CERT_EXTENSIONS.join(", ")}`,
    )
  }

  // Size check
  if (input.sizeBytes > MAX_CERT_SIZE_BYTES) {
    errors.push(
      `File too large: ${input.sizeBytes} bytes (max ${MAX_CERT_SIZE_BYTES})`,
    )
  }

  if (input.sizeBytes <= 0) {
    errors.push("File is empty")
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Returns the file extension to use for storage given a validated filename.
 */
export function getCertExtension(filename: string): string {
  const lower = filename.toLowerCase()
  for (const ext of ALLOWED_CERT_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext
  }
  return ".bin" // unreachable when validateCertFile passed
}

// ---------------------------------------------------------------------------
// v160-cleanup-39 — server-side byte-sniff validation (TF-93 closure)
// ---------------------------------------------------------------------------

export type CertBytesErrorCode =
  | "size_exceeded"
  | "magic_byte_mismatch"
  | "filename_extension_mismatch"

export interface CertBytesValidationInput {
  filename: string
  sizeBytes: number
  sniffedType: SniffedType | null
}

export interface CertBytesValidationResult {
  valid: boolean
  errorCode?: CertBytesErrorCode
}

/**
 * Authoritative accept/reject validator for the training-cert upload route.
 *
 * Guard order (cheap-first):
 *   1. size_exceeded — buffer too large
 *   2. magic_byte_mismatch — sniffedType is null (unrecognised signature)
 *   3. filename_extension_mismatch — filename extension doesn't map to sniffedType
 *
 * Callers MUST supply `sizeBytes` as the actual buffer byte length (not the
 * client-declared size). `sniffedType` must have been obtained from
 * `sniffMagicBytes(buffer)` — never from a client-supplied MIME header.
 */
export function validateCertBytes(
  input: CertBytesValidationInput,
  maxBytes: number,
): CertBytesValidationResult {
  // Guard 1: size
  if (input.sizeBytes > maxBytes) {
    return { valid: false, errorCode: "size_exceeded" }
  }

  // Guard 2: magic-byte signature
  if (input.sniffedType === null) {
    return { valid: false, errorCode: "magic_byte_mismatch" }
  }

  // Guard 3: filename-extension cross-check (defense in depth)
  const lower = input.filename.toLowerCase()
  const extEntry = Object.entries(EXTENSION_TYPE_MAP).find(([ext]) =>
    lower.endsWith(ext),
  )
  if (!extEntry || extEntry[1] !== input.sniffedType) {
    return { valid: false, errorCode: "filename_extension_mismatch" }
  }

  return { valid: true }
}
