/**
 * voucher-delivery module barrel export.
 *
 * @see D-52, D-53.
 *
 * Public surface = port interfaces + types + stub classes + PDF engine +
 * storage layer (cleanup-52 / TF-117).
 *
 * PDF engine (cleanup-52): renderVoucherPdf() — real pdfkit PDF binary.
 * renderVoucherPdfStub() kept as soft-rename alias (deprecated; v1.7.0 drop).
 * Storage layer: IVoucherPdfStorage port + FilesystemVoucherPdfStorage (default)
 * + PgVoucherPdfStorage (optional). Loader: loaders/voucher-pdf-storage.ts.
 * Container key: "voucher_pdf_storage".
 */
export type {
  IVoucherDeliveryAuditTrail,
  IVoucherDispatcher,
  VoucherDeliveryAttempt,
  VoucherDispatchInput,
  VoucherDispatchResult,
} from "./ports"
export {
  StubVoucherDeliveryAuditTrail,
  StubVoucherDispatcher,
} from "./ports"

// Multi-vendor PDF generator (FM-43 isolation contract, AR45 privacy boundary).
// Engine: pdfkit (cleanup-52). Storage layer: storage/ (cleanup-52 / TF-117).
export type {
  CartLineItemForVoucher,
  MultiVendorPdfDispatch,
  VendorRecord,
  VoucherPdfPayload,
} from "./multi-vendor-pdf"
export {
  buildVoucherPdfPayload,
  buildVoucherPdfStorageKey,
  // New async dispatch with real PDF engine (preferred).
  dispatchMultiVendorPdfsAsync,
  // Sync dispatch (deprecated wrapper; use dispatchMultiVendorPdfsAsync).
  dispatchMultiVendorPdfs,
  groupLineItemsByVendor,
  // Real PDF engine — output starts with %PDF- magic header.
  renderVoucherPdf,
  // Deprecated stub alias (v1.6.0 soft-rename window; removed v1.7.0).
  renderVoucherPdfStub,
  // Wire point for storage layer (cleanup-52).
  persistDeliveryArtifact,
} from "./multi-vendor-pdf"

// Appointment .ics generator (Story 5.2 / ADR-137 iCal Path A).
export type {
  VoucherAppointmentIcsInput,
  VoucherAppointmentLifecycleStatus,
  VoucherAppointmentManageLinkOptions,
} from "./ics-generator"
export {
  buildAppointmentCalendarUid,
  generateVoucherAppointmentIcs,
  VOUCHER_APPOINTMENT_SUMMARY_FALLBACK,
  VOUCHER_APPOINTMENT_TIMEZONE,
} from "./ics-generator"

// Storage layer port + adapters (cleanup-52 / TF-117).
export type {
  IVoucherPdfStorage,
  StoredArtifact,
  StoreInput,
  StoreOutput,
  VoucherPdfMetadata,
} from "./storage/ports"
export {
  FilesystemVoucherPdfStorage,
  verifySignedToken,
} from "./storage/adapters/filesystem-storage"
export {
  PgVoucherPdfStorage,
  ensureVoucherDeliveryArtifactTable,
} from "./storage/adapters/pg-storage"
