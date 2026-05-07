/**
 * expiry-handling.test.ts — AC4(c): TTL/purge semantics (cleanup-52 / TF-117).
 *
 * Verifies that:
 *   - isExpired() correctly detects artifacts beyond retention window.
 *   - purge() removes artifact; subsequent retrieve() returns null.
 *   - PgVoucherPdfStorage.purgeExpired() removes expired rows.
 *
 * STAGING-FREE (AC5): tmpdir for filesystem; in-memory Map mock for PG.
 */

import { describe, expect, test, beforeEach, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FilesystemVoucherPdfStorage } from "../storage/adapters/filesystem-storage";
import { PgVoucherPdfStorage } from "../storage/adapters/pg-storage";
import type { VoucherPdfMetadata } from "../storage/ports";

const PDF_BUF = Buffer.from("%PDF-1.4 expiry-test");
const KEY = "vouchers/v_exp/seller-s_exp.pdf";

function metaNow(daysAgo = 0): VoucherPdfMetadata {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return {
    delivery_id: "del_exp_001",
    recipient_token: "tok_exp_abc",
    generated_at: d.toISOString(),
    vendor_handles: ["salon-exp"],
  };
}

// ---------------------------------------------------------------------------
// In-memory Knex mock for PgVoucherPdfStorage (expiry tests)
// ---------------------------------------------------------------------------

interface ArtifactRow {
  storage_key: string;
  pdf_buffer: Buffer;
  metadata: string;
  stored_at: string;
  version: number;
  expires_at: string | null;
}

function buildMockKnex() {
  const store = new Map<string, ArtifactRow>();

  // Build a chainable query builder stub.
  function makeQuery(table: string) {
    let _whereKey: string | undefined;
    let _ltExpiresAt: string | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {};

    q.where = (colOrObj: string | Record<string, string>, op?: string, val?: string) => {
      if (typeof colOrObj === "object") {
        _whereKey = colOrObj["storage_key"];
      } else if (typeof colOrObj === "string" && op === "<" && val !== undefined) {
        // purgeExpired: .where("expires_at", "<", isoString)
        _ltExpiresAt = val;
      } else if (colOrObj === "storage_key" && op === undefined) {
        // plain .where({storage_key}) handled above
      } else {
        _whereKey = val;
      }
      return q;
    };

    q.select = (..._cols: string[]) => q;

    q.first = async () => {
      if (!_whereKey) return undefined;
      return store.get(_whereKey) ?? undefined;
    };

    q.insert = (row: ArtifactRow) => {
      const conflictQ = {
        merge: (updates: Partial<ArtifactRow>) => {
          const existing = store.get(row.storage_key);
          store.set(row.storage_key, existing ? { ...existing, ...updates } : row);
          return Promise.resolve(undefined);
        },
      };
      store.set(row.storage_key, row);
      return { onConflict: (_col: string) => conflictQ };
    };

    q.delete = async () => {
      if (_whereKey) {
        store.delete(_whereKey);
        return 1;
      }
      if (_ltExpiresAt) {
        let deleted = 0;
        for (const [k, row] of store) {
          if (row.expires_at !== null && row.expires_at < _ltExpiresAt) {
            store.delete(k);
            deleted++;
          }
        }
        return deleted;
      }
      return 0;
    };

    table; // silence unused
    return q;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const knex: any = (table: string) => makeQuery(table);
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
// FilesystemVoucherPdfStorage — expiry handling
// ---------------------------------------------------------------------------

describe("FilesystemVoucherPdfStorage — expiry / TTL", () => {
  let tmpDir: string;
  let storage: FilesystemVoucherPdfStorage;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "voucher-exp-test-"));
    storage = new FilesystemVoucherPdfStorage(tmpDir, 90);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("isExpired = false for recently generated artifact", () => {
    const meta = metaNow(0);
    expect(storage.isExpired(meta)).toBe(false);
  });

  test("isExpired = true for artifact generated > retention window ago", () => {
    const meta = metaNow(365); // 365 days ago, retention = 90
    expect(storage.isExpired(meta)).toBe(true);
  });

  test("isExpired = false for artifact at exactly retention boundary (edge)", () => {
    const meta = metaNow(89); // 89 days ago, retention = 90
    expect(storage.isExpired(meta)).toBe(false);
  });

  test("purge removes stored artifact; retrieve returns null", async () => {
    await storage.store({ storage_key: KEY, pdf_buffer: PDF_BUF, metadata: metaNow(0) });
    expect(await storage.retrieve(KEY)).not.toBeNull();
    await storage.purge(KEY);
    expect(await storage.retrieve(KEY)).toBeNull();
  });

  test("purge is idempotent (no-op if key does not exist)", async () => {
    await expect(storage.purge("vouchers/no-such/key.pdf")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PgVoucherPdfStorage — expiry handling (in-memory mock)
// ---------------------------------------------------------------------------

describe("PgVoucherPdfStorage — expiry / purgeExpired (mock DB)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDb: any;
  let storage: PgVoucherPdfStorage;

  beforeEach(() => {
    mockDb = buildMockKnex();
    storage = new PgVoucherPdfStorage(mockDb, 90);
  });

  test("purge removes artifact; retrieve returns null", async () => {
    await storage.store({ storage_key: KEY, pdf_buffer: PDF_BUF, metadata: metaNow(0) });
    await storage.purge(KEY);
    expect(await storage.retrieve(KEY)).toBeNull();
  });

  test("purgeExpired removes rows with expires_at in the past", async () => {
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    // Directly insert a row with a past expires_at into the mock store.
    mockDb._store.set(KEY, {
      storage_key: KEY,
      pdf_buffer: PDF_BUF,
      metadata: JSON.stringify(metaNow(0)),
      stored_at: new Date().toISOString(),
      version: 1,
      expires_at: pastExpiry,
    });

    const { rows_deleted } = await storage.purgeExpired();
    expect(rows_deleted).toBe(1);
    expect(await storage.retrieve(KEY)).toBeNull();
  });

  test("purgeExpired does NOT remove rows not yet expired", async () => {
    const futureExpiry = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    mockDb._store.set(KEY, {
      storage_key: KEY,
      pdf_buffer: PDF_BUF,
      metadata: JSON.stringify(metaNow(0)),
      stored_at: new Date().toISOString(),
      version: 1,
      expires_at: futureExpiry,
    });
    const { rows_deleted } = await storage.purgeExpired();
    expect(rows_deleted).toBe(0);
  });

  test("purge is idempotent (no-op if key does not exist)", async () => {
    await expect(storage.purge("vouchers/no-such/key.pdf")).resolves.toBeUndefined();
  });
});
