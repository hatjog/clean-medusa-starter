/**
 * voucher-pii module — STORY-2-2 entrypoint.
 *
 * Exposes:
 *   - `VoucherPiiService` orchestrator (public).
 *   - Type contracts (public).
 *   - Port interfaces (for adapters + tests).
 *
 * Container registration: the Postgres + Redis adapters live in `adapters/`
 * (out of scope for v1.5.0 first-cut — Medusa container wires them via
 * loader). v1.5.0 ships the orchestrator + port contracts; subscribers + jobs
 * resolve the service from the container by key `voucher_pii`.
 *
 * Refs: STORY-2-2-VOUCHER-PII-PIPELINE-BACKEND scope #4 (module skeleton).
 */

export { VoucherPiiService } from "./voucher-pii.service";
export type {
  VoucherPiiServiceDeps,
} from "./voucher-pii.service";
export type {
  AuditChainPort,
  ConsentTxInput,
  DeliveryDecisionPort,
  EventEmitterPort,
  IdempotencyPort,
  RateLimitPort,
  VoucherPiiPort,
} from "./ports";
export {
  ConsentAuditFailedError,
  ConsentRlsViolationError,
  ConsentTransactionError,
  ConsentValidationError,
} from "./types";
export type {
  ConsentOutcome,
  ConsentStateMachineState,
  ConsentStateSnapshot,
  DeliveryOutcome,
  RecordConsentInput,
  RecordConsentResult,
  RecordWithdrawalInput,
  RecordWithdrawalResult,
  WithdrawalOutcome,
} from "./types";
