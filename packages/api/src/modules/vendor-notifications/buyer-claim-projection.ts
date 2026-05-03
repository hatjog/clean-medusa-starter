/**
 * Story v160-6-6: AR45-safe email payload projection for buyer claim
 * notifications.
 *
 * Defensive whitelist allowlist: even if the upstream voucher payload (raw
 * Mercur 2 / Medusa record) carries recipient-side fields, only the 6
 * allowlisted public+buyer-side fields ever reach the email render layer.
 * This is enforced at the type system level (the output type literally has
 * no recipient_* properties) AND at runtime via this projector.
 *
 * The integration test (Story 6.6 AC6) populates a synthetic source with all
 * known recipient fields + asserts the JSON-serialised projection contains
 * none of them. Adding new recipient fields to the source is a no-op —
 * projection ignores anything not on the allowlist.
 */

import type { BuyerClaimEmailLocale } from "./email-templates/buyer-claim/i18n"

/** Source shape — anything the data layer might have. Fields are optional
 * because we DO NOT trust the source to be minimal. The projection below is
 * the trust boundary. */
export interface VoucherClaimSourceRecord {
  // Allowlisted (will pass through projection):
  buyer_email?: string | null
  buyer_locale?: BuyerClaimEmailLocale | string | null
  seller_name?: string | null
  seller_handle?: string | null
  service_title?: string | null
  claimed_at?: string | null
  voucher_code?: string | null
  // Block-listed (MUST NOT reach the email layer — listed here for clarity;
  // the projection function does not read these fields):
  recipient_email?: string | null
  recipient_name?: string | null
  recipient_phone?: string | null
  recipient_ip?: string | null
  recipient_user_agent?: string | null
  claim_session_id?: string | null
  recipient_address?: string | null
  gift_message?: string | null
}

export interface BuyerClaimEmailPayload {
  buyer_email: string
  locale: BuyerClaimEmailLocale
  seller_name: string
  seller_handle: string
  service_title: string
  claimed_at: string
  voucher_code: string
}

const SUPPORTED_LOCALES: ReadonlySet<BuyerClaimEmailLocale> = new Set([
  "pl",
  "en",
])

function resolveLocale(raw: unknown): BuyerClaimEmailLocale {
  if (typeof raw === "string" && SUPPORTED_LOCALES.has(raw as BuyerClaimEmailLocale)) {
    return raw as BuyerClaimEmailLocale
  }
  // Default `pl` per BonBeauty market primary. Pattern matches Story 7.1.
  return "pl"
}

/**
 * AR45 boundary projection. Returns null if mandatory fields are missing
 * (caller writes a `failed` audit entry instead of dispatching).
 *
 * Defensive: explicit field reads + explicit return shape — no spread, no
 * Object.assign, no JSON round-trip from source. This makes the allowlist
 * trivially auditable and the type system reinforces the invariant.
 */
export function projectBuyerClaimEmailPayload(
  source: VoucherClaimSourceRecord,
): BuyerClaimEmailPayload | null {
  if (
    !source.buyer_email ||
    !source.seller_name ||
    !source.seller_handle ||
    !source.service_title ||
    !source.claimed_at ||
    !source.voucher_code
  ) {
    return null
  }
  return {
    buyer_email: String(source.buyer_email),
    locale: resolveLocale(source.buyer_locale),
    seller_name: String(source.seller_name),
    seller_handle: String(source.seller_handle),
    service_title: String(source.service_title),
    claimed_at: String(source.claimed_at),
    voucher_code: String(source.voucher_code),
  }
}
