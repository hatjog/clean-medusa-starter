/**
 * voucher-pii/types.ts — STORY-2-2 type contracts for the voucher PII module.
 *
 * Pure type declarations (NO PII fields appear in event payloads — see
 * `gp.voucher.consent_recorded.v1.schema.json` for the wire schema). Live PII
 * (email/phone) is passed through `RecordConsentInput` only inside the chained
 * Postgres tx; redaction at logger boundary keeps it out of stdout/Sentry.
 */

export type ConsentOutcome = "granted" | "audit_failed";
export type WithdrawalOutcome = "withdrawn" | "withdrawal_failed";
export type DeliveryOutcome =
  | "pending"
  | "dispatched"
  | "dlq_audit_failed"
  | "dlq_rate_limited"
  | "dlq_provider_failed"
  | "withdrawn";

export type ConsentStateMachineState =
  | "audit-recording"
  | "audit-confirmed"
  | "delivery-decision-recorded"
  | "error-audit-failed";

/** Input to `recordConsentTransaction` — Story 2.1 Server Action POST body. */
export interface RecordConsentInput {
  market_id: string;
  order_id: string;
  entitlement_id: string;
  recipient_email: string | null;
  recipient_phone: string | null;
  locale: string;
  is_gift: boolean;
  /** Per-request correlation id (NFR-OBS-5 trace_id propagation). */
  request_id: string;
}

/** Output of the synchronous chained tx — only id references, NEVER PII. */
export interface RecordConsentResult {
  consent_audit_id: string;
  recipient_pii_id: string;
  delivery_decision_id: string;
  state_machine_state: ConsentStateMachineState;
  latency_ms: number;
}

/** Input to `recordWithdrawalTransaction` — fast-path purge. */
export interface RecordWithdrawalInput {
  market_id: string;
  order_id: string;
  consent_audit_id: string;
  request_id: string;
  withdrawal_path: "immediate" | "scheduled_ttl" | "dlq_ttl";
}

export interface RecordWithdrawalResult {
  withdrawal_audit_id: string;
  outcome: WithdrawalOutcome;
  latency_ms: number;
  in_flight_dispatch_aborted: boolean;
}

/** Output of `getConsentState` — read-after-write check (worker step 1). */
export interface ConsentStateSnapshot {
  consent_audit_id: string;
  market_id: string;
  recipient_pii_id?: string;
  /** Order associated with the consent audit, if known. */
  order_id?: string | null;
  /** ISO timestamp of the consent audit record creation. */
  created_at?: string;
  /** True iff audit row was committed AND not subsequently withdrawn. */
  audit_confirmed: boolean;
}

/** Failure mode taxonomy — Story 2.1's Server Action maps to UI states. */
export class ConsentTransactionError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "ConsentTransactionError";
  }
}

export class ConsentAuditFailedError extends ConsentTransactionError {
  constructor(message: string) {
    super(message, "error-audit-failed");
    this.name = "ConsentAuditFailedError";
  }
}

export class ConsentRlsViolationError extends ConsentTransactionError {
  constructor(message: string) {
    super(message, "error-rls-violation");
    this.name = "ConsentRlsViolationError";
  }
}

export class ConsentValidationError extends ConsentTransactionError {
  constructor(message: string) {
    super(message, "error-validation");
    this.name = "ConsentValidationError";
  }
}
