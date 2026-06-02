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

// Story 4.1 (Epic 4 / Wave 4 — lifecycle): redeem (partial + full) idempotentny
// z derecognition. Partial obniża `remaining` na TYM SAMYM entitlement_id (NIE
// reissue, NIGDY > remaining); tranzycja routuje przez wireEntitlementTransition
// Persisted (3.4); posting = DERECOGNITION proporcjonalna (generateVoucherPosting
// 2.3 → ledger-writer 2.6). Idempotencja DWUWARSTWOWA (idempotency_key+
// entitlement_id domena + transaction_id writera). Withdrawal (art. 38 pkt 1)
// gaśnie WYŁĄCZNIE przy REDEEMED_FULL. Posting GATED (runtime_enabled=false ⇒
// audit-only/no-op; flip = E6/P6, NIE tutaj).
export {
  VOUCHER_REDEMPTION_TABLE,
  RedeemPartialEntitlementOperation,
  RedeemEntitlementNotFoundError as RedeemPartialEntitlementNotFoundError,
  RedeemAmountError,
  RedeemNotRedeemableError,
  PostgresRedeemPartialStore,
  InMemoryRedeemPartialStore,
  createRedeemPartialOperationFromScope,
  isWithdrawalRightExtinguished,
  buildRedemptionId,
} from "./workflows/redeem-partial-entitlement"
export type {
  RedeemOutcome,
  RedeemPartialInput,
  RedeemPartialResult,
  RedemptionRecord,
  RedeemableAmountEntitlement,
  RedeemPartialTx,
  RedeemPartialStore,
  RedeemPartialEventEmitter,
  RedeemPartialDeps,
} from "./workflows/redeem-partial-entitlement"

// Story 4.2 (Epic 4 / Wave 4 — lifecycle): warstwa SALDA + DEFENSYWNEGO EXPIRY
// (anti-forfeiture) + powiadomienia. Saldo `remaining` na TYM SAMYM entitlement_id
// (spójne z 4.1); deterministyczny `expires_at` (12 mies., boundary [1,24], D-9/FR14);
// pre-expiry powiadomienie oferuje extend ORAZ bezpłatny zwrot salda — copy NIGDY
// „przepadnie" (anti-forfeiture invariant egzekwowany mechanicznie). AC3: blokada
// profilu forfeiture REUŻYWA boundary 1.2 (art. 385¹ KC).
export {
  DEFAULT_VALIDITY_MONTHS,
  EXPIRED_CUSTOMER_STATUS,
  PRE_EXPIRY_REMINDER_EVENT_TYPE,
  FORBIDDEN_FORFEITURE_TOKENS,
  ForfeitureCopyError,
  ExpiryRecoveryOptionsError,
  ExpiryProfileForfeitureError,
  entitlementRemainingBalance,
  resolveValidityMonths,
  addMonthsUtc,
  computeExpiresAt,
  assertNoForfeitureCopy,
  defaultPreExpiryMessage,
  buildPreExpiryNotification,
  buildPreExpiryIdempotencyKey,
  assertExpiryProfileActivatable,
} from "./entitlement-expiry"
export type {
  EntitlementBalance,
  ExpiryRecoveryKind,
  ExpiryRecoveryOption,
  PreExpiryNotification,
  BuildPreExpiryNotificationInput,
} from "./entitlement-expiry"

// Story 4.2: operacja EXPIRED → BREAKAGE (derecognition niewykorzystanego salda)
// routowana przez wireEntitlementTransitionPersisted (3.4) → posting hook →
// ledger-writer (2.6); gated (runtime_enabled=false ⇒ audit-only/no-op). Idempotentny
// sweep (replay ⇒ no-op; domena EXPIRED marker + transaction_id writera). Pre-expiry
// notifier z dedup (powiadomienie RAZ per okno). Status klienta „Ważność minęła —
// sprawdź opcje zwrotu" (UX §8). Posting GATED (flip = E6/P6, NIE tutaj).
export {
  EXPIRY_SOURCE_STATES,
  ExpireEntitlementOperation,
  ExpireEntitlementNotFoundError,
  EntitlementNotExpirableError,
  ExpireAmountError,
  PreExpiryNotifier,
  PostgresExpireEntitlementStore,
  InMemoryExpireEntitlementStore,
  PostgresPreExpiryDedupeStore,
  InMemoryPreExpiryDedupeStore,
  createExpireEntitlementOperationFromScope,
  createPreExpiryNotifierFromScope,
} from "./workflows/expire-entitlement"
export type {
  ExpireEntitlementInput,
  ExpireEntitlementResult,
  ExpirableEntitlement,
  ExpireEntitlementTx,
  ExpireEntitlementStore,
  ExpireEntitlementEventEmitter,
  ExpireEntitlementDeps,
  PreExpiryNotificationSink,
  PreExpiryDedupeStore,
  PreExpiryNotifierDeps,
  PreExpiryNotifyInput,
  PreExpiryNotifyResult,
} from "./workflows/expire-entitlement"

// Story 4.3 (Epic 4 / Wave 4 — lifecycle L4 refund): DWA mechanizmy zwrotu —
// (a) odstąpienie 14 dni (pełny zwrot niewykorzystanego, art. 38 pkt 1; prawo
// gaśnie WYŁĄCZNIE przy REDEEMED_FULL — reuse 4.1) + (b) zwrot salda `remaining`
// (dozwolony także po partial, art. 385¹ KC). Copy rozróżnia (a)/(b) (UX-DR-14,
// anti-forfeiture). RODO art. 26 carry-forward KONSUMUJE istniejący kontrakt DSAR
// (ADR-069, NIE buduje nowego). KRYTYCZNE (ADR-139 §Granice): refund posting =
// NO posting + alarm (REFUNDED nieznane profilowi) ⇒ DEFEROWANY architektonicznie,
// wymaga OSOBNEGO ADR; tranzycja routuje przez wireEntitlementTransition (3.4) dla
// event+audit (gated/audit-only). NIE flipuje runtime_enabled (E6/P6).
export {
  WITHDRAWAL_WINDOW_DAYS,
  WITHDRAWAL_BASIS_LABEL,
  BALANCE_BASIS_LABEL,
  DSAR_CONTRACT_REF,
  DSAR_CARRY_FORWARD_ADR,
  REFUND_POSTING_REQUIRED_ADR,
  REFUND_POSTING_DEFERRAL_REASON,
  REFUND_TERMINAL_STATE,
  RefundChannelError,
  RefundWithdrawalWindowError,
  RefundMechanismError,
  RefundAmountError,
  RefundCopyAmbiguityError,
  resolveRefundWindowDays,
  isWithinWithdrawalWindow,
  resolveRefundChannel,
  determineRefundMechanism,
  buildRefundCopy,
  assertRefundCopyDistinct,
  buildDsarCarryForward,
  buildRefundPostingDeferral,
  buildPaymentRefundIdempotencyKey,
} from "./entitlement-refund"
export type {
  RefundMechanism,
  RefundDeterminationInput,
  RefundDetermination,
  RefundCopy,
  DsarCarryForward,
  RefundPostingDeferral,
} from "./entitlement-refund"

// Story 4.3: operacja refund (dwa mechanizmy) routowana przez wireEntitlement
// TransitionPersisted (3.4) → REFUND_REQUESTED → REFUNDED. Posting derecognition
// FAIL-CLOSED (ADR-139 §Granice): BRAK payloadu postingu (audit-only) + marker
// deferralu (wymaga osobnego ADR). Idempotentny (REFUNDED terminal marker; refund_id
// dyskryminator audytu + seam zwrotu płatności — Stripe NIE aktywowany, scope window).
export {
  REFUND_SOURCE_STATES,
  ENTITLEMENT_REFUNDED_EVENT_TYPE,
  REFUND_POSTING_DEFERRED_EVENT_TYPE,
  RefundEntitlementOperation,
  RefundEntitlementNotFoundError,
  EntitlementNotRefundableError,
  PostgresRefundEntitlementStore,
  InMemoryRefundEntitlementStore,
  createRefundEntitlementOperationFromScope,
} from "./workflows/refund-entitlement"
export type {
  RefundEntitlementInput,
  RefundEntitlementResult,
  RefundLifecycleEnvelope,
  RefundableEntitlement,
  RefundEntitlementTx,
  RefundEntitlementStore,
  RefundEntitlementEventEmitter,
  RefundPostingDeferralSink,
  RefundEntitlementDeps,
} from "./workflows/refund-entitlement"

// Story 4.4 (Epic 4 / Wave 4 — lifecycle L4 extend): POLITYKA + OKABLOWANIE
// przedłużenia ważności. DWA tryby (FR18): (1) pierwszy extend NIEODPŁATNY 1×
// (licznik `unpaid_extension_count` 0→1, idempotentny — replay NIE podwaja) + (2)
// ODPŁATNY 5–15% (boundary L2 fail-closed) ZAWSZE z RÓWNORZĘDNĄ, BEZPŁATNĄ opcją
// zwrotu salda (parytet, anti-dark-pattern; brak ⇒ ExtendParityError). Copy NIGDY
// „przepadnie"/„zapłać albo strać" (assertExtendCopySafe). `expires_at` clamp do
// boundary (≤24 mies. od emisji, NIGDY poza). KRYTYCZNE (ADR-139 D5): extend =
// entitlement liability BEZ ZMIANY ⇒ audit-only (BRAK payloadu postingu); opłata =
// money-ledger (deferred, wymaga osobnego ADR + E6/P6). Tranzycja routuje przez
// JEDNOLITY punkt okablowania (3.4) — from===to (extend NIE zmienia stanu, D-5,
// taksonomia 13 stanów niezmieniona). NIE flipuje runtime_enabled (E6/P6).
export {
  EXTEND_FEE_PCT_MIN,
  EXTEND_FEE_PCT_MAX,
  MAX_FREE_EXTENDS,
  FORBIDDEN_COERCION_TOKENS,
  EXTEND_FEE_POSTING_REQUIRED_ADR,
  EXTEND_POSTING_DEFERRAL_REASON,
  FreeExtendExhaustedError,
  FreeExtendIdempotencyMissingError,
  ExtendFeeBoundaryError,
  ExtendParityError,
  ExtendCoercionCopyError,
  ExtendProfileError,
  ExtendExtensionMonthsBoundaryError,
  determineExtendMode,
  computeExtendedExpiresAt,
  buildExtendIdempotencyKey,
  assertNoCoercionExtendCopy,
  assertExtendCopySafe,
  defaultPaidExtendMessage,
  buildPaidExtendOffer,
  assertExtendProfileActivatable,
  buildExtendPostingDeferral,
  extendActorHint,
  buildExtendTransitionInput,
  buildExtendWiring,
} from "./entitlement-extend"
export type {
  ExtendMode,
  ExtendDeterminationInput,
  ExtendDetermination,
  ComputeExtendedExpiresAtInput,
  ExtendOptionKind,
  ExtendOption,
  ExtendOffer,
  BuildPaidExtendOfferInput,
  ExtendPostingDeferral,
  BuildExtendWiringInput,
  ExtendWiringResult,
} from "./entitlement-extend"

// Story 4.5 (Epic 4 / Wave 4 — lifecycle L4 transfer/gifting): RECIPIENT BINDING +
// walidacja trybu `transferability` (`bearer | personalized | hybrid`, snapshot
// `policy_snapshot` przy ISSUED, FR15/FR16) + okablowanie tranzycji CLAIM. Obdarowanie
// (gifting) nadaje recipient binding + claim token (reuse v1.8.0 P4, BEZ nowego UI);
// claim recipienta aktywuje uprawnienie (`ISSUED → ACTIVE` = „aktywacja przez recipienta")
// WYŁĄCZNIE przez JEDNOLITY punkt wireEntitlementTransition (3.4) → event + audit (kto
// obdarował / kto zclaimował) + posting hook. Idempotencja: transfer_id deterministyczny
// (replay ⇒ jeden transfer); claim token JEDNORAZOWY (replay tej samej tożsamości/okaziciela
// ⇒ no-op, double-claim ⇒ fail-closed). KRYTYCZNE (ADR-139 D5): transfer/claim = binding-only
// (NIE derecognition; liability bez zmiany, brak ruchu pieniądza) ⇒ posting hook = no-op
// derecognition (BRAK payloadu); runtime_enabled zostaje false (flip = E6/P6). RODO: dane
// recipienta minimalne (wyłącznie recipient_customer_id). Single-vendor / bonbeauty-only
// (NIE cross-vendor wallet); taksonomia 13 stanów + hard-gate'y nietknięte (D-5).
export {
  TRANSFER_POSTING_NOOP_REASON,
  CLAIM_IDENTITY_AUTH_CONTRACT,
  TransferabilityEnumError,
  TransferRecipientRequiredError,
  TransferRecipientSameAsBuyerError,
  TransferStateError,
  TransferClaimTokenSourceError,
  ClaimTokenInvalidError,
  ClaimTokenConsumedError,
  ClaimStateError,
  readTransferabilityFromSnapshot,
  buildTransferId,
  buildTransferGrant,
  buildAtomicClaimGuard,
  determineClaimOutcome,
  buildTransferPostingNoop,
  claimActorHint,
  buildClaimTransitionInput,
  buildClaimWiring,
} from "./entitlement-transfer"
export type {
  RecipientBinding,
  BuildTransferGrantInput,
  TransferGrant,
  ClaimOutcomeKind,
  DetermineClaimInput,
  ClaimDetermination,
  TransferPostingNoop,
  BuildClaimWiringInput,
  ClaimWiringResult,
} from "./entitlement-transfer"

// Story 4.6 (Epic 4 / Wave 4 — lifecycle L4 cancellation / no-show): POLITYKA
// anulacji/no-show + REBOOK na booking pointerze (v1.6.0). CUTOFF min 12h (jawna
// anulacja dozwolona do 12h przed terminem, po cutoff fail-closed); anulacja ≥24h ⇒
// voucher W PEŁNI AKTYWNY (`remaining`/`expires_at` niezmienione, AC1, FR19); anulacja
// <24h / no-show ⇒ WARTOŚĆ ZACHOWANA + rebook (AC2). INWARIANT UX-DR-14 M-5: rebook NIE
// skraca `expires_at` (ważność = pierwotna polityka 4.2, NIGDY od daty rebooku;
// `computeRebookExpiresAt` identity + `assertRebookPreservesExpiry` defense). Copy NIGDY
// „przepadnie" (reuse `assertNoForfeitureCopy` 4.2). Idempotencja (replay ⇒ no-op):
// idempotency_key WYMAGANY (fail-closed). KRYTYCZNE (ADR-139 D5): anulacja/no-show/rebook
// ZWALNIA booking, liability BEZ ZMIANY ⇒ BRAK postingu (audit-only, posting payload
// CELOWO pominięty); runtime_enabled zostaje false (flip = E6/P6). Tranzycja routuje przez
// JEDNOLITY punkt okablowania (3.4) — `from === to` (NIE zmienia stanu, D-5, taksonomia 13
// stanów niezmieniona). NIE rusza hard-gate'ów MPV_MULTI_VENDOR/SUBSCRIPTION_B2C.
export {
  CANCELLATION_CUTOFF_HOURS,
  CANCELLATION_ACTIVE_THRESHOLD_HOURS,
  CANCELLATION_POSTING_NOOP_REASON,
  CancellationCutoffError,
  CancellationIdempotencyMissingError,
  CancellationHoursInvalidError,
  RebookExpiryShorteningError,
  determineCancellationOutcome,
  determineNoShowOutcome,
  computeRebookExpiresAt,
  assertRebookPreservesExpiry,
  buildCancellationIdempotencyKey,
  buildRebookIdempotencyKey,
  defaultCancellationMessage,
  defaultRebookMessage,
  assertCancellationCopySafe,
  buildCancellationPostingNoop,
  cancellationActorHint,
  buildCancellationTransitionInput,
  buildCancellationWiring,
} from "./entitlement-cancellation"
export type {
  CancellationKind,
  CancellationTier,
  CancellationDeterminationInput,
  CancellationDetermination,
  NoShowDeterminationInput,
  CancellationPostingNoop,
  BuildCancellationWiringInput,
  CancellationWiringResult,
} from "./entitlement-cancellation"

export default Module(VOUCHER_MODULE, {
  service: VoucherService,
  loaders: [voucherSeedFixturesLoader],
})
