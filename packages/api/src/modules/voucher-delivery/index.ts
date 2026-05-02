/**
 * voucher-delivery module barrel export.
 *
 * @see D-52, D-53. v1.5.0 will swap impl.
 *
 * Public surface = port interfaces + placeholder types + stub classes.
 * Server-safe imports only.
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

// Story v160-6-2: multi-vendor PDF voucher generator (stub-tier; ADR-070
// engine swap deferred to Story 6.x). FM-43 isolation contract + AR45
// privacy boundary payload builder are stable surface.
export type {
  CartLineItemForVoucher,
  MultiVendorPdfDispatch,
  VendorRecord,
  VoucherPdfPayload,
} from "./multi-vendor-pdf"
export {
  buildVoucherPdfPayload,
  buildVoucherPdfStorageKey,
  dispatchMultiVendorPdfs,
  groupLineItemsByVendor,
  renderVoucherPdfStub,
} from "./multi-vendor-pdf"
