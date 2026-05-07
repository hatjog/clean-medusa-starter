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
 * Writes are atomic: buffer written to *.tmp then renamed (POSIX-atomic on
 * same filesystem), preventing partial reads by concurrent retrieve() callers.
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
 * (format: `/store/voucher-pdf/{token}`). Token is HMAC-SHA256 signed with
 * VOUCHER_PDF_HMAC_SECRET (or ephemeral fallback for dev). Production KMS-backed
 * signing deferred to v1.10.0+.
 *
 * @see TF-117, cleanup-52
 * @see cleanup-44 for adapter pattern reference
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

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

/**
 * Derive the HMAC secret from env or generate an ephemeral value for dev.
 * NOTE: ephemeral secret invalidates all tokens on process restart — acceptable
 * for local dev; production MUST set VOUCHER_PDF_HMAC_SECRET.
 */
function resolveHmacSecret(): string {
  return (
    process.env["VOUCHER_PDF_HMAC_SECRET"] ??
    createHash("sha256")
      .update(`dev-ephemeral-${Date.now()}`)
      .digest("hex")
  );
}

// Module-level singleton so secret stays stable within a process.
let _hmacSecret: string | undefined;
function getHmacSecret(): string {
  if (!_hmacSecret) {
    _hmacSecret = resolveHmacSecret();
  }
  return _hmacSecret;
}

/** Build signed token for presigned URL. */
function buildSignedToken(
  storage_key: string,
  expires_at: number,
  secret: string,
): string {
  const payload = `${storage_key}|${expires_at}`;
  const sig = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  const encodedKey = Buffer.from(storage_key).toString("base64url");
  return `${encodedKey}.${expires_at}.${sig}`;
}

/** Verify a signed token. Returns storage_key if valid, null if invalid/expired. */
export function verifySignedToken(
  token: string,
  secret: string,
): { storage_key: string; expires_at: number } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedKey, expiresStr, sig] = parts as [string, string, string];
  const expires_at = parseInt(expiresStr, 10);
  if (!Number.isFinite(expires_at) || Date.now() > expires_at) return null;
  const storage_key = Buffer.from(encodedKey, "base64url").toString("utf-8");
  const payload = `${storage_key}|${expires_at}`;
  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  // Constant-time comparison to prevent timing attacks.
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;
  return { storage_key, expires_at };
}

export class FilesystemVoucherPdfStorage implements IVoucherPdfStorage {
  private readonly storageRoot: string;
  private readonly retentionDays: number;

  /**
   * @param storageRoot - Sandboxed root directory for PDF artifacts.
   *   Resolved from VOUCHER_PDF_STORAGE_ROOT env by the loader.
   * @param retentionDays - Retention window override (default 90 days).
   */
  constructor(storageRoot: string, retentionDays?: number) {
    this.storageRoot = storageRoot;
    const envDays = parseInt(process.env["VOUCHER_PDF_RETENTION_DAYS"] ?? "", 10);
    this.retentionDays =
      retentionDays ?? (Number.isFinite(envDays) && envDays > 0 ? envDays : DEFAULT_RETENTION_DAYS);
  }

  /**
   * Resolve absolute path for a storage_key, sandboxed to storageRoot.
   *
   * Path-traversal hardening:
   *   - Reject null bytes (POSIX path-injection vector).
   *   - Reject keys containing '..' segments (cross-platform).
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

    // Atomic write: tmp → rename (POSIX-safe on same FS).
    await writeFile(tmpPdf, input.pdf_buffer);
    await writeFile(tmpMeta, JSON.stringify(sidecar, null, 2), "utf-8");
    await rename(tmpPdf, pdfDest);
    await rename(tmpMeta, metaDest);

    return { stored_at, version };
  }

  async retrieve(storage_key: string): Promise<StoredArtifact | null> {
    const pdfPath = this.pdfPath(storage_key);
    const metaPath = this.metaPath(storage_key);

    if (!existsSync(pdfPath) || !existsSync(metaPath)) {
      return null;
    }

    const [pdf_buffer, metaRaw] = await Promise.all([
      readFile(pdfPath),
      readFile(metaPath, "utf-8"),
    ]);

    const sidecar = JSON.parse(metaRaw) as MetaSidecar;
    return { pdf_buffer, metadata: sidecar.metadata };
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

    await Promise.allSettled([
      rm(pdfPath, { force: true }),
      rm(metaPath, { force: true }),
    ]);
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
