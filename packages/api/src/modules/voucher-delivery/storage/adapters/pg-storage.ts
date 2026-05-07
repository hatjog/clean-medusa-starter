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
 *
 * AR45 privacy boundary: pdf_buffer is an opaque binary blob from the
 * PDF engine; metadata.recipient_token is an opaque token (non-PII).
 * This adapter never inspects blob content.
 *
 * getPresignedUrl: same HMAC-signed local route approach as filesystem
 * adapter. Production S3/MinIO deferred to v1.10.0.
 *
 * @see TF-117, cleanup-52
 * @see cleanup-44 for Knex + Medusa container pattern
 */

import { createHmac } from "node:crypto";
import type { Knex } from "knex";

import type {
  IVoucherPdfStorage,
  StoredArtifact,
  StoreInput,
  StoreOutput,
  VoucherPdfMetadata,
} from "../ports";

const TABLE = "voucher_delivery_artifact";
const DEFAULT_TTL_SECONDS = 86_400;
const DEFAULT_RETENTION_DAYS = 90;

function buildSignedToken(
  storage_key: string,
  expires_at: number,
  secret: string,
): string {
  const payload = `${storage_key}|${expires_at}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  const encodedKey = Buffer.from(storage_key).toString("base64url");
  return `${encodedKey}.${expires_at}.${sig}`;
}

export class PgVoucherPdfStorage implements IVoucherPdfStorage {
  private readonly retentionDays: number;

  constructor(
    private readonly db: Knex,
    retentionDays?: number,
  ) {
    const envDays = parseInt(process.env["VOUCHER_PDF_RETENTION_DAYS"] ?? "", 10);
    this.retentionDays =
      retentionDays ?? (Number.isFinite(envDays) && envDays > 0 ? envDays : DEFAULT_RETENTION_DAYS);
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
    const secret =
      process.env["VOUCHER_PDF_HMAC_SECRET"] ?? "dev-insecure-fallback";
    const expires_at = Date.now() + ttl_seconds * 1_000;
    const token = buildSignedToken(storage_key, expires_at, secret);
    return `/store/voucher-pdf/${token}`;
  }

  async purge(storage_key: string): Promise<void> {
    await this.db(TABLE).where({ storage_key }).delete();
  }

  /**
   * Purge all artifacts whose expires_at has passed.
   * Called by retention sweep job (outside IVoucherPdfStorage port surface).
   */
  async purgeExpired(): Promise<{ rows_deleted: number }> {
    const rows_deleted = await this.db(TABLE)
      .where("expires_at", "<", new Date().toISOString())
      .delete();
    return { rows_deleted };
  }
}

/**
 * Migration helper — creates the voucher_delivery_artifact table if it does
 * not exist. Called from the app migration script or loader bootstrap.
 *
 * Idempotent (uses CREATE TABLE IF NOT EXISTS).
 */
export async function ensureVoucherDeliveryArtifactTable(
  db: Knex,
): Promise<void> {
  const exists = await db.schema.hasTable(TABLE);
  if (exists) return;

  await db.schema.createTable(TABLE, (t) => {
    t.text("storage_key").primary();
    t.binary("pdf_buffer").notNullable();
    t.jsonb("metadata").notNullable();
    t.timestamp("stored_at", { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.integer("version").notNullable().defaultTo(1);
    t.timestamp("expires_at", { useTz: true }).nullable();
  });
}
