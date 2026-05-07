/**
 * multi-vendor-pdf.test.ts — AC4(d,e): engine swap PDF magic bytes + multi-vendor
 * 2-PDF generation + backwards compat (cleanup-52 / TF-117).
 *
 * Covers:
 *   (d) renderVoucherPdf() output starts with %PDF- magic bytes (0x25 0x50 0x44 0x46 0x2D)
 *   (d) 2-vendor cart → 2 distinct PDFs each containing single vendor section
 *   (e) MultiVendorPdfDispatch shape unchanged — typecheck passes; sync wrapper present
 *
 * STAGING-FREE (AC5): no external services; pdfkit runs entirely in-process.
 */

import { describe, expect, test } from "@jest/globals";
import { inflateSync } from "node:zlib";

import {
  buildVoucherPdfPayload,
  buildVoucherPdfStorageKey,
  dispatchMultiVendorPdfs,
  dispatchMultiVendorPdfsAsync,
  renderVoucherPdf,
  renderVoucherPdfStub,
  groupLineItemsByVendor,
  type CartLineItemForVoucher,
  type MultiVendorPdfDispatch,
  type VendorRecord,
} from "../multi-vendor-pdf";

/**
 * Extract text from a pdfkit-generated PDF buffer.
 *
 * pdfkit encodes text as hex strings inside compressed streams (FlateDecode).
 * This helper decompresses each stream and decodes hex-encoded text segments
 * from PDF text operators (TJ / Tj).
 */
function extractTextFromPdfBuffer(buf: Buffer): string {
  const raw = buf.toString("binary");
  const texts: string[] = [];
  let pos = 0;

  while (true) {
    // Find next "stream\n" marker.
    const streamIdx = raw.indexOf("stream\n", pos);
    if (streamIdx < 0) break;
    const endStreamIdx = raw.indexOf("endstream", streamIdx);
    if (endStreamIdx < 0) break;

    const streamContent = buf.slice(streamIdx + 7, endStreamIdx);
    try {
      const decompressed = inflateSync(streamContent).toString("latin1");
      // Match hex-encoded text segments: <hexhex>
      const hexMatches = decompressed.matchAll(/<([0-9a-fA-F]+)>/g);
      for (const match of hexMatches) {
        const hex = match[1];
        if (hex && hex.length % 2 === 0) {
          texts.push(Buffer.from(hex, "hex").toString("utf-8"));
        }
      }
    } catch {
      // Not a compressed stream (e.g. font data) — skip.
    }

    pos = endStreamIdx + 9;
  }

  return texts.join("");
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VENDOR_A: VendorRecord = {
  id: "seller_A",
  name: "Salon Alfa",
  handle: "salon-alfa",
  address: "ul. Marszałkowska 1, Warszawa",
};

const VENDOR_B: VendorRecord = {
  id: "seller_B",
  name: "Salon Beta",
  handle: "salon-beta",
  address: "ul. Floriańska 2, Kraków",
};

const ITEMS_A: CartLineItemForVoucher[] = [
  {
    id: "item_1",
    product_title: "Manicure Klasyczny",
    service_description: "Manicure Klasyczny",
    unit_price: 5000,
    quantity: 1,
    metadata: { selected_seller_id: "seller_A" },
  },
];

const ITEMS_B: CartLineItemForVoucher[] = [
  {
    id: "item_2",
    product_title: "Strzyżenie damskie",
    service_description: "Strzyżenie damskie",
    unit_price: 8000,
    quantity: 1,
    metadata: { selected_seller_id: "seller_B" },
  },
];

const ALL_ITEMS: CartLineItemForVoucher[] = [...ITEMS_A, ...ITEMS_B];

const VENDORS_BY_ID: Record<string, VendorRecord> = {
  seller_A: VENDOR_A,
  seller_B: VENDOR_B,
};

// ---------------------------------------------------------------------------
// AC4(d) — PDF magic bytes
// ---------------------------------------------------------------------------

describe("renderVoucherPdf — real PDF engine (pdfkit)", () => {
  test("output starts with %PDF- magic header bytes", async () => {
    const payload = buildVoucherPdfPayload({
      voucher_code: "VOUCHER-TEST-001",
      locale: "pl",
      vendor: VENDOR_A,
      line_items: ITEMS_A,
    });
    const buf = await renderVoucherPdf(payload);
    // Magic: 0x25 0x50 0x44 0x46 0x2D ('%PDF-')
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  test("output is a Buffer (not string)", async () => {
    const payload = buildVoucherPdfPayload({
      voucher_code: "VOUCHER-TEST-002",
      locale: "en",
      vendor: VENDOR_B,
      line_items: ITEMS_B,
    });
    const buf = await renderVoucherPdf(payload);
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  test("output contains vendor handle (text-extractable from PDF streams)", async () => {
    const payload = buildVoucherPdfPayload({
      voucher_code: "VOUCHER-EXT-003",
      locale: "pl",
      vendor: VENDOR_A,
      line_items: ITEMS_A,
    });
    const buf = await renderVoucherPdf(payload);
    const text = extractTextFromPdfBuffer(buf);
    expect(text).toContain("salon-alfa");
  });

  test("output contains voucher code (text-extractable from PDF streams)", async () => {
    const code = "V-MAGIC-XYZ";
    const payload = buildVoucherPdfPayload({
      voucher_code: code,
      locale: "en",
      vendor: VENDOR_A,
      line_items: ITEMS_A,
    });
    const buf = await renderVoucherPdf(payload);
    const text = extractTextFromPdfBuffer(buf);
    expect(text).toContain(code);
  });
});

// ---------------------------------------------------------------------------
// AC4(d) — 2-vendor cart → 2 distinct PDFs
// ---------------------------------------------------------------------------

describe("dispatchMultiVendorPdfsAsync — FM-43 multi-vendor 2 distinct PDFs", () => {
  test("2-vendor cart produces 2 dispatch entries", async () => {
    const dispatches = await dispatchMultiVendorPdfsAsync({
      voucher_id: "v_001",
      voucher_code: "VOUCHER-MV-001",
      locale: "pl",
      line_items: ALL_ITEMS,
      vendors_by_id: VENDORS_BY_ID,
    });
    expect(dispatches).toHaveLength(2);
  });

  test("each dispatch has a distinct storage_key", async () => {
    const dispatches = await dispatchMultiVendorPdfsAsync({
      voucher_id: "v_001",
      voucher_code: "VOUCHER-MV-002",
      locale: "pl",
      line_items: ALL_ITEMS,
      vendors_by_id: VENDORS_BY_ID,
    });
    const keys = dispatches.map((d) => d.storage_key);
    expect(new Set(keys).size).toBe(2);
  });

  test("each PDF buffer starts with %PDF- magic bytes", async () => {
    const dispatches = await dispatchMultiVendorPdfsAsync({
      voucher_id: "v_001",
      voucher_code: "VOUCHER-MV-003",
      locale: "pl",
      line_items: ALL_ITEMS,
      vendors_by_id: VENDORS_BY_ID,
    });
    for (const d of dispatches) {
      expect(d.pdf_buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    }
  });

  test("each PDF contains only its vendor's handle (FM-43 isolation)", async () => {
    const dispatches = await dispatchMultiVendorPdfsAsync({
      voucher_id: "v_001",
      voucher_code: "VOUCHER-MV-004",
      locale: "pl",
      line_items: ALL_ITEMS,
      vendors_by_id: VENDORS_BY_ID,
    });
    const dispatchA = dispatches.find((d) => d.vendor_id === "seller_A")!;
    const dispatchB = dispatches.find((d) => d.vendor_id === "seller_B")!;

    const textA = extractTextFromPdfBuffer(dispatchA.pdf_buffer);
    const textB = extractTextFromPdfBuffer(dispatchB.pdf_buffer);

    // PDF A contains vendor A's handle but NOT vendor B's.
    expect(textA).toContain("salon-alfa");
    expect(textA).not.toContain("salon-beta");

    // PDF B contains vendor B's handle but NOT vendor A's.
    expect(textB).toContain("salon-beta");
    expect(textB).not.toContain("salon-alfa");
  });

  test("2 distinct pdf_buffer values (not the same blob)", async () => {
    const dispatches = await dispatchMultiVendorPdfsAsync({
      voucher_id: "v_001",
      voucher_code: "VOUCHER-MV-005",
      locale: "pl",
      line_items: ALL_ITEMS,
      vendors_by_id: VENDORS_BY_ID,
    });
    expect(dispatches[0]!.pdf_buffer).not.toEqual(dispatches[1]!.pdf_buffer);
  });
});

// ---------------------------------------------------------------------------
// AC4(e) — MultiVendorPdfDispatch shape backwards compat
// ---------------------------------------------------------------------------

describe("MultiVendorPdfDispatch backwards compat (AC4e)", () => {
  test("shape has vendor_id, storage_key, payload, pdf_buffer fields", () => {
    const dispatch: MultiVendorPdfDispatch = {
      vendor_id: "seller_A",
      storage_key: buildVoucherPdfStorageKey("v_001", "seller_A"),
      payload: buildVoucherPdfPayload({
        voucher_code: "V-COMPAT",
        locale: "pl",
        vendor: VENDOR_A,
        line_items: ITEMS_A,
      }),
      pdf_buffer: Buffer.from("%PDF-1.4 compat-test"),
    };
    expect(dispatch.vendor_id).toBe("seller_A");
    expect(dispatch.storage_key).toMatch(/seller_A/);
    expect(dispatch.payload.voucher_code).toBe("V-COMPAT");
    expect(Buffer.isBuffer(dispatch.pdf_buffer)).toBe(true);
  });

  test("sync dispatchMultiVendorPdfs still returns synchronously", () => {
    const result = dispatchMultiVendorPdfs({
      voucher_id: "v_002",
      voucher_code: "V-SYNC",
      locale: "pl",
      line_items: ALL_ITEMS,
      vendors_by_id: VENDORS_BY_ID,
    });
    // Sync wrapper must not return a Promise (instanceof check).
    expect(result instanceof Promise).toBe(false);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  test("renderVoucherPdfStub alias still exists and returns Buffer", () => {
    const payload = buildVoucherPdfPayload({
      voucher_code: "V-STUB-ALIAS",
      locale: "en",
      vendor: VENDOR_A,
      line_items: ITEMS_A,
    });
    const buf = renderVoucherPdfStub(payload);
    expect(Buffer.isBuffer(buf)).toBe(true);
    // Stub still returns text/plain (alias for backwards compat).
    expect(buf.toString("utf-8")).toContain("V-STUB-ALIAS");
  });
});

// ---------------------------------------------------------------------------
// Storage key contract
// ---------------------------------------------------------------------------

describe("buildVoucherPdfStorageKey", () => {
  test("deterministic per-vendor key format", () => {
    const key = buildVoucherPdfStorageKey("v_001", "seller_A");
    expect(key).toBe("vouchers/v_001/seller-seller_A.pdf");
  });

  test("groupLineItemsByVendor — unassigned bucket isolated", () => {
    const items: CartLineItemForVoucher[] = [
      { id: "x", unit_price: 100, quantity: 1, metadata: null },
    ];
    const grouped = groupLineItemsByVendor(items);
    expect(grouped.has("_unassigned")).toBe(true);
    expect(grouped.has("seller_A")).toBe(false);
  });
});
