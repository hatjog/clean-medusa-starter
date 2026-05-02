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
