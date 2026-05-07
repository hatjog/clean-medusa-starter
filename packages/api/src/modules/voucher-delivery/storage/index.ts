/**
 * voucher-delivery/storage barrel export (cleanup-52 / TF-117).
 *
 * Re-exports port types and adapter implementations.
 */
export type {
  IVoucherPdfStorage,
  StoredArtifact,
  StoreInput,
  StoreOutput,
  VoucherPdfMetadata,
} from "./ports";

export { FilesystemVoucherPdfStorage, verifySignedToken } from "./adapters/filesystem-storage";
export type { StorageLogger } from "./adapters/filesystem-storage";
export { PgVoucherPdfStorage, ensureVoucherDeliveryArtifactTable } from "./adapters/pg-storage";
export { buildSignedToken, getHmacSecret } from "./hmac";
