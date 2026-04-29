/**
 * voucher-pii.service — STORY-2-2 transaction orchestrator.
 *
 * Implements D-66 synchronous chained Postgres tx + D-72 5-step audit
 * consistency contract entrypoints. The service is pure orchestration: every
 * persistence concern is delegated to a port (see `ports.ts`), every PII
 * column is redacted at the logger boundary (see `logger.ts`).
 *
 * AC mapping:
 *   - AC-VPII-PIPE-2.2-01 → recordConsentTransaction (RLS-scoped INSERT into
 *     voucher_recipient_pii + audit row referencing recipient_pii_id).
 *   - AC-VPII-PIPE-2.2-02 → purgeExpiredPii + cleanupOrphans (used by
 *     retention scheduler job).
 *   - AC-VPII-PIPE-2.2-03 → executeDeliveryStep (5-step contract; called by
 *     subscriber pool).
 *   - AC-VPII-PIPE-2.2-04 → throughput skeleton (no per-call CPU bottleneck;
 *     hash-chain shard read happens inside AuditChainPort).
 *   - AC-VPII-PIPE-2.2-05 → emit() never includes raw PII; redaction is
 *     enforced at the logger transport (lib/logger.ts) AND by virtue of the
 *     port surface accepting only id-references in events.
 *
 * Refs: D-66 + D-67 + D-70 + D-72 (architecture.md).
 */

import type {
  AuditChainPort,
  DeliveryDecisionPort,
  EventEmitterPort,
  IdempotencyPort,
  RateLimitPort,
  VoucherPiiPort,
} from "./ports";
import {
  ConsentAuditFailedError,
  type ConsentStateMachineState,
  type DeliveryOutcome,
  type RecordConsentInput,
  type RecordConsentResult,
  type RecordWithdrawalInput,
  type RecordWithdrawalResult,
} from "./types";

export interface VoucherPiiServiceDeps {
  pii: VoucherPiiPort;
  audit: AuditChainPort;
  delivery: DeliveryDecisionPort;
  events: EventEmitterPort;
  idempotency: IdempotencyPort;
  rateLimit: RateLimitPort;
  /** Per-recipient bucket (default 10/min). Configurable via env in adapter. */
  recipientBucketSize?: number;
  recipientRefillPerMin?: number;
  /** Per-provider bucket (default 100/min). */
  providerBucketSize?: number;
  providerRefillPerMin?: number;
  /**
   * Stub provider id for v1.5.0 — vendor selection logic is owned by future
   * ADR (OOS for this story). Default = 'stub-email-v1'.
   */
  defaultProviderRef?: string;
  /** Clock seam for tests (deterministic latency_ms). */
  now?: () => number;
}

/**
 * Internal idempotency-key helper: keyed by (market_id, order_id) per Risk #2
 * mitigation in the story spec (Security Audit Personas section).
 */
function consentIdemKey(input: { market_id: string; order_id: string }): string {
  return `idem:voucher-consent:${input.market_id}:${input.order_id}`;
}

function deliveryIdemKey(input: { consent_audit_id: string }): string {
  return `idem:voucher-delivery:${input.consent_audit_id}`;
}

export class VoucherPiiService {
  private readonly deps: Required<
    Omit<VoucherPiiServiceDeps, "now"> & { now: () => number }
  >;

  constructor(deps: VoucherPiiServiceDeps) {
    this.deps = {
      pii: deps.pii,
      audit: deps.audit,
      delivery: deps.delivery,
      events: deps.events,
      idempotency: deps.idempotency,
      rateLimit: deps.rateLimit,
      recipientBucketSize: deps.recipientBucketSize ?? 10,
      recipientRefillPerMin: deps.recipientRefillPerMin ?? 10,
      providerBucketSize: deps.providerBucketSize ?? 100,
      providerRefillPerMin: deps.providerRefillPerMin ?? 100,
      defaultProviderRef: deps.defaultProviderRef ?? "stub-email-v1",
      now: deps.now ?? (() => Date.now()),
    };
  }

  /**
   * D-66 chained Postgres transaction. Sequencing:
   *   1. INSERT voucher_recipient_pii (PII data plane)
   *   2. INSERT voucher_pii_consent_audit (D-67 hash chain, references PII row by id)
   *   3. INSERT voucher_delivery_decision (state=pending; UNIQUE on consent_audit_id)
   *
   * Failure semantics: any step throws → ROLLBACK at adapter layer →
   * ConsentAuditFailedError → state=`error-audit-failed`. NEVER 200 + silent
   * fallback. Idempotency guard keyed on `(market_id, order_id)`.
   */
  async recordConsentTransaction(
    input: RecordConsentInput
  ): Promise<RecordConsentResult> {
    const start = this.deps.now();

    const result = await this.deps.idempotency.withIdempotency(
      consentIdemKey(input),
      300,
      async () => {
        let state: ConsentStateMachineState = "audit-recording";

        // Step 1 — PII row (RLS-scoped on market_id).
        const pii = await this.deps.pii.insertRecipientPii({
          market_id: input.market_id,
          entitlement_id: input.entitlement_id,
          order_id: input.order_id,
          recipient_email: input.recipient_email,
          recipient_phone: input.recipient_phone,
          locale: input.locale,
          is_gift: input.is_gift,
        });

        // Step 2 — Audit row referencing PII row by id (NEVER inline email/phone).
        const auditPayload = {
          action: "GRANTED",
          market_id: input.market_id,
          order_id: input.order_id,
          recipient_pii_id: pii.recipient_pii_id,
          locale: input.locale,
          is_gift: input.is_gift,
          state_machine_state: "audit-confirmed",
          request_id: input.request_id,
        };
        const audit = await this.deps.audit.appendAuditRow({
          market_id: input.market_id,
          payload: auditPayload,
        });
        state = "audit-confirmed";

        // Step 3 — Delivery decision row (state=pending; subscriber writes terminal).
        const delivery = await this.deps.delivery.insertPending({
          consent_audit_id: audit.audit_id,
          market_id: input.market_id,
        });
        state = "delivery-decision-recorded";

        const latency_ms = this.deps.now() - start;

        // Emit observability event AFTER tx commits — id references only.
        await this.deps.events.emit({
          event_type: "gp.voucher.consent_recorded.v1",
          market_id: input.market_id,
          payload: {
            request_id: input.request_id,
            market_id: input.market_id,
            order_id: input.order_id,
            consent_audit_id: audit.audit_id,
            recipient_pii_id: pii.recipient_pii_id,
            delivery_decision_id: delivery.delivery_decision_id,
            locale: input.locale,
            is_gift: input.is_gift,
            outcome: "granted",
            latency_ms,
            state_machine_state: state,
          },
        });

        return {
          consent_audit_id: audit.audit_id,
          recipient_pii_id: pii.recipient_pii_id,
          delivery_decision_id: delivery.delivery_decision_id,
          state_machine_state: state,
          latency_ms,
        } satisfies RecordConsentResult;
      }
    );

    return result;
  }

  /**
   * D-72 5-step audit consistency contract — single pure function executing
   * the full step sequence. Returns terminal outcome; subscriber pool wraps
   * this in `withIdempotency(consent_audit_id)`.
   */
  async executeDeliveryStep(args: {
    consent_audit_id: string;
    market_id: string;
    recipient_id: string;
    request_id: string;
    delivery_decision_id: string;
    delivery_attempt_n: number;
  }): Promise<{
    outcome: DeliveryOutcome;
    latency_ms: number;
    provider_ref: string | null;
    audit_chain_verified: boolean;
  }> {
    const start = this.deps.now();

    return this.deps.idempotency.withIdempotency(
      deliveryIdemKey({ consent_audit_id: args.consent_audit_id }),
      300,
      async () => {
        // Step 1 — read-after-write check.
        const snapshot = await this.deps.audit.readAfterWrite({
          consent_audit_id: args.consent_audit_id,
        });

        if (!snapshot || !snapshot.audit_confirmed) {
          await this.deps.delivery.recordOutcome({
            delivery_decision_id: args.delivery_decision_id,
            outcome: "dlq_audit_failed",
            latency_ms: this.deps.now() - start,
            provider_ref: null,
            delivery_attempt_n: args.delivery_attempt_n,
          });
          await this.emitDeliveryDecision({
            ...args,
            outcome: "dlq_audit_failed",
            latency_ms: this.deps.now() - start,
            provider_ref: null,
            audit_chain_verified: false,
          });
          throw new ConsentAuditFailedError(
            `read-after-write failed for consent_audit_id=${args.consent_audit_id}`
          );
        }

        // Step 2 — rate-limit (per-recipient AND per-provider).
        const recipientBucket = await this.deps.rateLimit.consume({
          bucket_key: `rl:voucher:dispatch:${args.market_id}:${args.recipient_id}`,
          bucket_size: this.deps.recipientBucketSize,
          refill_per_min: this.deps.recipientRefillPerMin,
        });
        const providerBucket = await this.deps.rateLimit.consume({
          bucket_key: `rl:voucher:dispatch:${args.market_id}:${this.deps.defaultProviderRef}`,
          bucket_size: this.deps.providerBucketSize,
          refill_per_min: this.deps.providerRefillPerMin,
        });

        if (!recipientBucket.allowed || !providerBucket.allowed) {
          const latency = this.deps.now() - start;
          await this.deps.delivery.recordOutcome({
            delivery_decision_id: args.delivery_decision_id,
            outcome: "dlq_rate_limited",
            latency_ms: latency,
            provider_ref: null,
            delivery_attempt_n: args.delivery_attempt_n,
          });
          await this.emitDeliveryDecision({
            ...args,
            outcome: "dlq_rate_limited",
            latency_ms: latency,
            provider_ref: null,
            audit_chain_verified: true,
          });
          return {
            outcome: "dlq_rate_limited",
            latency_ms: latency,
            provider_ref: null,
            audit_chain_verified: true,
          };
        }

        // Step 3 — dispatch (STUB v1.5.0; vendor integration v1.6.0+).
        // Real provider call would happen here. The stub provider always
        // succeeds — failure injection lives in chaos test.
        const provider_ref = this.deps.defaultProviderRef;

        // Step 4 — record decision (chained audit entry happens via the
        // audit port internally).
        const latency_ms = this.deps.now() - start;
        await this.deps.delivery.recordOutcome({
          delivery_decision_id: args.delivery_decision_id,
          outcome: "dispatched",
          latency_ms,
          provider_ref,
          delivery_attempt_n: args.delivery_attempt_n,
        });
        await this.deps.audit.appendAuditRow({
          market_id: args.market_id,
          payload: {
            action: "DELIVERY_DECISION_RECORDED",
            consent_audit_id: args.consent_audit_id,
            delivery_decision_id: args.delivery_decision_id,
            outcome: "dispatched",
            provider_ref,
            request_id: args.request_id,
          },
        });

        // Step 5 — emit observability event (≥95% sample target).
        await this.emitDeliveryDecision({
          ...args,
          outcome: "dispatched",
          latency_ms,
          provider_ref,
          audit_chain_verified: true,
        });

        return {
          outcome: "dispatched",
          latency_ms,
          provider_ref,
          audit_chain_verified: true,
        };
      }
    );
  }

  /**
   * D-66 symmetric path — withdraws consent, purges PII row immediately,
   * tombstones recipient, aborts any in-flight dispatch. Used by the
   * `voucher-withdrawal-immediate` subscriber.
   */
  async recordWithdrawalTransaction(
    input: RecordWithdrawalInput
  ): Promise<RecordWithdrawalResult> {
    const start = this.deps.now();

    // Tombstone PII row + emit withdrawal audit row + abort in-flight dispatch.
    const purge = await this.deps.pii.tombstoneByOrder({
      market_id: input.market_id,
      order_id: input.order_id,
    });
    const audit = await this.deps.audit.appendAuditRow({
      market_id: input.market_id,
      payload: {
        action: "WITHDRAWN",
        consent_audit_id: input.consent_audit_id,
        order_id: input.order_id,
        withdrawal_path: input.withdrawal_path,
        request_id: input.request_id,
      },
    });

    const latency_ms = this.deps.now() - start;
    await this.deps.events.emit({
      event_type: "gp.voucher.consent_withdrawn.v1",
      market_id: input.market_id,
      payload: {
        request_id: input.request_id,
        market_id: input.market_id,
        order_id: input.order_id,
        consent_audit_id: input.consent_audit_id,
        withdrawal_audit_id: audit.audit_id,
        withdrawal_path: input.withdrawal_path,
        outcome: "withdrawn",
        latency_ms,
        in_flight_dispatch_aborted: purge.rows_affected > 0,
      },
    });

    return {
      withdrawal_audit_id: audit.audit_id,
      outcome: "withdrawn",
      latency_ms,
      in_flight_dispatch_aborted: purge.rows_affected > 0,
    };
  }

  /**
   * Retention sweep — daily cron entrypoint. Returns counts for observability;
   * caller emits `voucher.pii.purged.v1` + `retention.cron.heartbeat`.
   */
  async purgeExpiredPii(args: {
    market_id: string;
    cutoff: Date;
    batch_size: number;
  }): Promise<{ rows_deleted: number; orphans_deleted: number }> {
    const purge = await this.deps.pii.purgeByMarketBefore(args);
    const orphans = await this.deps.pii.cleanupOrphans({
      batch_size: args.batch_size,
    });
    return {
      rows_deleted: purge.rows_deleted,
      orphans_deleted: orphans.rows_deleted,
    };
  }

  private async emitDeliveryDecision(args: {
    market_id: string;
    request_id: string;
    consent_audit_id: string;
    delivery_decision_id: string;
    outcome: DeliveryOutcome;
    latency_ms: number;
    provider_ref: string | null;
    audit_chain_verified: boolean;
    delivery_attempt_n: number;
  }): Promise<void> {
    await this.deps.events.emit({
      event_type: "gp.voucher.delivery_decision.v1",
      market_id: args.market_id,
      payload: {
        request_id: args.request_id,
        market_id: args.market_id,
        consent_audit_id: args.consent_audit_id,
        delivery_decision_id: args.delivery_decision_id,
        outcome: args.outcome,
        latency_ms: args.latency_ms,
        delivery_attempt_n: args.delivery_attempt_n,
        provider_ref: args.provider_ref,
        audit_chain_verified: args.audit_chain_verified,
      },
    });
  }
}
