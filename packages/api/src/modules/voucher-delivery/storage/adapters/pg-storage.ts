/**
 * pg-storage.ts — PostgreSQL BYTEA adapter for IVoucherPdfStorage
 * (cleanup-52 / TF-117).
 *
 * Secondary backend (Opcja B). Stores PDF artifacts in the
 * `voucher_delivery_artifact` table with BYTEA blob + JSONB metadata.
 * Primary backend is filesystem (Opcja A); this adapter is wired when
 * VOUCHER_PDF_STORAGE_BACKEND=postgres.
 *
 * Table: voucher_delivery_artifact
 *   storage_key    TEXT PRIMARY KEY
 *   pdf_buffer     BYTEA NOT NULL
 *   metadata       JSONB NOT NULL
 *   stored_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   version        INTEGER NOT NULL DEFAULT 1
 *   expires_at     TIMESTAMPTZ
 *   INDEX idx_voucher_delivery_artifact_expires_at (expires_at)  // review fix L3
 *
 * AR45 privacy boundary: pdf_buffer is an opaque binary blob from the
 * PDF engine; metadata.recipient_token is an opaque token (non-PII).
 * This adapter never inspects blob content.
 *
 * getPresignedUrl: shares HMAC signing helper (storage/hmac.ts) with the
 * filesystem adapter (review fix M2). Production S3/MinIO deferred to v1.10.0.
 *
 * @see TF-117, cleanup-52
 * @see cleanup-44 for Knex + Medusa container pattern
 */

import type { Knex } from "knex";

import { buildSignedToken, getHmacSecret } from "../hmac";
import type {
  IVoucherPdfStorage,
  StoredArtifact,
  StoreInput,
  StoreOutput,
  VoucherPdfMetadata,
} from "../ports";
import type { StorageLogger } from "./filesystem-storage";

const TABLE = "voucher_delivery_artifact";
const EXPIRY_INDEX = "idx_voucher_delivery_artifact_expires_at";
const DEFAULT_TTL_SECONDS = 86_400;
const DEFAULT_RETENTION_DAYS = 90;

export class PgVoucherPdfStorage implements IVoucherPdfStorage {
  private readonly retentionDays: number;
  private readonly logger: StorageLogger | undefined;

  constructor(
    private readonly db: Knex,
    retentionDays?: number,
    logger?: StorageLogger,
  ) {
    const envDays = parseInt(process.env["VOUCHER_PDF_RETENTION_DAYS"] ?? "", 10);
    this.retentionDays =
      retentionDays ?? (Number.isFinite(envDays) && envDays > 0 ? envDays : DEFAULT_RETENTION_DAYS);
    this.logger = logger;
  }

  async store(input: StoreInput): Promise<StoreOutput> {
    const stored_at = new Date().toISOString();
    const expires_at = new Date(
      Date.now() + this.retentionDays * 24 * 60 * 60 * 1_000,
    ).toISOString();

    await this.db(TABLE)
      .insert({
        storage_key: input.storage_key,
        pdf_buffer: input.pdf_buffer,
        metadata: JSON.stringify(input.metadata),
        stored_at,
        version: 1,
        expires_at,
      })
      .onConflict("storage_key")
      .merge({
        pdf_buffer: input.pdf_buffer,
        metadata: JSON.stringify(input.metadata),
        stored_at,
        expires_at,
      });

    this.logger?.debug?.("[voucher-pdf-storage] pg store success", {
      storage_key: input.storage_key,
    });

    return { stored_at, version: 1 };
  }

  async retrieve(storage_key: string): Promise<StoredArtifact | null> {
    const row = await this.db(TABLE)
      .where({ storage_key })
      .select("pdf_buffer", "metadata")
      .first();

    if (!row) return null;

    const metadata =
      typeof row.metadata === "string"
        ? (JSON.parse(row.metadata) as VoucherPdfMetadata)
        : (row.metadata as VoucherPdfMetadata);

    // Knex may return Buffer or Uint8Array depending on driver version.
    const pdf_buffer = Buffer.isBuffer(row.pdf_buffer)
      ? row.pdf_buffer
      : Buffer.from(row.pdf_buffer as Uint8Array);

    return { pdf_buffer, metadata };
  }

  async getPresignedUrl(
    storage_key: string,
    ttl_seconds: number = DEFAULT_TTL_SECONDS,
  ): Promise<string> {
    // Review fix H1+M2: shared secret resolution + signing format with
    // filesystem adapter; no insecure literal fallback.
    const secret = getHmacSecret();
    const expires_at = Date.now() + ttl_seconds * 1_000;
    const token = buildSignedToken(storage_key, expires_at, secret);
    return `/store/voucher-pdf/${token}`;
  }

  /**
   * Remove a stored artifact. Returns the number of rows deleted so callers
   * can distinguish noop (0) from a real delete (1) — review fix L4.
   *
   * Returns void as required by IVoucherPdfStorage; for the row-count surface
   * use {@link purgeExpired} or call into the table directly.
   */
  async purge(storage_key: string): Promise<void> {
    const rows_deleted = await this.db(TABLE)
      .where({ storage_key })
      .delete();
    this.logger?.debug?.("[voucher-pdf-storage] pg purge", {
      storage_key,
      rows_deleted,
    });
  }

  /**
   * Purge all artifacts whose expires_at has passed.
   * Called by retention sweep job (outside IVoucherPdfStorage port surface).
   */
  async purgeExpired(): Promise<{ rows_deleted: number }> {
    const rows_deleted = await this.db(TABLE)
      .where("expires_at", "<", new Date().toISOString())
      .delete();
    this.logger?.debug?.("[voucher-pdf-storage] pg purgeExpired", {
      rows_deleted,
    });
    return { rows_deleted };
  }
}

/**
 * Migration helper — creates the voucher_delivery_artifact table if it does
 * not exist. Called from the app migration script or loader bootstrap.
 *
 * Idempotent (uses CREATE TABLE IF NOT EXISTS + best-effort index create).
 *
 * Review fix L3: adds a btree index on expires_at to support O(log N) sweep
 * via purgeExpired() as artifact volume grows.
 */
export async function ensureVoucherDeliveryArtifactTable(
  db: Knex,
): Promise<void> {
  const exists = await db.schema.hasTable(TABLE);
  if (!exists) {
    await db.schema.createTable(TABLE, (t) => {
      t.text("storage_key").primary();
      t.binary("pdf_buffer").notNullable();
      t.jsonb("metadata").notNullable();
      t.timestamp("stored_at", { useTz: true }).notNullable().defaultTo(db.fn.now());
      t.integer("version").notNullable().defaultTo(1);
      t.timestamp("expires_at", { useTz: true }).nullable();
      t.index(["expires_at"], EXPIRY_INDEX);
    });
    return;
  }

  // Table existed (older deployment): ensure expiry index is present.
  // Best-effort; skip when underlying driver lacks hasIndex.
  try {
    const schema = db.schema as unknown as {
      hasIndex?: (table: string, index: string) => Promise<boolean>;
    };
    if (typeof schema.hasIndex === "function") {
      const hasIdx = await schema.hasIndex(TABLE, EXPIRY_INDEX);
      if (!hasIdx) {
        await db.schema.alterTable(TABLE, (t) => {
          t.index(["expires_at"], EXPIRY_INDEX);
        });
      }
    }
  } catch {
    // Index creation is best-effort; do not fail loader on driver mismatch.
  }
}
