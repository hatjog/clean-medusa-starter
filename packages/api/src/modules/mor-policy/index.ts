/**
 * mor-policy module barrel export.
 *
 * @see D-42 — mor-policy stub module.
 *
 * v1.5.0 wires both the tri-state flag resolver (D-69 / ADR-074, STORY-1-3)
 * and the MoR policy runtime evaluator (D-71 / ADR-079, STORY-3-1). Consumers
 * should import from this barrel rather than deep-importing internal files; the
 * public surface is the type contract + the stub class + runtime evaluators.
 * The barrel intentionally exports only server-safe symbols (no DB clients,
 * no env reads); safe to import from server-side code paths.
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

// D-69 / ADR-074 — tri-state flag resolver runtime (v1.5.0, STORY-1-3).
// `MorFlagResolver` is server-only; runtime callers MUST resolve via Medusa container
// DI (see PAT-5 Hexagonal-light) — direct construction is reserved for tests + per-port
// adapters in `src/api/admin/sellers/[id]/pause/route.ts`.
export type {
  FlagFlagsPort,
  MorFlagPrecedence,
  MorFlagResolution,
  MorFlagStatus,
  SellerStatusPort,
} from "./MorFlagResolver"
export { MorFlagResolver } from "./MorFlagResolver"

// D-71 / ADR-079 — runtime policy evaluator + per-offer HMAC-SHA256 signature
// (v1.5.0, STORY-3-1). Stub remains exported for unit-test isolation; runtime
// path = MorPolicyEvaluator. v1.6.0 promotes per-offer signature gate D-78
// from WARN -> ERROR (see _grow/tools/validate_mor_per_offer_capability.py).
export {
  MorPolicyEvaluator,
  InMemorySnapshotStore,
  NoopAuditLog,
} from "./MorPolicyEvaluator"
export type {
  AuditLogPort,
  MorPolicyEvaluatedPayload,
  MorPolicyEvaluatorOptions,
  SnapshotStore,
  StoredSnapshot,
} from "./MorPolicyEvaluator"
export type {
  EvaluationRequest,
  MorEvaluationOutcome,
  OfferContext,
} from "./policy-contract"
export {
  DECISION_PATH_MAX_ENTRIES,
  DECISION_PATH_RULE_NAME_MAX_LEN,
  truncateDecisionPath,
  assertNonEmptyOfferContexts,
} from "./policy-contract"
export { classifyFailure, promoteExhaustedRetry } from "./dlq"
export type { DlqClassification, DlqTier, FailureModeCode } from "./dlq"
