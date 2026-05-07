/**
 * voucher-delivery/storage/ports.ts — Port contracts for the voucher PDF
 * storage layer (cleanup-52 / TF-117).
 *
 * IVoucherPdfStorage provides store/retrieve/getPresignedUrl/purge methods.
 * Adapters implement this interface; the loader registers the chosen adapter
 * as `voucher_pdf_storage` in the Medusa container.
 *
 * Privacy boundary (AR45): pdf_buffer contains only public/vendor-side data.
 * metadata.recipient_token is an opaque token (non-PII per AR45 tokenisation).
 * NO recipient email/phone/address flows through this layer.
 *
 * Versioning: net-new optional fields = additive-MINOR.
 *
 * @see TF-117, cleanup-52
 * @see cleanup-44 for loader + adapter pattern reference
 * @see FM-43 for multi-vendor isolation contract
 */

/**
 * Metadata stored alongside the PDF binary. All fields are non-PII.
 */
export interface VoucherPdfMetadata {
  /** Voucher delivery correlation id (non-PII). */
  delivery_id: string;
  /**
   * Opaque token identifying the recipient (non-PII per AR45).
   * NOT an email, phone, or any personally-identifiable value.
   */
  recipient_token: string;
  /** ISO 8601 generation timestamp — used for retention computation. */
  generated_at: string;
  /**
   * List of vendor handles included in this PDF.
   * Single-element array per FM-43 isolation (1 PDF = 1 vendor).
   * Array retained for forward-compat with potential multi-vendor PDFs.
   */
  vendor_handles: string[];
}

/** Input to store() operation. */
export interface StoreInput {
  /** Deterministic per-vendor key from buildVoucherPdfStorageKey(). */
  storage_key: string;
  /** Full PDF bytes (must start with %PDF- magic header). */
  pdf_buffer: Buffer;
  /** Non-PII metadata stored alongside blob. */
  metadata: VoucherPdfMetadata;
}

/** Output from store() operation. */
export interface StoreOutput {
  /** ISO 8601 timestamp of when the artifact was persisted. */
  stored_at: string;
  /** Monotonic version counter per storage_key (starts at 1). */
  version: number;
}

/** Artifact returned by retrieve(). */
export interface StoredArtifact {
  /** Full PDF bytes. */
  pdf_buffer: Buffer;
  /** Non-PII metadata. */
  metadata: VoucherPdfMetadata;
}

/**
 * IVoucherPdfStorage — port for persisting, retrieving, and lifecycle-managing
 * generated voucher PDF artifacts.
 *
 * Adapter implementations:
 *   - FilesystemVoucherPdfStorage  (default; STAGING-FREE, docker-compose dev)
 *   - PgVoucherPdfStorage          (PostgreSQL BYTEA; optional secondary)
 */
export interface IVoucherPdfStorage {
  /**
   * Persist a generated PDF artifact.
   *
   * Implementations MUST be atomic (tmp-then-rename or equivalent) to prevent
   * partial writes being visible to concurrent retrieve() callers.
   */
  store(input: StoreInput): Promise<StoreOutput>;

  /**
   * Retrieve a previously stored PDF artifact.
   *
   * Returns null when no record exists for storage_key (or after purge).
   */
  retrieve(storage_key: string): Promise<StoredArtifact | null>;

  /**
   * Return a URL (or signed token route) for serving the PDF.
   *
   * For filesystem adapter: returns an HMAC-signed local route token.
   * For Postgres adapter: returns an HMAC-signed local route token.
   * Production MinIO/S3 presigned URL deferred to v1.10.0.
   *
   * @param ttl_seconds - URL validity window in seconds (default 86400 = 24h)
   */
  getPresignedUrl(storage_key: string, ttl_seconds?: number): Promise<string>;

  /**
   * Remove a stored artifact (retention hook / GDPR purge path).
   *
   * No-op if storage_key does not exist.
   */
  purge(storage_key: string): Promise<void>;
}
