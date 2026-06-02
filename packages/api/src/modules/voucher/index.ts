/**
 * voucher module — Medusa 2 module entrypoint.
 *
 * Story v160-cleanup-25: PG-backed voucher module replacing in-memory
 * voucher-fixture-store.ts. Register in medusa-config.ts modules array
 * under key "voucher".
 *
 * Resolve in route handlers via:
 *   const voucherService = req.scope.resolve("voucher") as VoucherService
 */

import { Module } from "@medusajs/framework/utils"
import VoucherService from "./service"
import voucherSeedFixturesLoader from "./loaders/seed-fixtures"

export const VOUCHER_MODULE = "voucher"

export { VoucherService }
export {
  ENTITLEMENT_EXTENDED_EVENT,
  ENTITLEMENT_CANCELLATION_FEE_APPLIED_EVENT,
  ENTITLEMENT_REFUND_APPLIED_EVENT,
  ENTITLEMENT_NO_SHOW_EVENT_TYPE,
  EntitlementExtensionError,
  EntitlementRefundError,
} from "./service"
export type {
  ExtendEntitlementInput,
  ExtendEntitlementResult,
  EntitlementExtendedEnvelope,
  CancelBookingInput,
  CancellationFeeAppliedPayload,
  CancellationPaymentRefundSeam,
  RefundRequestInput,
  RefundRequestResult,
  RefundAppliedPayload,
  RefundAppliedEnvelope,
  MarkNoShowInput,
  MarkNoShowResult,
  NoShowOutcome,
} from "./service"

export type {
  VoucherRow,
  VoucherEventRow,
  VoucherWithEvents,
  UpsertVoucherInput,
  AppendEventInput,
  ClaimResult,
  VoucherStatus,
  VoucherEventType,
} from "./models/types"

// ADR-099 4-layer entitlement model (Story v180-2-1).
export {
  EntitlementType,
  ALL_ENTITLEMENT_TYPES,
  ACTIVE_ENTITLEMENT_TYPES,
  INACTIVE_ENTITLEMENT_TYPES,
  isActiveEntitlementType,
  isEntitlementType,
  EntitlementInstanceState,
  ALL_ENTITLEMENT_INSTANCE_STATES,
  TERMINAL_ENTITLEMENT_STATES,
  ALLOWED_ENTITLEMENT_TRANSITIONS,
  canTransition,
  assertTransition,
  EntitlementTransitionError,
  snapshotPolicy,
  assertPolicySnapshotImmutable,
  // BE-8 (Story 2.9): auto_redeem policy helper.
  shouldAutoRedeemOnBookingConfirm,
} from "./models/entitlement"
export type {
  EntitlementPolicySnapshot,
  EntitlementInstanceRow,
  AutoRedeemPolicy,
} from "./models/entitlement"
export {
  VAT_CLASSIFICATION_SNAPSHOT_RULE,
  resolveVatClassification,
} from "./vat-resolver"
export type {
  ResolveVatClassificationInput,
  VatClassification,
} from "./vat-resolver"
// Story 2.4: read-only telemetry capability over entitlement lifecycle events.
export {
  LNE_EARLY_WARN_RATIO,
  LNE_THRESHOLD_EUR_MINOR,
  redemptionVelocity,
  rollingVolumeLNE,
} from "./telemetry"
export type {
  RedemptionVelocityBucket,
  RedemptionVelocityOptions,
  RedemptionVelocityResult,
  RollingVolumeLNEOptions,
  RollingVolumeLNEResult,
  VoucherTelemetryEvent,
  VoucherTelemetryLifecycle,
} from "./telemetry"
// Story 2.3: posting profile voucher_liability_only_v1 (AUTHORED, runtime_enabled:FALSE
// per ADR-133 §P6 — eksport dostarcza ZDOLNOŚĆ, NIE aktywuje profilu w runtime).
export {
  VOUCHER_POSTING_PROFILE_ID,
  VOUCHER_LEDGER_ACCOUNTS,
  VOUCHER_LIABILITY_ONLY_V1,
  VoucherPostingGuardError,
  VoucherPostingInvariantError,
  isMoneyAccount,
  assertPostingAccountsAllowed,
  assertBalanced,
  generateVoucherPosting,
} from "./posting-profile"
export type {
  LedgerScope,
  LedgerLine,
  LedgerTransactionV1,
  VoucherEntryType,
  VoucherLifecycleEvent,
  VoucherPostingInput,
  VoucherPostingResult,
} from "./posting-profile"
// Story 2.6: fundament persystencji entitlement-ledgera (ADR-139 D3 — idempotentny
// writer, ujście dla generateVoucherPosting()). Eksport dostarcza ZDOLNOŚĆ ZAPISU,
// NIE aktywuje postingu (runtime_enabled zostaje false, flip = E6/P6).
export {
  VoucherLedgerWriter,
  VoucherLedgerWriteError,
  deriveLedgerTransactionId,
} from "./ledger-writer"
export type {
  LedgerPgClient,
  LedgerPgPool,
  LedgerLifecycleDiscriminator,
  VoucherLedgerWriteRequest,
  VoucherLedgerWriteResult,
} from "./ledger-writer"
// Story 3.4: okablowanie maszyny stanów L4 → event + audit + posting hook
// (ADR-137 / ADR-139 D3/D5). JEDNOLITY punkt: dozwolona tranzycja → (1) event
// envelope.v1 (best-effort post-COMMIT) + (2) append-only audit + (3) posting hook
// bramkowany dwuwarstwowo (runtime_enabled + per-market; inert gdy off). Eksport
// dostarcza OKABLOWANIE, NIE aktywuje postingu (runtime_enabled zostaje false, flip = E6/P6).
export {
  ENTITLEMENT_STATE_CHANGED_EVENT_TYPE,
  ENTITLEMENT_GENESIS,
  EntitlementGenesisError,
  assertWiringTransition,
  defaultPostingActivationGate,
  buildTransitionEnvelopes,
  buildGenesisIssuedTransition,
  runTransitionPostingHook,
  wireEntitlementTransitionPersisted,
  emitTransitionEventAfterCommit,
  wireEntitlementTransition,
} from "./entitlement-transition-wiring"
export type {
  TransitionActor,
  TransitionFromState,
  TransitionScope,
  TransitionEventEnvelope,
  TransitionAuditEnvelope,
  TransitionPostingPayload,
  PostingActivationGate,
  TransitionPostingResult,
  TransitionLedgerWriter,
  TransitionInput,
  GenesisIssuedArgs,
  TransitionWiringDeps,
  TransitionWiringResult,
} from "./entitlement-transition-wiring"
// Story 3.2: event-level idempotencja konsumpcji eventów (ADR-137 DEC-5 pkt 3.i).
// Warstwa danych pod live-issue Path Y (subscriber = 3.3). Eksport dostarcza
// kontrakt tabeli `event_processed` + prymityw dedupe (ON CONFLICT DO NOTHING),
// NIE subscriber / NIE posting hook / NIE aktywację postingu.
export {
  EVENT_PROCESSED_TABLE,
  EVENT_PROCESSED_PK_COLUMNS,
  buildEventProcessedDedupeInsert,
  applyEventProcessedDedup,
} from "./models/event-processed"
export type { EventProcessedRow } from "./models/event-processed"
export {
  ENTITLEMENT_BOUNDARY,
  LOST_CODE_REISSUE_WINDOW_DAYS,
  RETENTION_AMOUNT_PCT_MIN,
  RETENTION_AMOUNT_PCT_MAX,
  NO_SHOW_POLICIES,
  REFUND_CHANNELS,
  TRANSFERABILITY_VALUES,
  isWithinReissueWindow,
  isRetentionAmountWithinBoundary,
  validityMonthsMax,
  checkPolicyAgainstBoundary,
  assertTransferabilityAllowed,
  TransferabilityError,
} from "./entitlement-boundary"
export type {
  NoShowPolicy,
  RefundChannel,
  Transferability,
  RedeemContext,
  BoundaryViolation,
} from "./entitlement-boundary"
export {
  ENTITLEMENT_LOST_CODE_REISSUED_EVENT_TYPE,
  GP_PLATFORM_SCOPE_SENTINEL,
  EntitlementNotFoundError,
  LostCodeReissueWindowError,
  LostCodeReissueChainError,
  ReissueLostCodeWorkflow,
  PostgresReissueLostCodeStore,
  InMemoryReissueLostCodeStore,
  createReissueLostCodeWorkflowFromScope,
  generateReadableEntitlementCode,
} from "./workflows/reissue-lost-code"
export type {
  EventEnvelope,
  ReissuableEntitlement,
  ReissueLostCodeInput,
  ReissueLostCodeResult,
  ReissueLostCodeStore,
  ReissueLostCodeTx,
  EntitlementEventEmitter,
} from "./workflows/reissue-lost-code"

// BE-9 (Story 2.10): retention voucher workflow.
export {
  ENTITLEMENT_RETENTION_ISSUED_EVENT_TYPE,
  RetentionAmountBoundaryError,
  RetentionEntitlementNotFoundError,
  IssueRetentionWorkflow,
  PostgresIssueRetentionStore,
  InMemoryIssueRetentionStore,
  createIssueRetentionWorkflowFromScope,
  generateRetentionEntitlementCode,
} from "./workflows/issue-retention"
export type {
  RetentionEventEnvelope,
  RetentionEntitlement,
  IssueRetentionInput,
  IssueRetentionResult,
  IssueRetentionStore,
  IssueRetentionTx,
  RetentionEventEmitter,
} from "./workflows/issue-retention"

// BE-8 (Story 2.9): auto-redeem workflow.
export {
  ENTITLEMENT_REDEEMED_EVENT_TYPE,
  EntitlementNotFoundError as RedeemEntitlementNotFoundError,
  RedeemEntitlementWorkflow,
  PostgresRedeemEntitlementStore,
  InMemoryRedeemEntitlementStore,
  createRedeemEntitlementWorkflowFromScope,
} from "./workflows/redeem-entitlement"
export type {
  RedeemEventEnvelope,
  RedeemableEntitlement,
  RedeemEntitlementInput,
  RedeemEntitlementResult,
  RedeemEntitlementStore,
  RedeemEntitlementTx,
  RedeemEntitlementEventEmitter,
} from "./workflows/redeem-entitlement"

export default Module(VOUCHER_MODULE, {
  service: VoucherService,
  loaders: [voucherSeedFixturesLoader],
})
