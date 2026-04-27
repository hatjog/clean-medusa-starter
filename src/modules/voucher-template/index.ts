/**
 * voucher-template module barrel export.
 *
 * @see D-52, D-53. v1.5.0 will swap impl.
 *
 * Public surface = port interfaces + placeholder types + stub classes.
 * Server-safe imports only.
 */
export type {
  EffectiveVoucherTemplate,
  IVoucherTemplateResolver,
  IVoucherTemplateValidator,
  TemplateValidationResult,
  VoucherDeliveryType,
  VoucherTemplateDraft,
} from "./ports"
export {
  StubVoucherTemplateResolver,
  StubVoucherTemplateValidator,
} from "./ports"
