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
import QRCode from "qrcode"

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
/**
 * BonBeauty brand-skin tokens for the PDF (contract A — cream/gold). Hex literals
 * mirror the storefront tokens (--gold #C5A059, --cta #907032, page-bg #F9F4EC).
 */
const PDF_BRAND = {
  cream: "#F9F4EC",
  card: "#FFFFFF",
  gold: "#C5A059",
  bronze: "#907032",
  ink: "#1A1A1A",
  muted: "#7A7263",
  hairline: "#E6D8BC",
  tint: "#F6EEDD",
  noteBg: "#FBF6EC",
} as const

const PDF_BCP47: Record<VoucherPdfLocale, string> = {
  pl: "pl-PL",
  en: "en-GB",
  ua: "uk-UA",
  de: "de-DE",
}

/** Format the voucher value buyer-facing: PLN → "260 zł" (whole amounts drop decimals). */
function formatVoucherValue(
  valueMinor: number,
  currencyCode: string,
  locale: VoucherPdfLocale,
): string {
  const value = valueMinor / 100
  const code = (currencyCode || "PLN").toUpperCase()
  const bcp47 = PDF_BCP47[locale] ?? "pl-PL"
  if (code === "PLN") {
    const whole = Math.round(value * 100) % 100 === 0
    const num = new Intl.NumberFormat(bcp47, {
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value)
    return `${num} zł`
  }
  try {
    return new Intl.NumberFormat(bcp47, { style: "currency", currency: code }).format(value)
  } catch {
    return `${value.toFixed(2)} ${code}`
  }
}

/**
 * Draw a vector QR encoding `text` into the box (x, y, box×box).
 *
 * Pure vector output — one filled rect per dark module (no PNG/raster, no
 * native deps). A white rounded panel + hairline frame + symmetric quiet
 * zone keep the symbol scannable on the cream background. The +0.4pt module
 * overlap closes sub-pixel seams some PDF rasterizers leave between cells.
 */
function drawVoucherQr(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  box: number,
): void {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" })
  const size = qr.modules.size
  const data = qr.modules.data
  const quiet = box * 0.09
  const cell = (box - quiet * 2) / size

  // White panel + hairline frame (scannable contrast on cream).
  doc
    .roundedRect(x, y, box, box, 8)
    .lineWidth(1)
    .fillAndStroke(PDF_BRAND.card, PDF_BRAND.hairline)

  doc.fillColor(PDF_BRAND.ink)
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (data[r * size + c]) {
        doc.rect(x + quiet + c * cell, y + quiet + r * cell, cell + 0.4, cell + 0.4).fill()
      }
    }
  }
}

export function renderVoucherPdf(payload: VoucherPdfPayload): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const locale = payload.locale
    const chunks: Buffer[] = []

    // margin:0 — we paint a full-bleed cream background and lay out by hand.
    const doc = new PDFDocument({ margin: 0, size: "A4" })

    doc.on("data", (chunk: Buffer) => chunks.push(chunk))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    const W = doc.page.width
    const H = doc.page.height
    const M = 48
    const cw = W - 2 * M

    // Cream background (contract A page-bg).
    doc.rect(0, 0, W, H).fill(PDF_BRAND.cream)

    // Brand lockup — gold "BB" monogram + wordmark.
    doc.roundedRect(M, 50, 34, 34, 9).fill(PDF_BRAND.gold)
    doc
      .fillColor(PDF_BRAND.cream)
      .font("Helvetica-Bold")
      .fontSize(15)
      .text("BB", M, 60, { width: 34, align: "center" })
    doc
      .fillColor(PDF_BRAND.ink)
      .font("Helvetica-Bold")
      .fontSize(16)
      .text("BonBeauty", M + 44, 60)
    doc
      .moveTo(M, 102)
      .lineTo(W - M, 102)
      .lineWidth(1)
      .stroke(PDF_BRAND.hairline)

    // Title (i18n).
    doc
      .fillColor(PDF_BRAND.ink)
      .font("Helvetica-Bold")
      .fontSize(26)
      .text(lookupCopy(locale, "title"), M, 132, { width: cw })

    // ── Main voucher card ──────────────────────────────────────────────
    const cardY = 184
    const cardH = 322
    doc
      .roundedRect(M, cardY, cw, cardH, 18)
      .lineWidth(1)
      .fillAndStroke(PDF_BRAND.card, PDF_BRAND.hairline)

    const px = M + 28
    const pw = cw - 56
    let y = cardY + 28

    // Scannable QR (encodes the voucher code) — top-right of the card. The
    // salon/service text block below is narrowed to `topW` to clear it.
    const qrSize = 100
    const qrX = M + cw - 28 - qrSize
    const qrY = cardY + 28
    drawVoucherQr(doc, payload.voucher_code, qrX, qrY, qrSize)
    doc
      .fillColor(PDF_BRAND.muted)
      .font("Helvetica")
      .fontSize(8)
      .text(lookupCopy(locale, "scan_to_redeem"), qrX, qrY + qrSize + 5, {
        width: qrSize,
        align: "center",
      })
    const topW = pw - qrSize - 22

    // Salon (FM-43: exactly ONE salon section per PDF).
    doc
      .fillColor(PDF_BRAND.bronze)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(lookupCopy(locale, "salon_section_title").toUpperCase(), px, y, { characterSpacing: 1.5 })
    y += 16
    doc.fillColor(PDF_BRAND.ink).font("Helvetica-Bold").fontSize(18).text(payload.vendor.name, px, y, { width: topW })
    y = doc.y + 2
    doc.fillColor(PDF_BRAND.muted).font("Helvetica").fontSize(11).text(`@${payload.vendor.handle}`, px, y, { width: topW })
    y = doc.y + 12

    // Service (may wrap → advance by the actual rendered height).
    doc.fillColor(PDF_BRAND.ink).font("Helvetica").fontSize(13).text(payload.service_description, px, y, { width: topW })
    y = doc.y + 14
    // Never let the value/code box ride up under the QR block.
    y = Math.max(y, qrY + qrSize + 22)

    // Value — large gold figure.
    doc
      .fillColor(PDF_BRAND.gold)
      .font("Helvetica-Bold")
      .fontSize(38)
      .text(formatVoucherValue(payload.value_minor, payload.currency_code, locale), px, y)
    y = doc.y + 12

    // Redemption code box (gold tint).
    const codeBoxH = 58
    doc
      .roundedRect(px, y, pw, codeBoxH, 10)
      .lineWidth(1)
      .fillAndStroke(PDF_BRAND.tint, PDF_BRAND.hairline)
    doc
      .fillColor(PDF_BRAND.bronze)
      .font("Helvetica-Bold")
      .fontSize(8)
      .text(lookupCopy(locale, "redemption_code_label").toUpperCase(), px + 16, y + 12, { characterSpacing: 1.5 })
    doc
      .fillColor(PDF_BRAND.ink)
      .font("Helvetica-Bold")
      .fontSize(19)
      .text(payload.voucher_code, px + 16, y + 26, { characterSpacing: 2 })
    y += codeBoxH + 16

    // Validity.
    if (payload.valid_until) {
      doc
        .fillColor(PDF_BRAND.muted)
        .font("Helvetica")
        .fontSize(11)
        .text(`${lookupCopy(locale, "validity_period_label")}: ${payload.valid_until}`, px, y)
    }

    // ── Below the card ─────────────────────────────────────────────────
    let by = cardY + cardH + 22

    // Buyer note — italic, gold-accented tinted strip.
    if (payload.buyer_note) {
      const noteH = 58
      doc.roundedRect(M, by, cw, noteH, 12).lineWidth(1).fillAndStroke(PDF_BRAND.noteBg, PDF_BRAND.hairline)
      doc.rect(M, by, 4, noteH).fill(PDF_BRAND.gold)
      doc
        .fillColor(PDF_BRAND.muted)
        .font("Helvetica-Oblique")
        .fontSize(12)
        .text(payload.buyer_note, M + 22, by + 19, { width: cw - 44 })
      by += noteH + 20
    }

    // Directions (Story v160-6-5; AR45-safe — vendor-side only).
    const directions = renderDirectionsSection(payload)
    if (directions.length > 0) {
      doc
        .fillColor(PDF_BRAND.bronze)
        .font("Helvetica-Bold")
        .fontSize(10)
        .text(lookupCopy(locale, "directions_title"), M, by, { characterSpacing: 1 })
      by += 18
      doc.fillColor(PDF_BRAND.muted).font("Helvetica").fontSize(9.5)
      for (const line of directions.slice(1)) {
        if (line === "") {
          by += 5
        } else {
          doc.text(line, M, by, { width: cw })
          by += 13
        }
      }
    }

    // Footer — hairline + brand mark.
    doc
      .moveTo(M, H - 64)
      .lineTo(W - M, H - 64)
      .lineWidth(1)
      .stroke(PDF_BRAND.hairline)
    doc
      .fillColor(PDF_BRAND.bronze)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text("BonBeauty", M, H - 52, { width: cw, align: "right" })

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
