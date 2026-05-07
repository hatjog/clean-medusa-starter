/**
 * Multi-vendor PDF voucher generator (cleanup-52 / TF-117: engine swap done).
 *
 * History:
 *   Story v160-6-2: shipped multi-vendor isolation contract (FM-43) + AR45
 *     privacy-boundary payload builder + renderVoucherPdfStub (text/plain).
 *   Story v160-6-5: appended directions section (maps-deeplink.ts helpers).
 *   Story v160-cleanup-35: i18n shared source refactor (TF-81). T30_PDF_COPY
 *     replaced by shared JSON bundles under i18n/ — single canonical source
 *     synced with storefront voucher.pdf.* sub-namespace. 4-locale parity:
 *     pl/en/ua/de. lookupCopy() throws fail-fast on missing or empty key.
 *   cleanup-52: replaced stub with real pdfkit engine; storage layer authored
 *     in storage/; loader in loaders/voucher-pdf-storage.ts.
 *
 * Multi-vendor isolation contract (FM-43): given a cart with N distinct
 * vendors, produce N PDF outputs (one per vendor); each PDF contains exactly
 * ONE "Salon" section (per-vendor isolation).
 *
 * Privacy boundary (AR45 + NFR-SEC-9): payload contains ONLY public fields —
 * voucher code, vendor name/handle/address, product, value, validity, buyer
 * note. NO recipient/buyer email, phone, or address.
 *
 * Engine: pdfkit (pure JS, MIT, no native deps). Output: real PDF binary
 * starting with %PDF- magic header (0x25 0x50 0x44 0x46).
 *
 * Storage layer: IVoucherPdfStorage port (storage/ports.ts); default adapter
 * FilesystemVoucherPdfStorage (storage/adapters/filesystem-storage.ts).
 * Loader: loaders/voucher-pdf-storage.ts registers `voucher_pdf_storage` key.
 */

import PDFDocument from "pdfkit"

import {
  buildAppleMapsDeeplink,
  buildGoogleMapsDeeplink,
  buildSearchFallbackDeeplink,
} from "./maps-deeplink"

// ---------------------------------------------------------------------------
// Shared i18n bundles (canonical SSOT for voucher PDF copy).
// These four JSON files in ./i18n/ are the single source of truth. The PL
// bundle defines the keyset baseline (VoucherPdfCopyKey); EN/UA/DE bundles
// must carry the exact same keyset (enforced at module load by
// assertBundleParity() — fail-fast at startup if drift introduced).
//
// Cross-surface parity (backend bundles ↔ storefront `voucher.pdf.*` keys in
// `GP/storefront/messages/{locale}.json`) is enforced by
// `_grow/tools/validate_i18n_parity.py --surface=voucher-pdf` (cleanup-35).
// ---------------------------------------------------------------------------
import voucherPdfPl from "./i18n/voucher-pdf.pl.json"
import voucherPdfEn from "./i18n/voucher-pdf.en.json"
import voucherPdfUa from "./i18n/voucher-pdf.ua.json"
import voucherPdfDe from "./i18n/voucher-pdf.de.json"

// One-shot deprecation guards (review fix H3, M4).
let _warnedSyncDeprecated = false
let _warnedUnassignedSeen = false
function _warnOnce(flagSetter: (v: boolean) => void, flag: boolean, msg: string): void {
  if (flag) return
  flagSetter(true)
  // eslint-disable-next-line no-console
  console.warn(msg)
}

/**
 * Tracked keys for voucher PDF i18n — derived from the PL bundle keyset.
 * Cross-locale keyset equality is asserted at module load (assertBundleParity).
 */
export type VoucherPdfCopyKey = Exclude<keyof typeof voucherPdfPl, "_review">

/** Supported locales for voucher PDF generation (4-locale parity, cleanup-19). */
export type VoucherPdfLocale = "pl" | "en" | "ua" | "de"

/**
 * Strip non-translation meta keys (e.g. `_review` stub-translation marker) from
 * an imported bundle so they don't leak into lookup or parity checks.
 */
const META_KEYS: ReadonlySet<string> = new Set(["_review"])
function stripMeta(bundle: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(bundle)) {
    if (META_KEYS.has(k)) continue
    if (typeof v === "string") out[k] = v
  }
  return out
}

/**
 * Shared voucher PDF copy bundles keyed by locale.
 *
 * Each per-locale bundle is `Object.freeze`d to prevent accidental mutation
 * by production callers. The test suite uses an explicit `as any` cast plus
 * snapshot-restore pattern for negative-path coverage of `lookupCopy`.
 */
export const VOUCHER_PDF_COPY: Readonly<
  Record<VoucherPdfLocale, Readonly<Record<string, string>>>
> = Object.freeze({
  pl: Object.freeze(stripMeta(voucherPdfPl as unknown as Record<string, unknown>)),
  en: Object.freeze(stripMeta(voucherPdfEn as unknown as Record<string, unknown>)),
  ua: Object.freeze(stripMeta(voucherPdfUa as unknown as Record<string, unknown>)),
  de: Object.freeze(stripMeta(voucherPdfDe as unknown as Record<string, unknown>)),
})

/**
 * Module-load invariant: assert all four locale bundles carry the exact same
 * keyset (modulo `_review` meta). Closes the gap left by `VoucherPdfCopyKey =
 * keyof typeof voucherPdfPl` (PL-only TS coverage). Throws at import time so
 * the PDF surface refuses to boot with drifted bundles.
 */
function assertBundleParity(): void {
  const baseline = new Set(Object.keys(VOUCHER_PDF_COPY.pl))
  for (const loc of ["en", "ua", "de"] as const) {
    const locKeys = new Set(Object.keys(VOUCHER_PDF_COPY[loc]))
    const missing = [...baseline].filter((k) => !locKeys.has(k))
    const extra = [...locKeys].filter((k) => !baseline.has(k))
    if (missing.length || extra.length) {
      throw new Error(
        `voucher PDF i18n bundle parity violation for locale ${loc}: ` +
          `missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`,
      )
    }
  }
}
assertBundleParity()

/**
 * Internal: pure-function lookup over an arbitrary bundle. Exposed for
 * unit-test coverage of the fail-fast contract independent of the frozen
 * production `VOUCHER_PDF_COPY` (B-4: production bundles are immutable).
 */
export function lookupCopyFromBundle(
  bundle: Readonly<Record<string, string>> | undefined,
  locale: VoucherPdfLocale,
  key: VoucherPdfCopyKey | string,
): string {
  const value = bundle?.[key as string]
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`missing voucher PDF i18n key: ${String(key)} for locale ${locale}`)
  }
  return value
}

/**
 * Lookup a voucher PDF i18n copy string for the given locale and key.
 *
 * Throws a typed error if the key is missing or empty for the locale —
 * NO silent fallback to EN, NO return of `undefined` or empty string.
 * This is the fail-fast contract for Story v160-cleanup-35 AC5.
 */
export function lookupCopy(locale: VoucherPdfLocale, key: VoucherPdfCopyKey): string {
  return lookupCopyFromBundle(VOUCHER_PDF_COPY[locale], locale, key)
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
 * Renders a real PDF voucher document using pdfkit (cleanup-52 / TF-117).
 *
 * Output is a valid PDF binary starting with %PDF- magic header bytes.
 * Multi-vendor isolation (FM-43): each call renders exactly ONE vendor's
 * Salon section — caller is responsible for per-vendor dispatch.
 *
 * AR45 privacy boundary: payload contains only public/vendor-side fields.
 * No recipient email/phone/address reaches this function.
 *
 * Engine: pdfkit (pure JS, MIT, no native deps, Node.js streaming Buffer).
 * Uses lookupCopy() for all i18n strings — throws fail-fast on missing key.
 */
export function renderVoucherPdf(payload: VoucherPdfPayload): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const locale = payload.locale
    const chunks: Buffer[] = []

    const doc = new PDFDocument({ margin: 50, size: "A4" })

    doc.on("data", (chunk: Buffer) => chunks.push(chunk))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    // Title
    doc
      .fontSize(18)
      .font("Helvetica-Bold")
      .text(lookupCopy(locale, "title"), { align: "center" })
    doc.moveDown(0.5)

    // Voucher code
    doc
      .fontSize(12)
      .font("Helvetica")
      .text(`${lookupCopy(locale, "redemption_code_label")}: `, { continued: true })
      .font("Helvetica-Bold")
      .text(payload.voucher_code)
    doc.moveDown(0.8)

    // Salon section header (FM-43: exactly ONE salon section per PDF)
    doc
      .fontSize(13)
      .font("Helvetica-Bold")
      .text(`— ${lookupCopy(locale, "salon_section_title")} —`)
    doc.font("Helvetica").fontSize(11)
    doc.text(payload.vendor.name)
    doc.text(`@${payload.vendor.handle}`)
    if (payload.vendor.address) {
      doc.text(payload.vendor.address)
    }
    doc.moveDown(0.5)

    // Service + value
    doc.text(
      `${lookupCopy(locale, "service_description_label")}: ${payload.service_description}`,
    )
    doc.text(
      `${lookupCopy(locale, "voucher_value_label")}: ${(payload.value_minor / 100).toFixed(2)} ${payload.currency_code}`,
    )

    // Validity
    if (payload.valid_until) {
      doc.text(`${lookupCopy(locale, "validity_period_label")}: ${payload.valid_until}`)
    }

    // Buyer note
    if (payload.buyer_note) {
      doc.moveDown(0.3)
      doc.font("Helvetica-Oblique").text(`> ${payload.buyer_note}`)
      doc.font("Helvetica")
    }

    // Directions section (Story v160-6-5; AR45-safe — vendor-side only)
    const directions = renderDirectionsSection(payload)
    if (directions.length > 0) {
      doc.moveDown(0.8)
      doc
        .fontSize(12)
        .font("Helvetica-Bold")
        .text(`— ${lookupCopy(locale, "directions_title")} —`)
      doc.fontSize(10).font("Helvetica")
      // Skip the header line already rendered above; output remaining lines.
      const bodyLines = directions.slice(1)
      for (const line of bodyLines) {
        if (line === "") {
          doc.moveDown(0.3)
        } else {
          doc.text(line)
        }
      }
    }

    doc.end()
  })
}

/**
 * Synchronous wrapper kept for backwards-compat with callers that cannot
 * await. Returns a minimal text/plain Buffer — use renderVoucherPdf() for
 * the real PDF output.
 *
 * Uses lookupCopy() for all i18n strings — throws fail-fast on missing key.
 *
 * @deprecated Use renderVoucherPdf() (async, real PDF) instead.
 *   Alias kept for v1.6.0 soft-rename window; removed in v1.7.0.
 *   Callers relying on PDF binary output MUST migrate to renderVoucherPdf().
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
  lines.push(
    "",
    `${lookupCopy(locale, "service_description_label")}: ${payload.service_description}`,
  )
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
 * Persist a generated PDF artifact via storage port.
 *
 * Wire point for D-60 worker and caller-side dispatch flow (cleanup-52).
 * Caller resolves `storage` from Medusa container as `voucher_pdf_storage`.
 */
export async function persistDeliveryArtifact(args: {
  storage: import("./storage/ports").IVoucherPdfStorage
  dispatch: MultiVendorPdfDispatch
  delivery_id: string
  recipient_token: string
  /**
   * Optional generation timestamp. When provided, overrides Date.now()
   * (review fix M1). Use this when the PDF was rendered earlier than the
   * persistence call (queued-worker / dispatch-then-persist patterns) so
   * retention timing reflects actual render time, not store time.
   */
  generated_at?: string
}): Promise<import("./storage/ports").StoreOutput> {
  return args.storage.store({
    storage_key: args.dispatch.storage_key,
    pdf_buffer: args.dispatch.pdf_buffer,
    metadata: {
      delivery_id: args.delivery_id,
      recipient_token: args.recipient_token,
      generated_at: args.generated_at ?? new Date().toISOString(),
      vendor_handles: [args.dispatch.payload.vendor.handle],
    },
  })
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
 * unique vendor. FM-43 guarantee: 2 vendors → 2 distinct PDFs.
 *
 * Storage layer (cleanup-52): after dispatch, caller passes each item to
 * persistDeliveryArtifact() with the resolved IVoucherPdfStorage port.
 * D-60 worker integration and email dispatch are separate story scope.
 */
export interface MultiVendorPdfDispatch {
  vendor_id: string
  storage_key: string
  payload: VoucherPdfPayload
  pdf_buffer: Buffer
}

/**
 * Async dispatch — uses real pdfkit engine (cleanup-52 / TF-117).
 *
 * Preferred for new callers. Returns Promise<MultiVendorPdfDispatch[]>.
 * Legacy sync callers must migrate from dispatchMultiVendorPdfs() to this.
 */
export async function dispatchMultiVendorPdfsAsync(args: {
  voucher_id: string
  voucher_code: string
  locale: VoucherPdfLocale
  line_items: CartLineItemForVoucher[]
  vendors_by_id: Record<string, VendorRecord>
  currency_code?: string
  valid_from?: string | null
  valid_until?: string | null
  buyer_note?: string | null
}): Promise<MultiVendorPdfDispatch[]> {
  const grouped = groupLineItemsByVendor(args.line_items)
  const dispatches: MultiVendorPdfDispatch[] = []

  for (const [seller_id, items] of grouped) {
    if (seller_id === "_unassigned") {
      _warnOnce(
        (v) => { _warnedUnassignedSeen = v },
        _warnedUnassignedSeen,
        "[voucher-delivery] dispatchMultiVendorPdfsAsync: skipping line items " +
          "without metadata.selected_seller_id (legacy single-vendor flow). " +
          "These items will NOT produce a voucher PDF.",
      )
      continue
    }
    const vendor = args.vendors_by_id[seller_id]
    if (!vendor) {
      // Review fix M4: surface missing-vendor skips so silent data loss is
      // observable in dev/CI logs.
      // eslint-disable-next-line no-console
      console.warn(
        `[voucher-delivery] dispatchMultiVendorPdfsAsync: vendor record ` +
          `missing for seller_id=${seller_id}; skipping ${items.length} item(s).`,
      )
      continue
    }
    const payload = buildVoucherPdfPayload({
      voucher_code: args.voucher_code,
      locale: args.locale,
      vendor,
      line_items: items,
      currency_code: args.currency_code,
      valid_from: args.valid_from,
      valid_until: args.valid_until,
      buyer_note: args.buyer_note,
    })
    // Use real pdfkit engine — output is valid PDF binary (%PDF-).
    const pdf_buffer = await renderVoucherPdf(payload)
    const storage_key = buildVoucherPdfStorageKey(args.voucher_id, seller_id)
    dispatches.push({ vendor_id: seller_id, storage_key, payload, pdf_buffer })
  }

  return dispatches
}

/**
 * Sync dispatch (backwards-compat wrapper).
 *
 * Uses renderVoucherPdfStub (text/plain Buffer) — kept for callers that cannot
 * await. For real PDF binary output migrate to dispatchMultiVendorPdfsAsync().
 *
 * @deprecated Migrate to dispatchMultiVendorPdfsAsync() for real PDF output.
 *   Removed in v1.7.0 when stub alias is dropped.
 */
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
  // Review fix H3: emit a one-shot runtime deprecation warning so callers
  // shipping the text/plain stub buffer to storage surface during dev/CI.
  _warnOnce(
    (v) => { _warnedSyncDeprecated = v },
    _warnedSyncDeprecated,
    "[voucher-delivery] dispatchMultiVendorPdfs is deprecated and produces " +
      "non-PDF stub buffers (text/plain). Persisting these buffers via " +
      "persistDeliveryArtifact will store invalid PDF artifacts. " +
      "Migrate to dispatchMultiVendorPdfsAsync() before v1.7.0.",
  )

  const grouped = groupLineItemsByVendor(args.line_items)
  const dispatches: MultiVendorPdfDispatch[] = []

  for (const [seller_id, items] of grouped) {
    if (seller_id === "_unassigned") {
      continue
    }
    const vendor = args.vendors_by_id[seller_id]
    if (!vendor) {
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
