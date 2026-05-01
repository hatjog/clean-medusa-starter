/**
 * MorPolicyEvaluator.ts — v1.5.0 runtime MoR policy evaluator (D-71).
 *
 * @see D-71 — Vendor MoR Policy Evaluation Contract
 * @see D-67 — tamper-evident audit log (STORY-1-1 primitives)
 * @see specs/adr/2026-04-30-adr-079-mor-runtime-per-offer-signature.md
 *
 * Responsibilities (6 ACs verbatim):
 *   1. implements `IMorPolicyEvaluator`; replaces `stub.ts` runtime path
 *      (stub preserved for unit-test isolation)
 *   2. per-offer HMAC-SHA256 signature on every `evaluate()` call;
 *      verifier rejects unsigned offers
 *   3. cross-validation gate D-78 — `validate_mor_per_offer_capability.py`
 *      WARN v1.5.0 / ERROR v1.6.0+
 *   4. DLQ classification per FM-71-RT-1..10 + FM-71-DLQ-1..2
 *   5. signing-key rotation (dual-key 30-day window per ADR-079)
 *   6. emits `mor.policy.evaluated.v1` event using STORY-1-1 audit primitives
 *
 * Design notes:
 *   - The runtime evaluator REUSES the stub for the actual MoR resolution
 *     decision (sale_mor_type/service_mor_type). v1.5.0 wraps the stub with
 *     the per-offer signature + retry + DLQ + audit pipeline. v1.6.0 will
 *     swap the stub for a YAML-driven policy loader; the runtime contract
 *     stays unchanged.
 *   - The `resolve()` method (single-context legacy) delegates straight to
 *     the stub, preserving v1.4.0 behaviour for non-MoR-runtime callers.
 *   - The `evaluate()` method (per-offer array) is the v1.5.0 entrypoint.
 *   - The `evaluateForOrder()` wrapper is `@deprecated v1.6.0`.
 */

import type {
  IMorPolicyEvaluator,
  MorContext,
  MorResolution,
} from "./types"
import { MorEvaluationError } from "./types"
import { StubMorPolicyEvaluator } from "./stub"
import {
  type EvaluationRequest,
  type MorEvaluationOutcome,
  type OfferContext,
  assertNonEmptyOfferContexts,
  truncateDecisionPath,
} from "./policy-contract"
import { signOffer } from "../../lib/mor-policy/sign-offer"
import {
  type DlqClassification,
  classifyFailure,
  promoteExhaustedRetry,
} from "./dlq"

const RETRY_MAX_ATTEMPTS = 3
const PER_ATTEMPT_TIMEOUT_MS = 1000
const RETRY_BASE_DELAY_MS = 50

/**
 * AuditLogPort — minimal port surface used by the evaluator for audit
 * persistence + event emission. STORY-1-1 ships the concrete impl
 * (tamper-evident audit table + hash chain). v1.5.0 evaluator depends only
 * on this narrow interface to keep the unit test seam clean.
 */
export interface AuditLogPort {
  /**
   * Append an audit entry. The implementation is responsible for:
   *  - writing to the sharded audit table
   *  - computing the hash chain link
   *  - emitting the `mor.policy.evaluated.v1` event downstream
   *
   * Returns the audit entry id (for traceability).
   */
  appendMorPolicyEvaluated(payload: MorPolicyEvaluatedPayload): Promise<string>
}

/**
 * MorPolicyEvaluatedPayload — wire shape of the `mor.policy.evaluated.v1`
 * event. Mirrors `mor.policy.evaluated.v1.schema.json` (D-71 observability
 * contract).
 */
export interface MorPolicyEvaluatedPayload {
  market_id: string
  order_id: string
  evaluation_request_id: string
  decision_path: string[]
  policy_version_snapshot: string
  latency_ms: number
  retry_count: number
  outcome: "ok" | "retry-replayed" | "dlq"
  signature_key_fingerprint: string
  /** Set only when outcome=`dlq`. */
  dlq_classification?: DlqClassification
}

/**
 * SnapshotStore — composite-idempotency-key persistence (D-71 Composite
 * Idempotency Key Pattern). Snapshot policy_version on FIRST attempt write;
 * subsequent retries replay the same snapshot.
 *
 * STORY-1-1 ships the durable impl backed by `order.metadata.gp.mor.*`. The
 * evaluator uses a port to keep tests hermetic.
 */
export interface SnapshotStore {
  read(orderId: string, evaluationRequestId: string): Promise<StoredSnapshot | null>
  writeFirstAttempt(orderId: string, evaluationRequestId: string, snapshot: StoredSnapshot): Promise<void>
}

export interface StoredSnapshot {
  policy_version: string
  decision_path: string[]
  signature: string
  signature_key_fingerprint: string
}

/**
 * In-memory default for the snapshot store (used in dev + unit tests). The
 * production wiring substitutes a Medusa-container-backed impl.
 */
export class InMemorySnapshotStore implements SnapshotStore {
  private readonly map = new Map<string, StoredSnapshot>()

  async read(
    orderId: string,
    evaluationRequestId: string
  ): Promise<StoredSnapshot | null> {
    return this.map.get(this.key(orderId, evaluationRequestId)) ?? null
  }

  async writeFirstAttempt(
    orderId: string,
    evaluationRequestId: string,
    snapshot: StoredSnapshot
  ): Promise<void> {
    const key = this.key(orderId, evaluationRequestId)
    if (!this.map.has(key)) {
      this.map.set(key, snapshot)
    }
  }

  private key(orderId: string, evaluationRequestId: string): string {
    return `${orderId}::${evaluationRequestId}`
  }
}

/** No-op audit port for tests / smoke endpoints. Production = STORY-1-1 impl. */
export class NoopAuditLog implements AuditLogPort {
  public readonly entries: MorPolicyEvaluatedPayload[] = []
  async appendMorPolicyEvaluated(
    payload: MorPolicyEvaluatedPayload
  ): Promise<string> {
    this.entries.push(payload)
    return `audit-${this.entries.length}`
  }
}

export interface MorPolicyEvaluatorOptions {
  /** Override for the underlying decision engine (defaults to stub). */
  innerEvaluator?: IMorPolicyEvaluator
  auditLog?: AuditLogPort
  snapshotStore?: SnapshotStore
  /** For testability — injectable clock + sleeper. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * MorPolicyEvaluator — production runtime evaluator wiring stub + signature
 * + retry + DLQ + audit.
 *
 * Implements `IMorPolicyEvaluator` (sync `resolve()` for legacy callsites)
 * AND the new per-offer async `evaluate()` entrypoint (D-71).
 */
export class MorPolicyEvaluator implements IMorPolicyEvaluator {
  private readonly inner: IMorPolicyEvaluator
  private readonly auditLog: AuditLogPort
  private readonly snapshotStore: SnapshotStore
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: MorPolicyEvaluatorOptions = {}) {
    this.inner = opts.innerEvaluator ?? new StubMorPolicyEvaluator()
    this.auditLog = opts.auditLog ?? new NoopAuditLog()
    this.snapshotStore = opts.snapshotStore ?? new InMemorySnapshotStore()
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /**
   * Legacy single-context resolution (preserves v1.4.0 sync semantics for
   * non-runtime callers like type-contract tests).
   */
  resolve(ctx: MorContext): MorResolution {
    return this.inner.resolve(ctx)
  }

  /**
   * v1.5.0 per-offer evaluation (D-71 mandatory array signature).
   *
   * Each offer in `offer_contexts` is signed via {@link signOffer} (HMAC-SHA256)
   * and the signature is recorded in the audit `decision_path`.
   *
   * @throws Error("offer_context cannot be empty array") on empty input
   * @throws MorEvaluationError on unrecoverable evaluator failures
   */
  async evaluate(request: EvaluationRequest): Promise<MorEvaluationOutcome[]> {
    assertNonEmptyOfferContexts(request.offer_contexts)

    // D-71 idempotency replay: read snapshot for composite key.
    const existingSnapshot = await this.snapshotStore.read(
      request.order_id,
      request.evaluation_request_id
    )

    const outcomes: MorEvaluationOutcome[] = []
    for (const offer of request.offer_contexts) {
      const outcome = await this.evaluateOne(request, offer, existingSnapshot)
      outcomes.push(outcome)
    }
    return outcomes
  }

  /**
   * @deprecated v1.6.0 — Use {@link MorPolicyEvaluator.evaluate} with the
   * mandatory `offer_contexts: OfferContext[]` array signature instead.
   *
   * v1.5.0 wrapper: calls `evaluate(order, [singleOffer])` to bridge legacy
   * single-offer callsites. Will be removed in v1.6.0 once
   * `multi_vendor_pricing_enabled=true` flips ON globally (D-78 cross-track
   * gate).
   */
  async evaluateForOrder(
    request: Omit<EvaluationRequest, "offer_contexts">,
    singleOffer: OfferContext
  ): Promise<MorEvaluationOutcome> {
    const outcomes = await this.evaluate({
      ...request,
      offer_contexts: [singleOffer],
    })
    return outcomes[0]!
  }

  // -- internal --------------------------------------------------------------

  private async evaluateOne(
    request: EvaluationRequest,
    offer: OfferContext,
    existingSnapshot: StoredSnapshot | null
  ): Promise<MorEvaluationOutcome> {
    const startMs = this.now()
    let retry_count = 0
    let lastClassification: DlqClassification | null = null

    while (retry_count < RETRY_MAX_ATTEMPTS) {
      try {
        // Per-attempt strict timeout (D-71 Per-Attempt Strict Timeout Pattern).
        const resolution = await this.runWithTimeout(
          () =>
            Promise.resolve(
              this.inner.resolve({
                market_id: request.market_id,
                vendor_id: offer.vendor_id,
                voucher_kind: offer.voucher_kind,
                product_category: request.base_context.product_category,
              })
            ),
          PER_ATTEMPT_TIMEOUT_MS
        )

        const decisionPath = truncateDecisionPath([
          `policy:${resolution.mor_policy_version}`,
          `sale_mor:${resolution.sale_mor_type}`,
          `service_mor:${resolution.service_mor_type ?? "none"}`,
          ...(offer.breakage_override
            ? [`breakage_override:${offer.breakage_override}`]
            : []),
        ])

        // D-71 Per-Offer Signature: every evaluate() signs the offer.
        const signed = signOffer({
          offer_id: offer.offer_id,
          vendor_id: offer.vendor_id,
          order_id: request.order_id,
          market_id: request.market_id,
          policy_version: resolution.mor_policy_version,
        })

        // Snapshot first-attempt write (idempotency: replay reuses snapshot).
        const snapshot: StoredSnapshot = existingSnapshot ?? {
          policy_version: resolution.mor_policy_version,
          decision_path: decisionPath,
          signature: signed.signature,
          signature_key_fingerprint: signed.key_fingerprint,
        }
        await this.snapshotStore.writeFirstAttempt(
          request.order_id,
          request.evaluation_request_id,
          snapshot
        )

        const latency_ms = this.now() - startMs
        const outcomeKind: MorEvaluationOutcome["outcome"] = existingSnapshot
          ? "retry-replayed"
          : "ok"

        await this.auditLog.appendMorPolicyEvaluated({
          market_id: request.market_id,
          order_id: request.order_id,
          evaluation_request_id: request.evaluation_request_id,
          decision_path: snapshot.decision_path,
          policy_version_snapshot: snapshot.policy_version,
          latency_ms,
          retry_count,
          outcome: outcomeKind,
          signature_key_fingerprint: snapshot.signature_key_fingerprint,
        })

        return {
          offer_id: offer.offer_id,
          resolution,
          decision_path: snapshot.decision_path,
          signed_offer: signed,
          latency_ms,
          retry_count,
          outcome: outcomeKind,
        }
      } catch (err) {
        // Contract violations (MorEvaluationError sub-codes) are NOT retried.
        if (err instanceof MorEvaluationError) {
          throw err
        }
        lastClassification = classifyFailure(err)
        if (!lastClassification.is_retryable) {
          break
        }
        retry_count += 1
        if (retry_count >= RETRY_MAX_ATTEMPTS) {
          break
        }
        // Exponential backoff + jitter.
        const jitter = Math.floor(Math.random() * RETRY_BASE_DELAY_MS)
        await this.sleep(RETRY_BASE_DELAY_MS * 2 ** (retry_count - 1) + jitter)
      }
    }

    // Retry budget exhausted OR terminal failure → DLQ.
    const finalClassification = lastClassification
      ? promoteExhaustedRetry(lastClassification)
      : {
          tier: "dlq_pending_ops_review" as const,
          failure_mode: "FM-71-DLQ-2" as const,
          is_retryable: false,
          sqlstate: null,
          reason: "evaluator did not produce an outcome",
        }

    const latency_ms = this.now() - startMs
    await this.auditLog.appendMorPolicyEvaluated({
      market_id: request.market_id,
      order_id: request.order_id,
      evaluation_request_id: request.evaluation_request_id,
      decision_path: [`dlq:${finalClassification.failure_mode}`],
      policy_version_snapshot: "unresolved",
      latency_ms,
      retry_count,
      outcome: "dlq",
      signature_key_fingerprint: "n/a",
      dlq_classification: finalClassification,
    })

    throw new MorEvaluationError({
      code: "MISSING_CONFIG",
      message: `MorPolicyEvaluator: evaluation failed (${finalClassification.failure_mode}); ${finalClassification.reason}`,
      context: {
        market_id: request.market_id,
        vendor_id: offer.vendor_id,
        voucher_kind: offer.voucher_kind,
      },
    })
  }

  private async runWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`mor-policy: per-attempt timeout ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ])
  }
}
