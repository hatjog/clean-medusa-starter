/**
 * mor-policy/types.ts — typed contracts for the Merchant-of-Record (MoR)
 * policy evaluator.
 *
 * @see D-42 — mor-policy stub module (architecture decision)
 * @see _bmad-output/planning-artifacts/mor-hybrid-voucher-first-analysis.md
 *      §5.2 (sale_mor vs service_mor), §5.3 (snapshot determinism),
 *      §6.1 (ontology + events), §6.2 (four ledger cases),
 *      §10.3 (per-vendor breakage policy override).
 *
 * v1.5.0 will swap impl with a YAML-driven policy loader. The types in this
 * file are the **stable contract surface** consumed by P-04/P-05/P-06 and
 * downstream snapshot/ledger code:
 *  - net-new optional fields = additive-MINOR (safe).
 *  - new error codes        = additive-MINOR (safe).
 *  - removing/renaming fields, adding required fields, removing or renaming
 *    error codes = MAJOR (forces consumer migration).
 */

/**
 * Voucher kind discriminator. Drives the service-MoR branch in {@link MorResolution}.
 *
 * - `'spv'`  — single-vendor voucher.
 * - `'mpv'`  — multi-purpose voucher (operator-issued, vendor-redeemable).
 * - `'none'` — non-voucher line item; service_mor_type collapses to `null`.
 *
 * @see D-42
 * @see mor-hybrid-voucher-first-analysis.md §6.2
 *
 * v1.5.0 may extend this union — adding members is additive-MINOR (consumers
 * that exhaustively switch must add a default arm). Renaming or removing
 * members is MAJOR.
 */
export type VoucherKind = "spv" | "mpv" | "none"

/**
 * OrderItemRef — local placeholder for the canonical Mercur/Medusa OrderItem
 * shape until the upstream type is confirmed and importable.
 *
 * Decision (story T2): the upstream Mercur fork does not currently expose a
 * stable `OrderItem` symbol from `@medusajs/types` that downstream MoR code can
 * pin to without pulling in the full order module. We therefore declare this
 * minimal local placeholder and JSDoc-flag it for replacement.
 *
 * @see STORY-TYPE-CONTRACTS-MOR-BC Tasks/T2
 *
 * v1.5.0 may swap this for the upstream `OrderItem` type once the Mercur fork
 * exposes it. Field shape is intentionally a strict subset so the swap is
 * structural-compatible.
 */
export interface OrderItemRef {
  id: string
  product_id: string
  quantity: number
  metadata?: Record<string, unknown>
}

/**
 * MorContext — input shape for MoR policy resolution at order placement.
 *
 * Field strategy: required fields are the **minimum** the stub needs to make a
 * resolution decision. Optional fields foreshadow v1.5.0 inputs (vendor
 * scoping, line-item context, product category routing) and stay `?:` so the
 * stub can ignore them while v1.5.0 reads them.
 *
 * @see D-42
 * @see mor-hybrid-voucher-first-analysis.md §5.3, §6.1
 *
 * v1.5.0 will swap impl with YAML policy loader. New optional fields may be
 * added (additive-MINOR); making any existing field required = MAJOR.
 */
export interface MorContext {
  /** Market identifier — REQUIRED. Empty string is rejected by the stub. */
  market_id: string

  /** Vendor identifier — optional for operator-only flows. */
  vendor_id?: string

  /**
   * Voucher kind discriminator.
   *
   * The stub treats `undefined` as a hard error (`MISSING_CONFIG`) — it does
   * NOT infer voucher_kind from {@link MorContext.product_category}. v1.5.0
   * may relax this once policy YAML can express inference rules.
   */
  voucher_kind?: VoucherKind

  /**
   * Order line reference — placeholder until upstream Mercur OrderItem type
   * is wired in (see {@link OrderItemRef} JSDoc).
   */
  order_line?: OrderItemRef

  /**
   * Product category routing hint. Reserved for v1.5.0 — the stub does not
   * read this field. Intentionally a closed union to keep the contract stable.
   */
  product_category?: "voucher" | "goods" | "digital" | "subscription" | "other"
}

/**
 * BreakagePolicy — placeholder for v1.5.0 breakage rules.
 *
 * Only the discriminator (`kind`) lands in v1.4.0 to keep the type stable for
 * downstream consumers. Per-jurisdiction, per-vendor, and per-instrument
 * specifics are deliberately TBD.
 *
 * @see D-42
 * @see mor-hybrid-voucher-first-analysis.md §6.2 (four ledger cases),
 *      §10.3 (per-vendor override).
 *
 * v1.5.0 will swap impl with the full policy shape. Adding fields here later
 * is additive-MINOR (safe). Renaming or removing `kind` values is MAJOR
 * because consumers may exhaustively switch on this discriminator.
 */
export type BreakagePolicy = {
  kind: "operator_full" | "vendor_share" | "customer_refund" | "vendor_full_agent"
  // TBD v1.5.0 — vendor_share_pct, snapshot_at, jurisdiction-specific
  // overrides (see mor-hybrid-voucher-first-analysis.md §10.3).
}

/**
 * MorResolution — frozen snapshot of the MoR decision at order.placed.
 *
 * Downstream contracts (ledger ADR-005, settlement ADR-007, OrderPlaced.v2
 * payload) read this exact shape. Treat it as a first-class wire contract:
 * adding optional fields is additive-MINOR; everything else is MAJOR.
 *
 * @see D-42
 * @see mor-hybrid-voucher-first-analysis.md §5.2, §5.3
 *
 * v1.5.0 will swap impl — the stub returns `mor_policy_version: 'stub-v0'`;
 * v1.5.0 returns the YAML policy version string.
 */
export type MorResolution = {
  /** Sale-side MoR type. Stub always returns `'operator'` per D-42. */
  sale_mor_type: "operator" | "vendor"

  /** Sale-side MoR subject id. Stub returns the literal `'operator'` string. */
  sale_mor_subject: string

  /**
   * Service-side MoR type. `null` for `voucher_kind: 'none'` (non-voucher);
   * `'vendor'` for `voucher_kind: 'spv' | 'mpv'`.
   */
  service_mor_type: "vendor" | null

  /**
   * Service-side MoR subject id (typically the vendor id). `null` when
   * {@link MorResolution.service_mor_type} is `null` or when no vendor is in
   * scope.
   */
  service_mor_subject: string | null

  /** Echoed voucher kind from the input context (snapshot determinism). */
  voucher_kind: VoucherKind

  /**
   * Policy version string. Stub returns `'stub-v0'`; v1.5.0 returns the
   * loaded YAML policy version (e.g. `'2026-Q3.1'`).
   */
  mor_policy_version: string

  /**
   * Optional in v1.4.0 stub; may become required in v1.6.0+ once breakage
   * accounting ships. Adding an optional field is additive-MINOR.
   */
  breakage_policy?: BreakagePolicy
}

/**
 * IMorPolicyEvaluator — port interface for MoR policy resolution.
 *
 * Sync method. v1.5.0 may add an async overload if YAML loading needs DB
 * lookup; that addition is additive-MINOR provided the sync signature stays
 * present (a parallel `IMorPolicyEvaluatorAsync` would be cleaner).
 *
 * @see D-42
 *
 * v1.5.0 will swap impl. Stable contract — consumers should depend on this
 * symbol, never on {@link import('./stub').StubMorPolicyEvaluator}.
 */
export interface IMorPolicyEvaluator {
  resolve(ctx: MorContext): MorResolution
}

/**
 * MorEvaluationError — discriminated error class for MoR resolution failures.
 *
 * Consumers may match on {@link MorEvaluationError.code}; treat code values
 * as part of the public contract.
 *
 * @see D-42
 *
 * v1.5.0 will swap impl. Adding new code values is additive-MINOR; renaming
 * or removing existing codes is MAJOR.
 */
export type MorEvaluationErrorCode =
  | "MARKET_NOT_FOUND"
  | "VENDOR_INVALID"
  | "MISSING_CONFIG"

/**
 * Discriminated error class for MoR resolution failures.
 *
 * @see D-42
 *
 * v1.5.0 will swap impl. See {@link MorEvaluationErrorCode} for the stable
 * code surface.
 */
export class MorEvaluationError extends Error {
  public readonly code: MorEvaluationErrorCode
  public readonly context?: Partial<MorContext>

  constructor(args: {
    code: MorEvaluationErrorCode
    message: string
    context?: Partial<MorContext>
  }) {
    super(args.message)
    this.name = "MorEvaluationError"
    this.code = args.code
    this.context = args.context
    // Restore the prototype chain when transpiled to ES5 / older targets.
    Object.setPrototypeOf(this, MorEvaluationError.prototype)
  }
}
