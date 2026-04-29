/**
 * voucher-pii/ports.ts — Hexagonal-light port contracts (PAT-5).
 *
 * The module exports a service that orchestrates three persistence concerns
 * (PII row + audit row + delivery decision row) plus event emission. To keep
 * the orchestrator testable without a live Postgres + Redis + EventBus stack,
 * each concern is reified as a `Port` interface; the Postgres adapter
 * implements all three and is injected in production. Tests inject in-memory
 * fakes.
 *
 * Refs: PAT-5 (architecture.md — Hexagonal-light + ports.ts).
 */

import type {
  ConsentStateSnapshot,
  DeliveryOutcome,
  RecordConsentInput,
} from "./types";

/** PII data plane — voucher_recipient_pii table. */
export interface VoucherPiiPort {
  insertRecipientPii(input: {
    market_id: string;
    entitlement_id: string;
    order_id: string;
    recipient_email: string | null;
    recipient_phone: string | null;
    locale: string;
    is_gift: boolean;
  }): Promise<{ recipient_pii_id: string }>;

  tombstoneByOrder(args: {
    market_id: string;
    order_id: string;
  }): Promise<{ rows_affected: number }>;

  purgeByMarketBefore(args: {
    market_id: string;
    cutoff: Date;
    batch_size: number;
  }): Promise<{ rows_deleted: number }>;

  cleanupOrphans(args: { batch_size: number }): Promise<{ rows_deleted: number }>;
}

/** Audit chain port — wraps STORY-1-1's `voucher_pii_consent_audit` writes. */
export interface AuditChainPort {
  appendAuditRow(args: {
    market_id: string;
    payload: Record<string, unknown>;
  }): Promise<{ audit_id: string }>;

  getLatestForOrder(args: {
    market_id: string;
    order_id: string;
  }): Promise<ConsentStateSnapshot | null>;

  /**
   * Read-after-write check (D-72 step 1). Returns the snapshot if the audit
   * row is confirmed (committed + not withdrawn), null otherwise.
   */
  readAfterWrite(args: {
    consent_audit_id: string;
  }): Promise<ConsentStateSnapshot | null>;
}

/** Delivery decision port — single-row-per-consent-audit terminal record. */
export interface DeliveryDecisionPort {
  insertPending(args: {
    consent_audit_id: string;
    market_id: string;
  }): Promise<{ delivery_decision_id: string }>;

  recordOutcome(args: {
    delivery_decision_id: string;
    outcome: DeliveryOutcome;
    latency_ms: number;
    provider_ref: string | null;
    delivery_attempt_n: number;
  }): Promise<void>;
}

/** Idempotency primitive (Redis SETNX). */
export interface IdempotencyPort {
  withIdempotency<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T>;
}

/** Token-bucket rate limiter (Redis Lua). */
export interface RateLimitPort {
  consume(args: {
    bucket_key: string;
    bucket_size: number;
    refill_per_min: number;
  }): Promise<{ allowed: boolean; retry_after_ms: number }>;
}

/** Event bus port — publishes redacted observability envelopes. */
export interface EventEmitterPort {
  emit(event: {
    event_type: string;
    market_id: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

/** Composed module input (from Story 2.1's Server Action). */
export type ConsentTxInput = RecordConsentInput;
