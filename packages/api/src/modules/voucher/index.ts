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
  EntitlementExtensionError,
} from "./service"
export type {
  ExtendEntitlementInput,
  ExtendEntitlementResult,
  EntitlementExtendedEnvelope,
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
  ENTITLEMENT_BOUNDARY,
  LOST_CODE_REISSUE_WINDOW_DAYS,
  NO_SHOW_POLICIES,
  REFUND_CHANNELS,
  isWithinReissueWindow,
  validityMonthsMax,
  checkPolicyAgainstBoundary,
} from "./entitlement-boundary"
export type {
  NoShowPolicy,
  RefundChannel,
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
