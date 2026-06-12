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

import { postTrainingCertUpload } from "./helpers"

// Export the POST handler wrapped in withVendorAuth.
// withVendorAuth handles 401 for missing / invalid tokens.
export const POST = postTrainingCertUpload
