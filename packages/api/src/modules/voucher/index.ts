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
} from "./models/entitlement"
export type {
  EntitlementPolicySnapshot,
  EntitlementInstanceRow,
} from "./models/entitlement"
export {
  ENTITLEMENT_BOUNDARY,
  NO_SHOW_POLICIES,
  REFUND_CHANNELS,
  validityMonthsMax,
  checkPolicyAgainstBoundary,
} from "./entitlement-boundary"
export type {
  NoShowPolicy,
  RefundChannel,
  BoundaryViolation,
} from "./entitlement-boundary"

export default Module(VOUCHER_MODULE, {
  service: VoucherService,
  loaders: [voucherSeedFixturesLoader],
})
