/**
 * Story v160-6-2: Multi-vendor PDF voucher unit tests.
 *
 * Locks down the AR45 privacy boundary contract + FM-43 per-vendor isolation
 * invariant for the stub-tier PDF generator. When ADR-070 engine swap-in
 * lands (Story 6.x), augment this file with `pdf-parse` extraction tests
 * but keep the assertions stable.
 */

import {
  buildVoucherPdfPayload,
  dispatchMultiVendorPdfs,
  groupLineItemsByVendor,
  renderDirectionsSection,
  renderVoucherPdfStub,
  buildVoucherPdfStorageKey,
  lookupCopy,
  VOUCHER_PDF_COPY,
  type CartLineItemForVoucher,
  type VendorRecord,
  type VoucherPdfLocale,
} from "../../modules/voucher-delivery/multi-vendor-pdf"

describe("voucher-delivery/multi-vendor-pdf", () => {
  const vendor_a: VendorRecord = {
    id: "ven_a",
    name: "Salon Anna Beauty",
    handle: "anna-beauty-warszawa",
    address: "ul. Marszałkowska 1, 00-001 Warszawa",
    photo_url: null,
  }
  const vendor_b: VendorRecord = {
    id: "ven_b",
    name: "Salon Beata Studio",
    handle: "beata-studio-krakow",
    address: "ul. Floriańska 2, 31-019 Kraków",
    photo_url: null,
  }

  const line_items: CartLineItemForVoucher[] = [
    {
      id: "li_1",
      product_title: "Manicure hybrydowy",
      service_description: "Manicure hybrydowy 60 min",
      metadata: { selected_seller_id: "ven_a", selected_seller_name: "Salon Anna Beauty" },
      unit_price: 15000, // 150 PLN
      quantity: 1,
    },
    {
      id: "li_2",
      product_title: "Strzyżenie damskie",
      service_description: "Strzyżenie damskie + modelowanie",
      metadata: { selected_seller_id: "ven_b", selected_seller_name: "Salon Beata Studio" },
      unit_price: 12000, // 120 PLN
      quantity: 1,
    },
  ]

  describe("groupLineItemsByVendor", () => {
    it("groups items by metadata.selected_seller_id (FM-43 isolation)", () => {
      const grouped = groupLineItemsByVendor(line_items)
      expect(grouped.get("ven_a")?.length).toBe(1)
      expect(grouped.get("ven_b")?.length).toBe(1)
    })

    it("places items WITHOUT selected_seller_id into _unassigned bucket", () => {
      const grouped = groupLineItemsByVendor([
        { id: "li_x", metadata: null, unit_price: 100, quantity: 1 },
      ])
      expect(grouped.get("_unassigned")?.length).toBe(1)
    })
  })

  describe("buildVoucherPdfPayload — AR45 privacy boundary", () => {
    it("only includes allowlisted public fields (no buyer/recipient PII)", () => {
      const payload = buildVoucherPdfPayload({
        voucher_code: "ABC-123",
        locale: "pl",
        vendor: vendor_a,
        line_items: [line_items[0]!],
      })

      // Positive list (AC4 must-have).
      expect(payload.voucher_code).toBe("ABC-123")
      expect(payload.vendor.name).toBe(vendor_a.name)
      expect(payload.vendor.handle).toBe(vendor_a.handle)
      expect(payload.vendor.address).toBe(vendor_a.address)
      expect(payload.service_description).toBe("Manicure hybrydowy 60 min")
      expect(payload.value_minor).toBe(15000)

      // Negative list (AC4 must-not-have) — type-level guarantee:
      // the VoucherPdfPayload type does NOT include recipient_email,
      // recipient_phone, buyer_email, buyer_phone, buyer_address.
      const json = JSON.stringify(payload)
      expect(json).not.toMatch(/recipient_email/i)
      expect(json).not.toMatch(/recipient_phone/i)
      expect(json).not.toMatch(/buyer_email/i)
      expect(json).not.toMatch(/buyer_phone/i)
      expect(json).not.toMatch(/buyer_address/i)
    })
  })

  describe("renderVoucherPdfStub — text extraction parity", () => {
    it("includes vendor + voucher data, excludes PII substrings", () => {
      const payload = buildVoucherPdfPayload({
        voucher_code: "ABC-123",
        locale: "pl",
        vendor: vendor_a,
        line_items: [line_items[0]!],
        valid_until: "2026-12-31",
      })
      const pdf = renderVoucherPdfStub(payload)
      const text = pdf.toString("utf-8")

      expect(text).toContain("ABC-123")
      expect(text).toContain(vendor_a.name)
      expect(text).toContain(vendor_a.handle)
      expect(text).toContain("Manicure hybrydowy 60 min")
      expect(text).toContain("150.00 PLN")
      expect(text).toContain("2026-12-31")

      // PII negative assertion (AC4 — DOM/text grep parity).
      expect(text).not.toMatch(/ania@example\.com/i)
      expect(text).not.toMatch(/marta@example\.com/i)
      expect(text).not.toMatch(/\+48\s?\d{9}/)
    })
  })

  describe("dispatchMultiVendorPdfs — FM-43 isolation invariant", () => {
    it("produces 2 distinct PDFs for 2 vendors (per-vendor isolation)", () => {
      const dispatches = dispatchMultiVendorPdfs({
        voucher_id: "vch_1",
        voucher_code: "ABC-123",
        locale: "pl",
        line_items,
        vendors_by_id: { ven_a: vendor_a, ven_b: vendor_b },
      })

      expect(dispatches.length).toBe(2)

      const pdf_a = dispatches.find(d => d.vendor_id === "ven_a")
      const pdf_b = dispatches.find(d => d.vendor_id === "ven_b")
      expect(pdf_a).toBeDefined()
      expect(pdf_b).toBeDefined()

      const text_a = pdf_a!.pdf_buffer.toString("utf-8")
      const text_b = pdf_b!.pdf_buffer.toString("utf-8")

      // Cross-isolation: vendor A PDF MUST NOT mention vendor B and vice versa.
      expect(text_a).toContain(vendor_a.name)
      expect(text_a).not.toContain(vendor_b.name)
      expect(text_b).toContain(vendor_b.name)
      expect(text_b).not.toContain(vendor_a.name)
    })

    it("storage keys are deterministic per voucher+vendor", () => {
      expect(buildVoucherPdfStorageKey("vch_1", "ven_a")).toBe(
        "vouchers/vch_1/seller-ven_a.pdf",
      )
    })

    it("skips _unassigned items (legacy single-vendor flow)", () => {
      const dispatches = dispatchMultiVendorPdfs({
        voucher_id: "vch_2",
        voucher_code: "XYZ-789",
        locale: "en",
        line_items: [
          { id: "li_x", metadata: null, unit_price: 100, quantity: 1 },
        ],
        vendors_by_id: {},
      })
      expect(dispatches.length).toBe(0)
    })
  })

  // Story v160-6-5: post-claim directions section
  describe("renderDirectionsSection — Story v160-6-5", () => {
    const vendor_with_coords: VendorRecord = {
      ...vendor_a,
      lat: 52.2297,
      lng: 21.0122,
    }

    it("renders title + address + Google + Apple deeplinks + privacy notice when coords present", () => {
      const payload = buildVoucherPdfPayload({
        voucher_code: "ABC-123",
        locale: "pl",
        vendor: vendor_with_coords,
        line_items: [line_items[0]!],
      })
      const lines = renderDirectionsSection(payload)
      const text = lines.join("\n")

      expect(text).toContain("Jak dojechać")
      expect(text).toContain("Adres:")
      expect(text).toContain(vendor_a.address)
      expect(text).toContain("Google Maps:")
      expect(text).toContain("Apple Maps:")
      expect(text).toContain("https://www.google.com/maps/dir/?api=1")
      expect(text).toContain("https://maps.apple.com/")
      expect(text).toContain("opuszczasz BonBeauty")
    })

    it("falls back to search-query deeplinks when coords absent but address present", () => {
      const payload = buildVoucherPdfPayload({
        voucher_code: "ABC-123",
        locale: "en",
        vendor: vendor_a, // no lat/lng
        line_items: [line_items[0]!],
      })
      const lines = renderDirectionsSection(payload)
      const text = lines.join("\n")

      expect(text).toContain("How to get there")
      expect(text).toContain("https://www.google.com/maps/search/?api=1&query=")
      expect(text).toContain("https://maps.apple.com/?q=")
      expect(text).toContain("Coordinates not available")
      expect(text).toContain("BonBeauty does not share")
    })

    it("returns empty array when neither coords nor address present (defensive skip)", () => {
      const payload = buildVoucherPdfPayload({
        voucher_code: "ABC-123",
        locale: "pl",
        vendor: { id: "ven_x", name: "Salon X", handle: "salon-x" },
        line_items: [line_items[0]!],
      })
      expect(renderDirectionsSection(payload)).toEqual([])
    })

    it("AR45: rendered text contains zero buyer/recipient PII substrings", () => {
      const payload = buildVoucherPdfPayload({
        voucher_code: "ABC-123",
        locale: "pl",
        vendor: vendor_with_coords,
        line_items: [line_items[0]!],
        buyer_note: "Wesołych urodzin Aniu!",
      })
      const pdf = renderVoucherPdfStub(payload)
      const text = pdf.toString("utf-8")

      // Positive — directions section present (AC1).
      expect(text).toContain("Jak dojechać")
      expect(text).toContain("https://www.google.com/maps/dir/?api=1")

      // Negative AR45 — no buyer-side identifiers leak into the artifact.
      expect(text).not.toMatch(/recipient_email/i)
      expect(text).not.toMatch(/recipient_name/i)
      expect(text).not.toMatch(/recipient_phone/i)
      expect(text).not.toMatch(/buyer_email/i)
      expect(text).not.toMatch(/buyer_phone/i)
      expect(text).not.toMatch(/buyer_address/i)
      expect(text).not.toMatch(/gift_message/i)
    })
  })

  // ---------------------------------------------------------------------------
  // Story v160-cleanup-35: i18n 4-locale parity + fail-fast missing-key guard
  // AC5: per-locale rendering + missing-key throws
  // ---------------------------------------------------------------------------
  describe("i18n 4-locale parity — Story v160-cleanup-35 (AC5)", () => {
    const TRACKED_KEYS = [
      "title",
      "salon_section_title",
      "redemption_code_label",
      "validity_period_label",
      "voucher_value_label",
      "service_description_label",
      "directions_title",
      "directions_address_label",
      "directions_google_label",
      "directions_apple_label",
      "directions_no_coords_helper",
      "directions_privacy_notice",
    ] as const

    const LOCALES: VoucherPdfLocale[] = ["pl", "en", "ua", "de"]

    it.each(LOCALES)("lookupCopy returns non-empty string for all tracked keys in locale %s", (locale) => {
      for (const key of TRACKED_KEYS) {
        const value = lookupCopy(locale, key)
        expect(typeof value).toBe("string")
        expect(value.trim().length).toBeGreaterThan(0)
      }
    })

    it.each(LOCALES)("renderVoucherPdfStub renders locale %s without throwing", (locale) => {
      const payload = buildVoucherPdfPayload({
        voucher_code: "TEST-" + locale.toUpperCase(),
        locale,
        vendor: {
          id: "ven_test",
          name: "Test Salon",
          handle: "test-salon",
          address: "ul. Testowa 1, 00-001 Warszawa",
        },
        line_items: [
          {
            id: "li_test",
            product_title: "Test service",
            service_description: "Test service 60 min",
            metadata: { selected_seller_id: "ven_test", selected_seller_name: "Test Salon" },
            unit_price: 10000,
            quantity: 1,
          },
        ],
        valid_until: "2027-12-31",
      })
      const pdf = renderVoucherPdfStub(payload)
      const text = pdf.toString("utf-8")

      // Each locale PDF must contain the voucher code (locale-agnostic data).
      expect(text).toContain("TEST-" + locale.toUpperCase())
      // Each locale must have non-empty content (not a blank stub).
      expect(text.length).toBeGreaterThan(50)
    })

    it.each(LOCALES)(
      "renderVoucherPdfStub for locale %s includes locale-specific strings (not EN fallback)",
      (locale) => {
        const payload = buildVoucherPdfPayload({
          voucher_code: "LOCALE-CHECK",
          locale,
          vendor: {
            id: "ven_locale",
            name: "Locale Salon",
            handle: "locale-salon",
            address: "ul. Lokalna 1",
          },
          line_items: [
            {
              id: "li_lc",
              product_title: "Service",
              service_description: "Service",
              metadata: { selected_seller_id: "ven_locale", selected_seller_name: "Locale Salon" },
              unit_price: 5000,
              quantity: 1,
            },
          ],
        })
        const pdf = renderVoucherPdfStub(payload)
        const text = pdf.toString("utf-8")

        // Assert locale-specific title (not hardcoded EN)
        const expectedTitle = VOUCHER_PDF_COPY[locale]["title"]
        expect(text).toContain(expectedTitle)

        // Assert locale-specific voucher value label
        const expectedValueLabel = VOUCHER_PDF_COPY[locale]["voucher_value_label"]
        expect(text).toContain(expectedValueLabel)

        // Regression guard: UA and DE must not contain EN-only strings (no silent fallback)
        if (locale === "ua") {
          expect(text).not.toContain("BonBeauty voucher")  // EN title
          expect(text).not.toContain("Voucher value")       // EN value label
        }
        if (locale === "de") {
          expect(text).not.toContain("BonBeauty voucher")  // EN title
          expect(text).not.toContain("Voucher value")       // EN value label
        }
      },
    )

    it("lookupCopy throws fail-fast for missing key — no silent fallback to EN or undefined", () => {
      // Patch VOUCHER_PDF_COPY.pl to simulate a missing key scenario
      const originalPl = { ...VOUCHER_PDF_COPY.pl }
      // @ts-expect-error: intentionally corrupting for test
      delete VOUCHER_PDF_COPY.pl["voucher_value_label"]

      try {
        expect(() => lookupCopy("pl", "voucher_value_label")).toThrow(
          /missing voucher PDF i18n key: voucher_value_label for locale pl/,
        )
      } finally {
        // Restore to avoid polluting other tests
        VOUCHER_PDF_COPY.pl["voucher_value_label"] = originalPl["voucher_value_label"]!
      }
    })

    it("lookupCopy throws fail-fast for empty string value — regression guard", () => {
      // Temporarily set a key to empty string to simulate empty translation
      const originalEn = VOUCHER_PDF_COPY.en["title"]
      VOUCHER_PDF_COPY.en["title"] = "   "  // whitespace-only = empty after trim

      try {
        expect(() => lookupCopy("en", "title")).toThrow(
          /missing voucher PDF i18n key: title for locale en/,
        )
      } finally {
        VOUCHER_PDF_COPY.en["title"] = originalEn
      }
    })

    it("renderDirectionsSection uses locale-specific strings for ua locale", () => {
      const payload = buildVoucherPdfPayload({
        voucher_code: "UA-DIR-TEST",
        locale: "ua",
        vendor: {
          id: "ven_ua",
          name: "Ukrainian Salon",
          handle: "ukrainian-salon",
          address: "вул. Тестова 1, Київ",
          lat: 50.4501,
          lng: 30.5234,
        },
        line_items: [
          {
            id: "li_ua",
            product_title: "Service",
            service_description: "Service",
            metadata: { selected_seller_id: "ven_ua" },
            unit_price: 5000,
            quantity: 1,
          },
        ],
      })
      const lines = renderDirectionsSection(payload)
      const text = lines.join("\n")

      // UA directions title in Cyrillic
      expect(text).toContain(VOUCHER_PDF_COPY["ua"]["directions_title"])
      // UA address label in Cyrillic
      expect(text).toContain(VOUCHER_PDF_COPY["ua"]["directions_address_label"])
      // Must NOT contain EN fallback strings
      expect(text).not.toContain("How to get there")
    })

    it("renderDirectionsSection uses locale-specific strings for de locale", () => {
      const payload = buildVoucherPdfPayload({
        voucher_code: "DE-DIR-TEST",
        locale: "de",
        vendor: {
          id: "ven_de",
          name: "German Salon",
          handle: "german-salon",
          address: "Musterstraße 1, Berlin",
          // no coords — test search fallback
        },
        line_items: [
          {
            id: "li_de",
            product_title: "Service",
            service_description: "Service",
            metadata: { selected_seller_id: "ven_de" },
            unit_price: 5000,
            quantity: 1,
          },
        ],
      })
      const lines = renderDirectionsSection(payload)
      const text = lines.join("\n")

      // DE directions title
      expect(text).toContain(VOUCHER_PDF_COPY["de"]["directions_title"])
      // DE no-coords helper
      expect(text).toContain(VOUCHER_PDF_COPY["de"]["directions_no_coords_helper"])
      // Must NOT contain EN fallback strings
      expect(text).not.toContain("How to get there")
      expect(text).not.toContain("Coordinates not available")
    })
  })
})
