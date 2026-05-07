/**
 * Story v160-6-2: Multi-vendor PDF voucher generator (stub-tier).
 *
 * Per Sprint 4 audit (T2): no PDF engine (handlebars/react-pdf/pdfkit) is
 * present in GP/backend yet. ADR-070 PDF rendering choice is still pending
 * concrete impl. To unblock the multi-vendor extension contract WITHOUT
 * blocking on engine selection, this module ships:
 *
 *   1. The MULTI-VENDOR ISOLATION CONTRACT (FM-43): given a cart with N
 *      distinct vendors, produce N PDF outputs (one per vendor); each PDF
 *      contains exactly ONE "Salon" section (per-vendor isolation).
 *   2. A privacy-boundary-correct payload builder (AR45 + NFR-SEC-9): the
 *      payload that flows into PDF render contains ONLY public fields —
 *      voucher code, vendor name/handle/address, product, value, validity,
 *      buyer note. NO recipient/buyer email, phone, or address.
 *   3. A `renderVoucherPdfStub()` returning a minimal `text/plain` Buffer
 *      until ADR-070 engine swap-in (Story 6.x). Storage path / signed URL
 *      logic is wired but actual MinIO/S3 upload is OUT OF 6.2 scope.
 *
 * When the PDF engine lands (Story 6.x backend extension), swap
 * `renderVoucherPdfStub()` with the real engine; the multi-vendor isolation
 * contract + payload shape remain stable (additive-MINOR per ports.ts
 * versioning convention).
 *
 * Story v160-6-5 extension: post-claim directions section appended between
 * the voucher card + footer. Reuses `maps-deeplink.ts` helpers (ported from
 * storefront Story 4.5) for Google + Apple Maps deeplink URLs. Defensive
 * fallback to search-query mode when coordinates are absent. Privacy notice
 * mandatory (always rendered when section renders).
 *
 * Story v160-cleanup-35: i18n shared source refactor (TF-81).
 * T30_PDF_COPY (hardcoded pl/en literals) replaced by shared JSON bundles
 * under i18n/ — single canonical source synced with storefront voucher.pdf.*
 * sub-namespace. 4-locale parity: pl/en/ua/de. lookupCopy() throws fail-fast
 * on missing or empty key (no silent fallback to EN or undefined).
 */

import {
  buildAppleMapsDeeplink,
  buildGoogleMapsDeeplink,
  buildSearchFallbackDeeplink,
} from "./maps-deeplink"

// ---------------------------------------------------------------------------
// Shared i18n bundles (canonical source — synced with storefront voucher.pdf.*)
// These JSON files are the single source of truth for voucher PDF copy.
// The validator _grow/tools/validate_i18n_parity.py --surface=voucher-pdf
// asserts parity between these bundles and storefront messages/{locale}.json.
// ---------------------------------------------------------------------------
import voucherPdfPl from "./i18n/voucher-pdf.pl.json"
import voucherPdfEn from "./i18n/voucher-pdf.en.json"
import voucherPdfUa from "./i18n/voucher-pdf.ua.json"
import voucherPdfDe from "./i18n/voucher-pdf.de.json"

/** Tracked keys for voucher PDF i18n — must match voucher_pdf_tracked_keys.yaml */
export type VoucherPdfCopyKey = keyof typeof voucherPdfPl

/** Supported locales for voucher PDF generation (4-locale parity, cleanup-19). */
export type VoucherPdfLocale = "pl" | "en" | "ua" | "de"

/** Shared voucher PDF copy bundles keyed by locale. */
export const VOUCHER_PDF_COPY: Record<VoucherPdfLocale, Record<string, string>> = {
  pl: voucherPdfPl as Record<string, string>,
  en: voucherPdfEn as Record<string, string>,
  ua: voucherPdfUa as Record<string, string>,
  de: voucherPdfDe as Record<string, string>,
}

/**
 * Lookup a voucher PDF i18n copy string for the given locale and key.
 *
 * Throws a typed error if the key is missing or empty for the locale —
 * NO silent fallback to EN, NO return of `undefined` or empty string.
 * This is the fail-fast contract for Story v160-cleanup-35 AC5.
 */
export function lookupCopy(locale: VoucherPdfLocale, key: VoucherPdfCopyKey): string {
  const bundle = VOUCHER_PDF_COPY[locale]
  const value = bundle?.[key as string]
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`missing voucher PDF i18n key: ${key} for locale ${locale}`)
  }
  return value
}

export interface CartLineItemForVoucher {
  id: string
  product_title?: string | null
  service_description?: string | null
  metadata?: {
    selected_seller_id?: string | null
    selected_seller_name?: string | null
  } | null
  unit_price?: number | null
  quantity?: number | null
}

export interface VendorRecord {
  id: string
  name: string
  handle: string
  address?: string | null
  photo_url?: string | null
  /** Optional geo coordinates for Story v160-6-5 directions section. */
  lat?: number | null
  lng?: number | null
}

export interface VoucherPdfPayload {
  /** Public voucher code (recipient-facing). */
  voucher_code: string
  /** Locale for backend-side translation lookup (4-locale: pl/en/ua/de). */
  locale: VoucherPdfLocale
  /** Single vendor context (per-vendor PDF isolation invariant). */
  vendor: {
    id: string
    name: string
    handle: string
    address?: string | null
    photo_url?: string | null
    /** Optional geo coordinates (Story v160-6-5 directions section). */
    lat?: number | null
    lng?: number | null
  }
  /** Service / product description (recipient-facing display copy). */
  service_description: string
  /** Voucher value in minor units (cents). */
  value_minor: number
  /** ISO 4217 currency code. */
  currency_code: string
  /** ISO 8601 validity start. */
  valid_from?: string | null
  /** ISO 8601 validity end. */
  valid_until?: string | null
  /** Optional buyer note (non-PII per Story 5.6 contract). */
  buyer_note?: string | null
}

/**
 * Group cart line items by selected_seller_id for per-vendor PDF generation.
 *
 * FM-43 invariant: items WITHOUT `metadata.selected_seller_id` fall into the
 * "_unassigned" bucket and trigger a backward-compat warning at the caller
 * (legacy single-vendor flow OR Story 5.5 fallback Option B).
 */
export function groupLineItemsByVendor(
  items: CartLineItemForVoucher[],
): Map<string, CartLineItemForVoucher[]> {
  const map = new Map<string, CartLineItemForVoucher[]>()
  for (const item of items) {
    const key = item.metadata?.selected_seller_id?.trim() || "_unassigned"
    const bucket = map.get(key) ?? []
    bucket.push(item)
    map.set(key, bucket)
  }
  return map
}

/**
 * Builds an AR45-compliant payload for ONE vendor's PDF.
 *
 * Caller is responsible for resolving `vendor` (one mercurClient.admin call
 * per unique seller_id) and `voucher_code` (per voucher dispatch); this
 * helper validates the shape and strips any disallowed fields by
 * re-projecting with an explicit allowlist.
 */
export function buildVoucherPdfPayload(args: {
  voucher_code: string
  locale: VoucherPdfLocale
  vendor: VendorRecord
  line_items: CartLineItemForVoucher[]
  currency_code?: string
  valid_from?: string | null
  valid_until?: string | null
  buyer_note?: string | null
}): VoucherPdfPayload {
  const value_minor = args.line_items.reduce(
    (acc, it) => acc + (it.unit_price ?? 0) * (it.quantity ?? 1),
    0,
  )
  const service_description =
    args.line_items[0]?.service_description ??
    args.line_items[0]?.product_title ??
    ""

  return {
    voucher_code: args.voucher_code,
    locale: args.locale,
    vendor: {
      id: args.vendor.id,
      name: args.vendor.name,
      handle: args.vendor.handle,
      address: args.vendor.address ?? null,
      photo_url: args.vendor.photo_url ?? null,
      lat: typeof args.vendor.lat === "number" ? args.vendor.lat : null,
      lng: typeof args.vendor.lng === "number" ? args.vendor.lng : null,
    },
    service_description,
    value_minor,
    currency_code: args.currency_code ?? "PLN",
    valid_from: args.valid_from ?? null,
    valid_until: args.valid_until ?? null,
    // Buyer note is the ONLY buyer-side field allowed (per Story 5.6
    // non-PII contract). Recipient/buyer email/phone/address are NEVER
    // included in this payload; the caller cannot leak them via the type.
    buyer_note: args.buyer_note ?? null,
  }
}

/**
 * Renders the PDF (stub-tier — text/plain Buffer until ADR-070 engine).
 *
 * Output is a deterministic, parseable text artifact that the AR45 contract
 * test (Story 6.2 AC4) can extract via `Buffer.toString('utf-8')` instead of
 * the real `pdf-parse` lib. When the real engine lands, this function gets
 * swapped; AC4 test should also gain the real `pdf-parse` extraction path.
 *
 * Uses lookupCopy() for all i18n strings — throws fail-fast on missing key.
 */
export function renderVoucherPdfStub(payload: VoucherPdfPayload): Buffer {
  const locale = payload.locale
  const lines: string[] = [
    `=== ${lookupCopy(locale, "title")} ===`,
    "",
    `${lookupCopy(locale, "redemption_code_label")}: ${payload.voucher_code}`,
    "",
    `--- ${lookupCopy(locale, "salon_section_title")} ---`,
    `${payload.vendor.name}`,
    `@${payload.vendor.handle}`,
  ]
  if (payload.vendor.address) {
    lines.push(payload.vendor.address)
  }
  lines.push("", `${lookupCopy(locale, "service_description_label")}: ${payload.service_description}`)
  lines.push(
    `${lookupCopy(locale, "voucher_value_label")}: ${(payload.value_minor / 100).toFixed(2)} ${payload.currency_code}`,
  )
  if (payload.valid_until) {
    lines.push(`${lookupCopy(locale, "validity_period_label")}: ${payload.valid_until}`)
  }
  if (payload.buyer_note) {
    lines.push("", `> ${payload.buyer_note}`)
  }

  // Story v160-6-5: appended directions section (per-vendor; AR45-safe).
  const directions = renderDirectionsSection(payload)
  if (directions.length > 0) {
    lines.push("", ...directions)
  }

  return Buffer.from(lines.join("\n"), "utf-8")
}

/**
 * Story v160-6-5: Renders the post-claim directions section as text lines
 * appended to the PDF document. Returns an empty array when the section
 * should be skipped entirely (no coords AND no address — defensive).
 *
 * Privacy invariant (AR45): only seller-side fields (name, address, coords)
 * are ever rendered. Voucher code is included by the parent stub already.
 * NO buyer-side fields are read here — type system + payload shape enforce.
 *
 * Uses lookupCopy() for all i18n strings — throws fail-fast on missing key.
 */
export function renderDirectionsSection(payload: VoucherPdfPayload): string[] {
  const { locale, vendor } = payload
  const hasCoords =
    typeof vendor.lat === "number" && typeof vendor.lng === "number"
  const hasAddress =
    typeof vendor.address === "string" && vendor.address.trim().length > 0

  // Skip section entirely if zero data — preserves clean layout.
  if (!hasCoords && !hasAddress) return []

  const lines: string[] = [`--- ${lookupCopy(locale, "directions_title")} ---`]

  if (hasAddress) {
    lines.push(`${lookupCopy(locale, "directions_address_label")}: ${vendor.address}`)
  }

  if (hasCoords) {
    const googleUrl = buildGoogleMapsDeeplink({
      lat: vendor.lat as number,
      lng: vendor.lng as number,
      name: vendor.name,
    })
    const appleUrl = buildAppleMapsDeeplink({
      lat: vendor.lat as number,
      lng: vendor.lng as number,
      name: vendor.name,
    })
    lines.push(`${lookupCopy(locale, "directions_google_label")}: ${googleUrl}`)
    lines.push(`${lookupCopy(locale, "directions_apple_label")}: ${appleUrl}`)
  } else if (hasAddress) {
    // Search-query fallback when coordinates absent — link still resolves
    // to user's preferred maps app via address text geocoding.
    const googleUrl = buildSearchFallbackDeeplink({
      provider: "google",
      name: vendor.name,
      address: vendor.address as string,
    })
    const appleUrl = buildSearchFallbackDeeplink({
      provider: "apple",
      name: vendor.name,
      address: vendor.address as string,
    })
    lines.push(`${lookupCopy(locale, "directions_google_label")}: ${googleUrl}`)
    lines.push(`${lookupCopy(locale, "directions_apple_label")}: ${appleUrl}`)
    lines.push(lookupCopy(locale, "directions_no_coords_helper"))
  }

  // Privacy notice mandatory whenever section renders (AR45 + Story 4.5
  // web parity — leaving BonBeauty boundary disclosure).
  lines.push("", lookupCopy(locale, "directions_privacy_notice"))

  return lines
}

/**
 * Storage key contract — deterministic per-vendor isolation path.
 *
 * MinIO/S3 upload + presigned URL TTL ≤24h NFR-SEC-1 wiring is OUT OF 6.2
 * scope (storage layer authoring deferred). The key contract is stable so
 * downstream Story 6.5 directions consumer can rely on it.
 */
export function buildVoucherPdfStorageKey(
  voucher_id: string,
  seller_id: string,
): string {
  return `vouchers/${voucher_id}/seller-${seller_id}.pdf`
}

/**
 * Multi-vendor dispatch — given cart line items, produce 1 PDF payload per
 * unique vendor. AC2 + AC7 guarantee: 2 vendors → 2 distinct PDFs.
 *
 * The actual MinIO upload + email delivery via D-60 worker is wired by the
 * caller (workflow step) using these payloads + the storage key contract.
 */
export interface MultiVendorPdfDispatch {
  vendor_id: string
  storage_key: string
  payload: VoucherPdfPayload
  pdf_buffer: Buffer
}

export function dispatchMultiVendorPdfs(args: {
  voucher_id: string
  voucher_code: string
  locale: VoucherPdfLocale
  line_items: CartLineItemForVoucher[]
  vendors_by_id: Record<string, VendorRecord>
  currency_code?: string
  valid_until?: string | null
  buyer_note?: string | null
}): MultiVendorPdfDispatch[] {
  const grouped = groupLineItemsByVendor(args.line_items)
  const dispatches: MultiVendorPdfDispatch[] = []

  for (const [seller_id, items] of grouped) {
    if (seller_id === "_unassigned") {
      // Backward-compat: legacy single-vendor flow falls through to caller's
      // v1.5.0 single-vendor template path (caller decides; out of 6.2).
      continue
    }
    const vendor = args.vendors_by_id[seller_id]
    if (!vendor) {
      // Vendor record fetch failed — skip with caller-side warning.
      continue
    }
    const payload = buildVoucherPdfPayload({
      voucher_code: args.voucher_code,
      locale: args.locale,
      vendor,
      line_items: items,
      currency_code: args.currency_code,
      valid_until: args.valid_until,
      buyer_note: args.buyer_note,
    })
    const pdf_buffer = renderVoucherPdfStub(payload)
    const storage_key = buildVoucherPdfStorageKey(args.voucher_id, seller_id)
    dispatches.push({ vendor_id: seller_id, storage_key, payload, pdf_buffer })
  }

  return dispatches
}
