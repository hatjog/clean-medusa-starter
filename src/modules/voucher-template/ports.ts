/**
 * voucher-template/ports.ts — bounded-context port contracts for the Voucher
 * Template BC (D-52 stub-domain).
 *
 * v1.4.0 ships interface contracts only. Stub classes throw a hard
 * `not implemented v1.4.0` error at runtime to prevent accidental invocation.
 * v1.5.0 will swap impl with the full template resolution chain
 * (market → vendor → buyer) per voucher-delivery-analysis-2026-04-23.md §3.2a.
 *
 * @see D-52 — Voucher Template BC stub-domain.
 * @see D-53 — three voucher delivery schemas (VoucherTemplate,
 *      VoucherPersonalization, VoucherDelivery).
 * @see _bmad-output/planning-artifacts/voucher-delivery-analysis-2026-04-23.md
 *      §3.2 (entity shapes), §3.2a (3-tier resolution chain).
 *
 * Versioning: net-new optional fields = additive-MINOR. Renaming or removing
 * fields, or making any existing field required, = MAJOR.
 */

const NOT_IMPL = "not implemented v1.4.0 — see D-52, ships in v1.5.0"

/**
 * VoucherDeliveryType — closed enum of supported delivery channels.
 *
 * @see D-52, D-53.
 * @see voucher-delivery-analysis-2026-04-23.md §3.2 (channel matrix).
 *
 * v1.5.0 may add channels (additive-MINOR). Renaming or removing channel
 * codes is MAJOR — consumers may exhaustively switch on this discriminator.
 */
export type VoucherDeliveryType =
  | "PDF"
  | "WALLET_APPLE"
  | "WALLET_GOOGLE"
  | "EMAIL_HTML"
  | "SMS_TEXT"
  | "WHATSAPP"
  | "PLASTIC_CARD"

/**
 * EffectiveVoucherTemplate — placeholder shape for the resolved template.
 *
 * @see D-53.
 * @see voucher-delivery-analysis-2026-04-23.md §3.2.
 *
 * v1.5.0 will swap impl — full template body, asset references, and locale
 * fallback chain land then. The minimal field set below is the stable
 * identifier surface; everything else is TBD v1.5.0.
 */
export type EffectiveVoucherTemplate = {
  /* TBD v1.5.0 — full body / assets / fallback chain. See voucher-delivery-analysis-2026-04-23.md §3.2 */
  template_id: string
  scope: "MARKET" | "VENDOR_OVERRIDE" | "VENDOR_OWN"
  type: VoucherDeliveryType
  effective_locale: string
}

/**
 * VoucherTemplateDraft — placeholder shape for an authoring draft.
 *
 * @see D-53.
 *
 * v1.5.0 will swap impl with the full draft body. Required fields here are
 * the **routing key** (market + type); everything else is TBD v1.5.0.
 */
export type VoucherTemplateDraft = {
  /* TBD v1.5.0 — full draft body. */
  market_id: string
  vendor_id?: string
  type: VoucherDeliveryType
}

/**
 * TemplateValidationResult — placeholder shape for validator output.
 *
 * @see D-53.
 *
 * v1.5.0 will swap impl with structured findings (severity, location,
 * remediation hint). The `ok` boolean + flat `errors` array is the minimal
 * stable surface.
 */
export type TemplateValidationResult = {
  /* TBD v1.5.0 — structured findings with severity + location. */
  ok: boolean
  errors: string[]
}

/**
 * IVoucherTemplateResolver — port for resolving the effective template per
 * `(market, vendor?, type, locale)` tuple via the 3-tier resolution chain.
 *
 * @see D-52, D-53.
 * @see voucher-delivery-analysis-2026-04-23.md §3.2a.
 *
 * v1.5.0 will swap impl. v1.4.0 stub throws — invocation is a contract bug.
 */
export interface IVoucherTemplateResolver {
  resolveEffectiveTemplate(ctx: {
    market_id: string
    vendor_id?: string
    type: VoucherDeliveryType
    locale: string
  }): Promise<EffectiveVoucherTemplate>
}

/**
 * IVoucherTemplateValidator — port for validating a draft before transitioning
 * to ACTIVE.
 *
 * @see D-52, D-53.
 *
 * v1.5.0 will swap impl. v1.4.0 stub throws.
 */
export interface IVoucherTemplateValidator {
  validateTemplate(template: VoucherTemplateDraft): Promise<TemplateValidationResult>
}

/**
 * StubVoucherTemplateResolver — v1.4.0 placeholder. Throws on every call.
 *
 * @see D-52. v1.5.0 will swap impl.
 */
export class StubVoucherTemplateResolver implements IVoucherTemplateResolver {
  async resolveEffectiveTemplate(): Promise<EffectiveVoucherTemplate> {
    throw new Error(NOT_IMPL)
  }
}

/**
 * StubVoucherTemplateValidator — v1.4.0 placeholder. Throws on every call.
 *
 * @see D-52. v1.5.0 will swap impl.
 */
export class StubVoucherTemplateValidator implements IVoucherTemplateValidator {
  async validateTemplate(): Promise<TemplateValidationResult> {
    throw new Error(NOT_IMPL)
  }
}
