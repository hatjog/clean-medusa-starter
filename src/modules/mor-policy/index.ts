/**
 * mor-policy module barrel export.
 *
 * @see D-42 — mor-policy stub module.
 *
 * v1.5.0 will swap impl. Consumers should import from this barrel rather than
 * deep-importing internal files; the public surface is the type contract +
 * the stub class. The barrel intentionally exports only server-safe symbols
 * (no DB clients, no env reads); safe to import from server-side code paths.
 */
export type {
  BreakagePolicy,
  IMorPolicyEvaluator,
  MorContext,
  MorEvaluationErrorCode,
  MorResolution,
  OrderItemRef,
  VoucherKind,
} from "./types"
export { MorEvaluationError } from "./types"
export { StubMorPolicyEvaluator } from "./stub"
