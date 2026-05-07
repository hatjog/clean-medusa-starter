/**
 * filesystem-storage.ts — Filesystem adapter for IVoucherPdfStorage
 * (cleanup-52 / TF-117).
 *
 * Default backend for STAGING-FREE v1.6.0 (UX-DR108/ADR-066). Stores PDF
 * artifacts under a sandboxed root directory with per-vendor isolation:
 *
 *   ${VOUCHER_PDF_STORAGE_ROOT}/vouchers/${voucher_id}/seller-${seller_id}.pdf
 *   ${VOUCHER_PDF_STORAGE_ROOT}/vouchers/${voucher_id}/seller-${seller_id}.meta.json
 *
 * Writes are atomic: meta sidecar is renamed BEFORE the pdf binary so the
 * existsSync(meta) gate in retrieve() can never observe a PDF without its
 * metadata (review fix H2). On any failure the partial tmp/destination state
 * is cleaned up best-effort.
 *
 * FM-43 isolation: storage_key encodes vendor id in path — each vendor's
 * artifact lives in a distinct subpath; cross-vendor retrieve is impossible
 * with the correct per-vendor storage_key.
 *
 * AR45 privacy boundary: pdf_buffer content is generated upstream with
 * only public/vendor-side fields. metadata.recipient_token is opaque (non-PII).
 * This adapter never inspects pdf_buffer content — it treats it as an opaque
 * binary blob.
 *
 * getPresignedUrl: returns a token-based route stub for v1.6.0 dev
 * (format: `/store/voucher-pdf/{token}`). Token is HMAC-SHA256 signed via
 * the shared `storage/hmac.ts` helper (review fix M2).
 * Production KMS-backed signing deferred to v1.10.0+.
 *
 * @see TF-117, cleanup-52
 * @see cleanup-44 for adapter pattern reference
 */

import {
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import {
  buildSignedToken,
  getHmacSecret,
  verifySignedToken as verifySignedTokenShared,
} from "../hmac";
import type {
  IVoucherPdfStorage,
  StoredArtifact,
  StoreInput,
  StoreOutput,
  VoucherPdfMetadata,
} from "../ports";

/** Sidecar metadata stored next to the PDF blob (filesystem sidecar JSON). */
interface MetaSidecar {
  metadata: VoucherPdfMetadata;
  stored_at: string;
  version: number;
}

/** Default retention window (configurable via VOUCHER_PDF_RETENTION_DAYS). */
const DEFAULT_RETENTION_DAYS = 90;

/** Default presigned URL TTL in seconds (24 h). */
const DEFAULT_TTL_SECONDS = 86_400;

/** Optional logger contract (injected via constructor; loader-resolved). */
export interface StorageLogger {
  debug?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
}

/** Re-export shared verifier for backwards compat with v1.6.0 callers. */
export const verifySignedToken = verifySignedTokenShared;

export class FilesystemVoucherPdfStorage implements IVoucherPdfStorage {
  private readonly storageRoot: string;
  private readonly retentionDays: number;
  private readonly logger: StorageLogger | undefined;

  /**
   * @param storageRoot - Sandboxed root directory for PDF artifacts.
   *   Resolved from VOUCHER_PDF_STORAGE_ROOT env by the loader.
   * @param retentionDays - Retention window override (default 90 days).
   * @param logger - Optional logger for store/retrieve/purge debug events.
   */
  constructor(
    storageRoot: string,
    retentionDays?: number,
    logger?: StorageLogger,
  ) {
    this.storageRoot = storageRoot;
    const envDays = parseInt(process.env["VOUCHER_PDF_RETENTION_DAYS"] ?? "", 10);
    this.retentionDays =
      retentionDays ?? (Number.isFinite(envDays) && envDays > 0 ? envDays : DEFAULT_RETENTION_DAYS);
    this.logger = logger;
  }

  /**
   * Resolve absolute path for a storage_key, sandboxed to storageRoot.
   *
   * Path-traversal hardening:
   *   - Reject null bytes (POSIX path-injection vector).
   *   - Reject keys containing '..' segments (cross-platform).
   *   - Normalise leading separators to ensure join() doesn't reset to absolute.
   *   - After resolve(), assert the absolute path is still within storageRoot.
   *
   * @throws Error if storage_key escapes the sandbox or contains forbidden chars.
   */
  private pdfPath(storage_key: string): string {
    if (storage_key.includes("\0")) {
      throw new Error("[voucher-pdf-storage] storage_key contains null byte");
    }
    // Reject any '..' segment (handles ../  ..\  /../  etc.)
    const segments = storage_key.split(/[/\\]/);
    if (segments.some((s) => s === "..")) {
      throw new Error("[voucher-pdf-storage] storage_key contains '..' segment");
    }
    // Strip leading slashes to ensure join() doesn't reset to absolute.
    const safe = storage_key.replace(/^[/\\]+/, "");

    const resolvedRoot = resolve(this.storageRoot);
    const resolvedTarget = resolve(this.storageRoot, safe);

    // Assert containment: the resolved target MUST start with the root + sep
    // (or equal the root itself). Otherwise the key escaped via symlink/etc.
    const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(rootWithSep)) {
      throw new Error(
        `[voucher-pdf-storage] storage_key escapes sandbox root: ${storage_key}`,
      );
    }
    return resolvedTarget;
  }

  private metaPath(storage_key: string): string {
    return this.pdfPath(storage_key) + ".meta.json";
  }

  async store(input: StoreInput): Promise<StoreOutput> {
    const pdfDest = this.pdfPath(input.storage_key);
    const metaDest = this.metaPath(input.storage_key);
    const tmpPdf = pdfDest + ".tmp";
    const tmpMeta = metaDest + ".tmp";

    await mkdir(dirname(pdfDest), { recursive: true });

    const stored_at = new Date().toISOString();
    const version = 1; // v1.6.0: single-version model (overwrites on re-store)

    const sidecar: MetaSidecar = {
      metadata: input.metadata,
      stored_at,
      version,
    };

    // Write tmp files first.
    try {
      await writeFile(tmpPdf, input.pdf_buffer);
      await writeFile(tmpMeta, JSON.stringify(sidecar, null, 2), "utf-8");
    } catch (err) {
      // Cleanup any partial tmp state.
      await Promise.allSettled([
        rm(tmpPdf, { force: true }),
        rm(tmpMeta, { force: true }),
      ]);
      throw err;
    }

    // Atomic publish (review fix H2):
    //   1. Rename PDF first (the visible-data file).
    //   2. Rename meta SECOND.
    //   `retrieve()` checks meta existence first, so until meta lands the
    //   record is invisible to readers — preventing PDF-without-meta TOCTOU.
    //   On meta-rename failure we roll back the PDF rename so no orphan blob
    //   is left behind.
    try {
      await rename(tmpPdf, pdfDest);
    } catch (err) {
      await Promise.allSettled([
        rm(tmpPdf, { force: true }),
        rm(tmpMeta, { force: true }),
      ]);
      throw err;
    }
    try {
      await rename(tmpMeta, metaDest);
    } catch (err) {
      // Roll back PDF rename + tmp meta to leave the slot empty.
      await Promise.allSettled([
        rm(pdfDest, { force: true }),
        rm(tmpMeta, { force: true }),
      ]);
      throw err;
    }

    this.logger?.debug?.("[voucher-pdf-storage] store success", {
      storage_key: input.storage_key,
      version,
    });

    return { stored_at, version };
  }

  async retrieve(storage_key: string): Promise<StoredArtifact | null> {
    const pdfPath = this.pdfPath(storage_key);
    const metaPath = this.metaPath(storage_key);

    // Meta-first existence check (review fix H2): if meta is absent the
    // record is considered not-yet-published or already purged.
    if (!existsSync(metaPath) || !existsSync(pdfPath)) {
      return null;
    }

    // TOCTOU fix (review fix M5): a concurrent purge() between existsSync and
    // readFile would otherwise surface as ENOENT. Catch that path and return
    // null; rethrow other errors.
    try {
      const [pdf_buffer, metaRaw] = await Promise.all([
        readFile(pdfPath),
        readFile(metaPath, "utf-8"),
      ]);
      const sidecar = JSON.parse(metaRaw) as MetaSidecar;
      return { pdf_buffer, metadata: sidecar.metadata };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw err;
    }
  }

  async getPresignedUrl(
    storage_key: string,
    ttl_seconds: number = DEFAULT_TTL_SECONDS,
  ): Promise<string> {
    const expires_at = Date.now() + ttl_seconds * 1_000;
    const secret = getHmacSecret();
    const token = buildSignedToken(storage_key, expires_at, secret);
    return `/store/voucher-pdf/${token}`;
  }

  async purge(storage_key: string): Promise<void> {
    const pdfPath = this.pdfPath(storage_key);
    const metaPath = this.metaPath(storage_key);

    // Collect rejections; report any non-ENOENT failure (review fix L1).
    const results = await Promise.allSettled([
      rm(pdfPath, { force: true }),
      rm(metaPath, { force: true }),
    ]);
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason as Error)
      .filter((e) => (e as NodeJS.ErrnoException).code !== "ENOENT");
    if (errors.length > 0) {
      this.logger?.warn?.("[voucher-pdf-storage] purge encountered errors", {
        storage_key,
        errors: errors.map((e) => e.message),
      });
      throw new AggregateError(errors, "[voucher-pdf-storage] purge failed");
    }

    // Best-effort empty-dir cleanup (review fix L2): remove the parent
    // voucher folder if no siblings remain. Ignore ENOTEMPTY/ENOENT.
    try {
      await rmdir(dirname(pdfPath));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "ENOENT" && code !== "EEXIST") {
        // Non-empty dir or doesn't exist is fine; surface only unexpected.
        this.logger?.debug?.(
          "[voucher-pdf-storage] purge dir cleanup non-fatal",
          { code },
        );
      }
    }
  }

  /**
   * Check whether an artifact has exceeded the retention window.
   * Used by retention sweep jobs; not part of IVoucherPdfStorage port.
   */
  isExpired(metadata: VoucherPdfMetadata): boolean {
    const generated = new Date(metadata.generated_at).getTime();
    const cutoff =
      Date.now() - this.retentionDays * 24 * 60 * 60 * 1_000;
    return generated < cutoff;
  }
}

// Avoid unused-import lint when join is not directly referenced post-refactor.
void join;
