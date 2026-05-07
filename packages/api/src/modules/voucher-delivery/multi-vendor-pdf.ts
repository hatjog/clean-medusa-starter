/**
 * Multi-vendor PDF voucher generator (cleanup-52 / TF-117: engine swap done).
 *
 * History:
 *   Story v160-6-2: shipped multi-vendor isolation contract (FM-43) + AR45
 *     privacy-boundary payload builder + renderVoucherPdfStub (text/plain).
 *   Story v160-6-5: appended directions section (maps-deeplink.ts helpers).
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
 *
 * Story v160-6-5 extension: post-claim directions section appended between
 * the voucher card + footer. Reuses `maps-deeplink.ts` helpers (ported from
 * storefront Story 4.5) for Google + Apple Maps deeplink URLs. Defensive
 * fallback to search-query mode when coordinates are absent. Privacy notice
 * mandatory (always rendered when section renders).
 */

import PDFDocument from "pdfkit"

import {
  buildAppleMapsDeeplink,
  buildGoogleMapsDeeplink,
  buildSearchFallbackDeeplink,
} from "./maps-deeplink"

// One-shot deprecation guards (review fix H3, M4).
let _warnedSyncDeprecated = false
let _warnedUnassignedSeen = false
function _warnOnce(flagSetter: (v: boolean) => void, flag: boolean, msg: string): void {
  if (flag) return
  flagSetter(true)
  // eslint-disable-next-line no-console
  console.warn(msg)
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
  /** Locale for backend-side translation lookup. */
  locale: "pl" | "en"
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

const T30_PDF_COPY = {
  pl: {
    title: "Voucher BonBeauty",
    salon_section_title: "Salon",
    redemption_code_label: "Kod realizacji",
    validity_period_label: "Ważność",
    voucher_value_label: "Wartość vouchera",
    service_description_label: "Usługa",
    directions_title: "Jak dojechać",
    directions_address_label: "Adres",
    directions_google_label: "Google Maps",
    directions_apple_label: "Apple Maps",
    directions_no_coords_helper:
      "Współrzędne nie są dostępne — link wyszukuje adres",
    directions_privacy_notice:
      "Klikając linki map zewnętrznych, opuszczasz BonBeauty. BonBeauty nie udostępnia Twoich danych zewnętrznym dostawcom map.",
  },
  en: {
    title: "BonBeauty voucher",
    salon_section_title: "Salon",
    redemption_code_label: "Redemption code",
    validity_period_label: "Valid until",
    voucher_value_label: "Voucher value",
    service_description_label: "Service",
    directions_title: "How to get there",
    directions_address_label: "Address",
    directions_google_label: "Google Maps",
    directions_apple_label: "Apple Maps",
    directions_no_coords_helper:
      "Coordinates not available — link searches address",
    directions_privacy_notice:
      "Clicking external map links, you leave BonBeauty. BonBeauty does not share your data with external map providers.",
  },
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
  locale: "pl" | "en"
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
 */
export function renderVoucherPdf(payload: VoucherPdfPayload): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const copy = T30_PDF_COPY[payload.locale] ?? T30_PDF_COPY.pl
    const chunks: Buffer[] = []

    const doc = new PDFDocument({ margin: 50, size: "A4" })

    doc.on("data", (chunk: Buffer) => chunks.push(chunk))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    // Title
    doc.fontSize(18).font("Helvetica-Bold").text(copy.title, { align: "center" })
    doc.moveDown(0.5)

    // Voucher code
    doc
      .fontSize(12)
      .font("Helvetica")
      .text(`${copy.redemption_code_label}: `, { continued: true })
      .font("Helvetica-Bold")
      .text(payload.voucher_code)
    doc.moveDown(0.8)

    // Salon section header (FM-43: exactly ONE salon section per PDF)
    doc
      .fontSize(13)
      .font("Helvetica-Bold")
      .text(`— ${copy.salon_section_title} —`)
    doc.font("Helvetica").fontSize(11)
    doc.text(payload.vendor.name)
    doc.text(`@${payload.vendor.handle}`)
    if (payload.vendor.address) {
      doc.text(payload.vendor.address)
    }
    doc.moveDown(0.5)

    // Service + value
    doc.text(`${copy.service_description_label}: ${payload.service_description}`)
    doc.text(
      `${copy.voucher_value_label}: ${(payload.value_minor / 100).toFixed(2)} ${payload.currency_code}`,
    )

    // Validity
    if (payload.valid_until) {
      doc.text(`${copy.validity_period_label}: ${payload.valid_until}`)
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
      doc.fontSize(12).font("Helvetica-Bold").text(`— ${copy.directions_title} —`)
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
 * @deprecated Use renderVoucherPdf() (async, real PDF) instead.
 *   Alias kept for v1.6.0 soft-rename window; removed in v1.7.0.
 *   Callers relying on PDF binary output MUST migrate to renderVoucherPdf().
 */
export function renderVoucherPdfStub(payload: VoucherPdfPayload): Buffer {
  const copy = T30_PDF_COPY[payload.locale] ?? T30_PDF_COPY.pl
  const lines: string[] = [
    `=== ${copy.title} ===`,
    "",
    `${copy.redemption_code_label}: ${payload.voucher_code}`,
    "",
    `--- ${copy.salon_section_title} ---`,
    `${payload.vendor.name}`,
    `@${payload.vendor.handle}`,
  ]
  if (payload.vendor.address) {
    lines.push(payload.vendor.address)
  }
  lines.push("", `${copy.service_description_label}: ${payload.service_description}`)
  lines.push(
    `${copy.voucher_value_label}: ${(payload.value_minor / 100).toFixed(2)} ${payload.currency_code}`,
  )
  if (payload.valid_until) {
    lines.push(`${copy.validity_period_label}: ${payload.valid_until}`)
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
 */
export function renderDirectionsSection(payload: VoucherPdfPayload): string[] {
  const copy = T30_PDF_COPY[payload.locale] ?? T30_PDF_COPY.pl
  const { vendor } = payload
  const hasCoords =
    typeof vendor.lat === "number" && typeof vendor.lng === "number"
  const hasAddress =
    typeof vendor.address === "string" && vendor.address.trim().length > 0

  // Skip section entirely if zero data — preserves clean layout.
  if (!hasCoords && !hasAddress) return []

  const lines: string[] = [`--- ${copy.directions_title} ---`]

  if (hasAddress) {
    lines.push(`${copy.directions_address_label}: ${vendor.address}`)
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
    lines.push(`${copy.directions_google_label}: ${googleUrl}`)
    lines.push(`${copy.directions_apple_label}: ${appleUrl}`)
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
    lines.push(`${copy.directions_google_label}: ${googleUrl}`)
    lines.push(`${copy.directions_apple_label}: ${appleUrl}`)
    lines.push(copy.directions_no_coords_helper)
  }

  // Privacy notice mandatory whenever section renders (AR45 + Story 4.5
  // web parity — leaving BonBeauty boundary disclosure).
  lines.push("", copy.directions_privacy_notice)

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
  locale: "pl" | "en"
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
  locale: "pl" | "en"
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
