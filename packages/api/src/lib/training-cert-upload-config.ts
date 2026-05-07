/**
 * Story v160-cleanup-39-magicbyte-validator (TF-93).
 *
 * Runtime configuration for the training-cert upload endpoint.
 *
 * `getMaxUploadBytes()` reads the optional `GP_TRAINING_CERT_MAX_BYTES`
 * env var and validates it at call time (designed to be called once at
 * server boot so misconfiguration fails loudly rather than silently
 * falling through to a wrong limit).
 *
 * Default: 10 MiB (10 * 1024 * 1024 bytes).
 * Throws a RangeError when the env value is present but ≤ 0 or non-numeric.
 */

export const ALLOWED_SNIFFED_TYPES = ["pdf", "png", "jpeg"] as const
export type AllowedSniffedType = (typeof ALLOWED_SNIFFED_TYPES)[number]

/** Extension-to-sniffed-type mapping used for cross-check (defense in depth). */
export const EXTENSION_TYPE_MAP: Record<string, AllowedSniffedType> = {
  ".pdf": "pdf",
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 // 10 MiB

/**
 * Returns the configured maximum upload size in bytes.
 *
 * Reads `GP_TRAINING_CERT_MAX_BYTES` from the process environment.
 * Throws a `RangeError` when the value is present but invalid (non-numeric
 * or ≤ 0) — no silent fallback in production paths.
 */
export function getMaxUploadBytes(): number {
  const raw = process.env.GP_TRAINING_CERT_MAX_BYTES
  if (raw === undefined || raw === "") return DEFAULT_MAX_BYTES

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError(
      `[training-cert-upload-config] GP_TRAINING_CERT_MAX_BYTES must be a positive integer; got "${raw}"`,
    )
  }

  return Math.floor(parsed)
}
