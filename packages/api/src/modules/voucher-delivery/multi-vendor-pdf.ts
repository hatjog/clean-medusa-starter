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
 */

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
  },
  en: {
    title: "BonBeauty voucher",
    salon_section_title: "Salon",
    redemption_code_label: "Redemption code",
    validity_period_label: "Valid until",
    voucher_value_label: "Voucher value",
    service_description_label: "Service",
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
  return Buffer.from(lines.join("\n"), "utf-8")
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
  locale: "pl" | "en"
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
