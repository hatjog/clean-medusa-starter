/**
 * Story v160-cleanup-39-magicbyte-validator (TF-93).
 *
 * Server-side magic-byte / file-signature sniffer. Pure function — no I/O.
 * Called by the training-cert upload route BEFORE any MIME header is
 * trusted: the sniffed type is the sole authority for accept/reject.
 *
 * Supported signatures (byte-exact, case-sensitive):
 *   PDF  : 0x25 0x50 0x44 0x46  (%PDF)
 *   PNG  : 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
 *   JPEG : 0xFF 0xD8 0xFF
 *
 * Returns the canonical type string or null when the buffer does not start
 * with any of the recognised signatures (or is too short to compare).
 */

export type SniffedType = "pdf" | "png" | "jpeg"

/** Minimum buffer length required to decide — longest signature is 8 bytes. */
const MIN_SNIFF_BYTES = 8

// Byte arrays kept as readonly tuples for zero-alloc comparison.
const SIG_PDF: readonly number[] = [0x25, 0x50, 0x44, 0x46]
const SIG_PNG: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const SIG_JPEG: readonly number[] = [0xff, 0xd8, 0xff]

function startsWith(buf: Buffer, sig: readonly number[]): boolean {
  if (buf.length < sig.length) return false
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) return false
  }
  return true
}

/**
 * Inspect the first `MIN_SNIFF_BYTES` bytes of `buf` and return the
 * canonical file type, or `null` when no known signature matches.
 *
 * Only the first few bytes are read — callers should pass the full
 * buffer; this function never reads beyond `MIN_SNIFF_BYTES`.
 */
export function sniffMagicBytes(buf: Buffer): SniffedType | null {
  if (!buf || buf.length === 0) return null

  // Order matters: most-specific (longest) signature first where prefixes
  // might overlap.  PNG (8 bytes) before PDF (4 bytes) before JPEG (3).
  if (startsWith(buf, SIG_PNG)) return "png"
  if (startsWith(buf, SIG_PDF)) return "pdf"
  if (startsWith(buf, SIG_JPEG)) return "jpeg"

  return null
}
