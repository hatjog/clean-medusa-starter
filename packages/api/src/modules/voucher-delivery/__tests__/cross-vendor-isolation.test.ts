/**
 * cross-vendor-isolation.test.ts — AC4(b): FM-43 cross-vendor isolation
 * (cleanup-52 / TF-117).
 *
 * Verifies that storage artifacts for distinct vendors do NOT cross-contaminate:
 * - Distinct storage_key paths per vendor.
 * - retrieve(vendor_A_key) does NOT return vendor_B's pdf_buffer.
 *
 * STAGING-FREE (AC5): uses tmpdir per test for filesystem adapter.
 * PG adapter tested with in-memory Map-backed mock.
 */

import { describe, expect, test, beforeEach, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FilesystemVoucherPdfStorage } from "../storage/adapters/filesystem-storage";
import { PgVoucherPdfStorage } from "../storage/adapters/pg-storage";
import { buildVoucherPdfStorageKey } from "../multi-vendor-pdf";
import type { VoucherPdfMetadata } from "../storage/ports";

const PDF_A = Buffer.from("%PDF-1.4 vendor-a-content");
const PDF_B = Buffer.from("%PDF-1.4 vendor-b-content");

function metaFor(vendor_handle: string): VoucherPdfMetadata {
  return {
    delivery_id: "del_iso_001",
    recipient_token: "tok_iso_abc",
    generated_at: new Date().toISOString(),
    vendor_handles: [vendor_handle],
  };
}

// ---------------------------------------------------------------------------
// In-memory Knex mock for PgVoucherPdfStorage unit tests
// ---------------------------------------------------------------------------

function buildMockKnex() {
  const store = new Map<string, { pdf_buffer: Buffer; metadata: string }>();

  const makeQuery = (tableName: string) => {
    const q: Record<string, unknown> = {};
    let whereKey: string | undefined;

    q.where = (colOrObj: string | Record<string, string>, val?: string) => {
      if (typeof colOrObj === "object") {
        whereKey = colOrObj["storage_key"];
      } else if (colOrObj === "storage_key") {
        whereKey = val;
      }
      return q;
    };

    q.select = (..._cols: string[]) => q;

    q.first = async () => {
      if (!whereKey) return undefined;
      const row = store.get(whereKey);
      return row ?? undefined;
    };

    q.insert = (row: { storage_key: string; pdf_buffer: Buffer; metadata: string; stored_at: string; version: number; expires_at: string }) => {
      const insertQ: Record<string, unknown> = {};
      insertQ.onConflict = (_col: string) => {
        const conflictQ: Record<string, unknown> = {};
        conflictQ.merge = (updates: { pdf_buffer: Buffer; metadata: string }) => {
          store.set(row.storage_key, {
            pdf_buffer: updates.pdf_buffer ?? row.pdf_buffer,
            metadata: updates.metadata ?? row.metadata,
          });
          return Promise.resolve(undefined);
        };
        return conflictQ;
      };
      // Always store on plain insert too.
      store.set(row.storage_key, { pdf_buffer: row.pdf_buffer, metadata: row.metadata });
      return insertQ;
    };

    q.delete = async () => {
      if (whereKey) store.delete(whereKey);
      return 0;
    };

    tableName;
    return q;
  };

  const knex = (table: string) => makeQuery(table);
  knex.schema = {
    hasTable: async () => false,
    createTable: async (_n: string, _cb: unknown) => undefined,
  };
  knex.fn = { now: () => "NOW()" };
  knex.destroy = async () => undefined;
  knex._store = store;

  return knex;
}

// ---------------------------------------------------------------------------
// Filesystem adapter — cross-vendor isolation
// ---------------------------------------------------------------------------

describe("FilesystemVoucherPdfStorage — FM-43 cross-vendor isolation", () => {
  let tmpDir: string;
  let storage: FilesystemVoucherPdfStorage;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "voucher-iso-test-"));
    storage = new FilesystemVoucherPdfStorage(tmpDir, 90);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("2 vendors produce 2 distinct storage_key paths", () => {
    const keyA = buildVoucherPdfStorageKey("v_001", "seller_A");
    const keyB = buildVoucherPdfStorageKey("v_001", "seller_B");
    expect(keyA).not.toBe(keyB);
    expect(keyA).toContain("seller_A");
    expect(keyB).toContain("seller_B");
  });

  test("retrieve(vendor_A_key) does NOT return vendor B pdf_buffer", async () => {
    const keyA = buildVoucherPdfStorageKey("v_001", "seller_A");
    const keyB = buildVoucherPdfStorageKey("v_001", "seller_B");

    await storage.store({ storage_key: keyA, pdf_buffer: PDF_A, metadata: metaFor("salon-a") });
    await storage.store({ storage_key: keyB, pdf_buffer: PDF_B, metadata: metaFor("salon-b") });

    const artA = await storage.retrieve(keyA);
    const artB = await storage.retrieve(keyB);

    expect(artA!.pdf_buffer).toEqual(PDF_A);
    expect(artB!.pdf_buffer).toEqual(PDF_B);
    expect(artA!.pdf_buffer).not.toEqual(PDF_B);
    expect(artB!.pdf_buffer).not.toEqual(PDF_A);
  });

  test("vendor handles in metadata are per-vendor (single-element array per FM-43)", async () => {
    const keyA = buildVoucherPdfStorageKey("v_001", "seller_A");
    await storage.store({ storage_key: keyA, pdf_buffer: PDF_A, metadata: metaFor("salon-a") });
    const art = await storage.retrieve(keyA);
    expect(art!.metadata.vendor_handles).toHaveLength(1);
    expect(art!.metadata.vendor_handles[0]).toBe("salon-a");
  });

  test("purge removes only the target vendor's artifact", async () => {
    const keyA = buildVoucherPdfStorageKey("v_001", "seller_A");
    const keyB = buildVoucherPdfStorageKey("v_001", "seller_B");

    await storage.store({ storage_key: keyA, pdf_buffer: PDF_A, metadata: metaFor("salon-a") });
    await storage.store({ storage_key: keyB, pdf_buffer: PDF_B, metadata: metaFor("salon-b") });

    await storage.purge(keyA);

    expect(await storage.retrieve(keyA)).toBeNull();
    expect(await storage.retrieve(keyB)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PG adapter — cross-vendor isolation (in-memory mock)
// ---------------------------------------------------------------------------

describe("PgVoucherPdfStorage — FM-43 cross-vendor isolation (mock DB)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDb: any;
  let storage: PgVoucherPdfStorage;

  beforeEach(() => {
    mockDb = buildMockKnex();
    storage = new PgVoucherPdfStorage(mockDb, 90);
  });

  test("retrieve(vendor_A_key) does NOT return vendor B pdf_buffer", async () => {
    const keyA = buildVoucherPdfStorageKey("v_001", "seller_A");
    const keyB = buildVoucherPdfStorageKey("v_001", "seller_B");

    await storage.store({ storage_key: keyA, pdf_buffer: PDF_A, metadata: metaFor("salon-a") });
    await storage.store({ storage_key: keyB, pdf_buffer: PDF_B, metadata: metaFor("salon-b") });

    const artA = await storage.retrieve(keyA);
    const artB = await storage.retrieve(keyB);

    expect(artA!.pdf_buffer).toEqual(PDF_A);
    expect(artB!.pdf_buffer).toEqual(PDF_B);
    expect(artA!.pdf_buffer).not.toEqual(PDF_B);
    expect(artB!.pdf_buffer).not.toEqual(PDF_A);
  });

  test("purge removes only target vendor's artifact", async () => {
    const keyA = buildVoucherPdfStorageKey("v_001", "seller_A");
    const keyB = buildVoucherPdfStorageKey("v_001", "seller_B");

    await storage.store({ storage_key: keyA, pdf_buffer: PDF_A, metadata: metaFor("salon-a") });
    await storage.store({ storage_key: keyB, pdf_buffer: PDF_B, metadata: metaFor("salon-b") });

    await storage.purge(keyA);

    expect(await storage.retrieve(keyA)).toBeNull();
    expect(await storage.retrieve(keyB)).not.toBeNull();
  });
});
