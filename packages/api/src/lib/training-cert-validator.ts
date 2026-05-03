/**
 * Story v160-7-6: Training certificate file validator.
 *
 * Validates upload type + size before persistence. Used by upload route +
 * client-side validator (frontend can mirror this logic).
 */

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
