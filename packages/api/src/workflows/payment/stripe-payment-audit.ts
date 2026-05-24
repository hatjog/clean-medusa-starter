import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createStep,
  createWorkflow,
  StepResponse,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"

// C1 / Story 1.8 security decision (2026-05-17): the manual refund executed by
// the operator in the Stripe Dashboard is the SOURCE OF TRUTH. The
// `payment.refunded` webhook path is reconcile/audit-only — it MUST NOT create
// a second refund at the provider. The Medusa-native `refundPaymentWorkflow`
// (`@medusajs/core-flows`) is intentionally NOT imported/called here: it routes
// `refundPaymentStep → paymentModuleService.refundPayment() → provider.refundPayment()`
// which for Stripe issues a real `stripe.refunds.create()` (double-refund risk).
// AC1 wording still says `refundPaymentWorkflow`; that wording↔code conflict is
// closed as a contract-semver / story-wording deferral (see Dev Agent Record +
// review Fixes Applied) — code stays reconcile-only.

import {
  compensateIssuedEntitlement,
  issueEntitlementsForAllLineItems,
  MissingEntitlementProfileError,
  revokeEntitlementsOnRefund,
  type IssueEntitlementResult,
  type MultiLineEntitlementResult,
  type RefundEntitlementRevocationResult,
} from "../entitlements/issue-entitlement"
import type { EntitlementType } from "../../modules/voucher/models/entitlement"
import { redactFailureCode } from "../../lib/payment/failure-classification"

export const STRIPE_PAYMENT_EVENTS = [
  "payment.captured",
  "payment.failed",
  "payment.canceled",
  "payment.refunded",
] as const

export type StripePaymentEventName = (typeof STRIPE_PAYMENT_EVENTS)[number]
export type PaymentAuditOutcome = "captured" | "failed" | "canceled" | "refunded"

export type StripePaymentAuditPayload = {
  id?: string
  event_id?: string
  request_id?: string
  payment_intent_id?: string
  payment_id?: string
  order_id?: string
  market_id?: string | null
  payment_method_type?: string | null
  processing_country?: string | null
  failure_code?: string | null
  decline_code?: string | null
  amount_minor?: number | null
  currency?: string | null
  refund_id?: string | null
  refund_amount?: number | null
  refund_reason?: string | null
  entitlement_profile?: {
    profile_id?: string
    entitlement_type?: EntitlementType | string
    policy?: Record<string, unknown>
    currency?: string
    amount_minor?: number
    line_item_id?: string | null
  } | null
}

export type PaymentAuditEnvelope = {
  level: "info" | "warn" | "error"
  actor: "system"
  scope: string
  request_id: string
  outcome: PaymentAuditOutcome
  lifecycle_status: "paid" | "failed" | "refunded"
  event_type: StripePaymentEventName
  timestamp: string
  failure_code?: string
  decline_code?: string
  payment_method_type?: string
  processing_country?: string
  currency?: string
  refund_id?: string
  refund_amount?: number
  refund_reason?: string
  // Story 1.10.1 GAP #3 — fail-loud surface for missing entitlement_profile.
  // Set when payment.captured with order_id reaches issueEntitlementWithinPaymentTransaction
  // but MissingEntitlementProfileError is thrown (catalog→checkout propagation gap,
  // GAP #1). The audit row IS still persisted (webhook ack = OK; no rollback), but
  // the structured key is the durable, queryable failure signal — replaces the
  // previous silent warn that violated Story 1.3 "Fail-loud, NIE silent".
  entitlement_issue_failed_reason?: string
  /**
   * v1.9.0 wf5 (H-2 / F-CC1-003): set when payment.captured arrived BEFORE
   * the storefront finalized the order (no `order_id` on the payload). A
   * downstream `order.placed` subscriber will scan this key and retroactively
   * re-issue entitlement once the order materializes. Durable + queryable.
   */
  entitlement_issue_deferred_reason?: string
  /** v1.9.0 wf5 H-3: count of entitlement rows transitioned ACTIVE→REFUNDED on payment.refunded. */
  revoked_entitlement_count?: number
  /** v1.9.0 wf5 H-3: count of already-terminal rows skipped during refund. */
  already_terminal_entitlement_count?: number
}

// Reconcile-only result. There is no provider mutation on this path, so there
// is nothing to compensate (manual Stripe refund already happened and is the
// source of truth). `reconciled` records that the audit/reconcile side-effect
// ran exactly once for this event_id; `skipped` + `skipReason` make replay /
// non-refund no-ops explicit (NOT a silent success — AC2 / C3).
export type StripeRefundReconcileResult = {
  payment_id: string
  refund_id?: string | null
  refund_amount?: number | null
  reconciled: boolean
  skipped: boolean
  skipReason?: "not-a-refund-event" | "replay-deduplicated"
  degraded?: boolean
}

export type StripePaymentAuditResult = {
  event_id: string
  envelope: PaymentAuditEnvelope
  deduplicated: boolean
  /**
   * Backward-compat single-entitlement field. v1.9.0 H-6 multi-product cart
   * fix: when multiple voucher lines yield N entitlements, this is the first
   * issued instance and `entitlements_all` carries the full set. Single-line
   * carts: `entitlement === entitlements_all[0]`.
   */
  entitlement?: IssueEntitlementResult
  /** v1.9.0 H-6: all entitlements issued for this payment (one per voucher line). */
  entitlements_all?: IssueEntitlementResult[]
  refundReconcile?: StripeRefundReconcileResult
  /** v1.9.0 wf5 (H-3 / F-CC1-002): entitlement revocation outcome for payment.refunded. */
  refundRevocation?: RefundEntitlementRevocationResult
}

type QueryResult<T> = Promise<{ rows: T[]; rowCount?: number | null }>
type PgClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>
  ) => QueryResult<T>
  release: () => void
}
type PgPool = {
  connect: () => Promise<PgClient>
}
type KnexLike = {
  raw: (
    sql: string,
    bindings?: ReadonlyArray<unknown>
  ) => Promise<{ rows?: unknown[]; rowCount?: number | null } | unknown[]>
  transaction: <T>(handler: (trx: KnexLike) => Promise<T>) => Promise<T>
}

type EventBusLike = {
  emit?: (message: { name: string; data: unknown }) => Promise<unknown>
}

type LoggerLike = {
  info?: (message: string, meta?: unknown) => void
  warn?: (message: string, meta?: unknown) => void
  error?: (message: string, meta?: unknown) => void
}

export class MissingNativeStripePayloadFieldError extends Error {
  constructor(fields: string[]) {
    super(`missing required native Stripe payment field(s): ${fields.join(", ")}`)
    this.name = "MissingNativeStripePayloadFieldError"
  }
}

export class StripePaymentAuditWorkflow {
  constructor(
    private readonly db: PgPool | KnexLike,
    private readonly eventBus?: EventBusLike,
    private readonly logger?: LoggerLike
  ) {}

  async process(
    eventType: StripePaymentEventName,
    payload: StripePaymentAuditPayload,
    now = new Date()
  ): Promise<StripePaymentAuditResult> {
    const result = await this.processMutation(eventType, payload, now)
    await this.emit(result, payload, now)
    return result
  }

  async processMutation(
    eventType: StripePaymentEventName,
    payload: StripePaymentAuditPayload,
    now = new Date()
  ): Promise<StripePaymentAuditResult> {
    assertNativeStripePayload(eventType, payload)
    const envelope = buildPaymentAuditEnvelope(eventType, payload, now)
    const eventId = payload.event_id as string

    return this.withTransaction(async (client) => {
      let entitlement: IssueEntitlementResult | undefined
      let entitlementsAll: IssueEntitlementResult[] | undefined
      let refundRevocation: RefundEntitlementRevocationResult | undefined
      const inserted = await insertDedupRow(client, payload, envelope)
      if (!inserted) {
        return { event_id: eventId, envelope, deduplicated: true }
      }

      // v1.9.0 wf5 (H-2 / F-CC1-003): webhook-before-order race fail-loud.
      // Pre-fix: silent no-op when `payload.order_id` was absent (BLIK/P24
      // instant payments often deliver the captured webhook before the
      // storefront calls /carts/:id/complete). Customer paid, no entitlement,
      // no queryable signal. Now: persist `entitlement_issue_deferred_reason`
      // onto the dedup row envelope so a `order.placed` subscriber can find
      // it later and replay; operator gets a durable audit signal.
      if (eventType === "payment.captured" && !payload.order_id) {
        envelope.entitlement_issue_deferred_reason = "webhook_before_order"
        await persistAuditDeferredKey(
          client,
          payload.event_id as string,
          "webhook_before_order"
        )
        this.logger?.warn?.(
          `[stripe-payment-audit] payment.captured WITHOUT order_id (race) ` +
            `payment_intent_id=${payload.payment_intent_id} — audit row persisted ` +
            `with envelope.entitlement_issue_deferred_reason=webhook_before_order; ` +
            `order.placed subscriber will retry entitlement issuance.`
        )
      }

      if (eventType === "payment.captured" && payload.order_id) {
        try {
          // v1.9.0 wf5 H-6 fix: iterate ALL voucher line items (multi-line
          // carts) rather than collapsing to LIMIT 1.
          const multi: MultiLineEntitlementResult =
            await issueEntitlementsForAllLineItems(
              client,
              {
                event_id: payload.event_id as string,
                order_id: payload.order_id as string,
                payment_id: payload.payment_id,
                payment_intent_id: payload.payment_intent_id,
                market_id: payload.market_id,
                amount_minor: payload.amount_minor,
                currency: payload.currency,
                entitlement_profile: payload.entitlement_profile,
              },
              now
            )
          if (multi.results.length === 0) {
            throw new MissingEntitlementProfileError(payload.order_id as string)
          }
          entitlementsAll = multi.results
          entitlement = multi.results[0]
        } catch (err) {
          if (!(err instanceof MissingEntitlementProfileError)) {
            throw err
          }
          envelope.entitlement_issue_failed_reason = err.message
          await persistAuditFailureKey(
            client,
            payload.event_id as string,
            err.message
          )
          this.logger?.error?.(
            `[stripe-payment-audit] ${eventType} order_id=${payload.order_id} ` +
              `entitlement_issue_failed: ${err.message} — audit row persisted ` +
              `with envelope.entitlement_issue_failed_reason; investigate ` +
              `catalog→checkout entitlement_profile propagation (Story 1.10.1)`
          )
        }
      }

      // v1.9.0 wf5 H-3 / F-CC1-002 (P0_FINANCIAL_EXPOSURE): refund webhook
      // transitions entitlement state ACTIVE → REFUNDED for ALL entitlement
      // rows attached to the refunded order. Idempotent (terminal-state
      // guard); runs in the SAME transaction as the audit-row insert so a
      // half-applied refund is impossible. Closes the long-standing financial
      // exposure where a refunded Stripe charge co-existed with an ACTIVE,
      // redeemable voucher.
      if (eventType === "payment.refunded" && payload.order_id) {
        refundRevocation = await revokeEntitlementsOnRefund(
          client,
          payload.order_id as string,
          now
        )
        envelope.revoked_entitlement_count =
          refundRevocation.revoked_entitlement_ids.length
        envelope.already_terminal_entitlement_count =
          refundRevocation.already_terminal_entitlement_ids.length
        // Persist the revocation summary onto the dedup row so the admin
        // refund-history view (F-CC1-018) can join it.
        await persistAuditRevocationKey(
          client,
          payload.event_id as string,
          refundRevocation
        )
        this.logger?.info?.(
          `[stripe-payment-audit] payment.refunded order_id=${payload.order_id} ` +
            `revoked=${refundRevocation.revoked_entitlement_ids.length} ` +
            `already_terminal=${refundRevocation.already_terminal_entitlement_ids.length}`
        )
      }

      return {
        event_id: eventId,
        envelope,
        deduplicated: false,
        entitlement,
        entitlements_all: entitlementsAll,
        refundRevocation,
      }
    })
  }

  async emit(
    result: StripePaymentAuditResult,
    payload: StripePaymentAuditPayload,
    now = new Date()
  ): Promise<void> {
    if (result.deduplicated) return
    emitAuditLog(this.logger, result.envelope)
    await this.eventBus?.emit?.({
      name: `payment_audit.${result.envelope.outcome}`,
      data: result.envelope,
    })
    if (result.envelope.event_type === "payment.failed") {
      await this.eventBus?.emit?.({
        name: "gp.payments.payment_failed.v1",
        data: buildPaymentFailedContractEvent(result, payload, now),
      })
    }
    // v1.9.0 wf5 H-1 fix: wire the canonical payment_paid producer (was a
    // dead contract — schema validated but zero emit calls). Mirrors the
    // payment_failed pattern. Closes Epic-1 HIGH H-1 (Story 1.3 AC9 / FR1.4
    // traceability) so downstream consumers (MoR reconciliation, analytics
    // warehouse) see captured events for BonBeauty paid orders.
    if (result.envelope.event_type === "payment.captured") {
      await this.eventBus?.emit?.({
        name: "gp.payments.payment_paid.v1",
        data: buildPaymentPaidContractEvent(result, payload, now),
      })
    }
    // v1.9.0 wf5 (companion to H-3): emit canonical payment_refunded for the
    // refund webhook so downstream consumers can audit revocation in tandem.
    if (result.envelope.event_type === "payment.refunded") {
      await this.eventBus?.emit?.({
        name: "gp.payments.payment_refunded.v1",
        data: buildPaymentRefundedContractEvent(result, payload, now),
      })
    }
    if (result.entitlement) {
      await this.eventBus?.emit?.({
        name: "gp.entitlements.entitlement_issued.v1",
        data: {
          schema_version: "1",
          event_type: "gp.entitlements.entitlement_issued.v1",
          occurred_at: now.toISOString(),
          actor: "system",
          scope: {
            instance_id: "gp-dev",
            market_id: payload.market_id ?? "unknown",
            vendor_id: null,
            location_id: null,
          },
          idempotency_key: `entitlement:${result.entitlement.entitlement_id}`,
          payload: {
            entitlement_id: result.entitlement.entitlement_id,
            order_id: payload.order_id,
            payment_id: payload.payment_id ?? payload.payment_intent_id,
            entitlement_type: payload.entitlement_profile?.entitlement_type,
            currency: payload.entitlement_profile?.currency ?? payload.currency ?? "PLN",
            amount_minor:
              payload.entitlement_profile?.amount_minor ?? payload.amount_minor ?? 0,
            items_count: 1,
          },
        },
      })
    }
  }

  async compensate(result: StripePaymentAuditResult | undefined): Promise<void> {
    if (!result || result.deduplicated) return
    await this.withTransaction(async (client) => {
      await compensateIssuedEntitlement(client, result.entitlement)
      await client.query(
        `DELETE FROM webhook_event_processed WHERE event_id = $1 AND provider = 'stripe'`,
        [result.event_id]
      )
    })
  }

  private async withTransaction<T>(handler: (client: PgClient) => Promise<T>): Promise<T> {
    if (isPgPool(this.db)) {
      const client = await this.db.connect()
      try {
        await client.query("BEGIN")
        const result = await handler(client)
        await client.query("COMMIT")
        return result
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined)
        throw err
      } finally {
        client.release()
      }
    }

    return this.db.transaction(async (trx) => handler(createKnexPgClient(trx)))
  }
}

function emitAuditLog(logger: LoggerLike | undefined, envelope: PaymentAuditEnvelope): void {
  try {
    if (envelope.level === "error") {
      logger?.error?.("[stripe-payment-audit]", envelope)
    } else if (envelope.level === "warn") {
      logger?.warn?.("[stripe-payment-audit]", envelope)
    } else {
      logger?.info?.("[stripe-payment-audit]", envelope)
    }
  } catch {
    // Audit persistence is the source of truth; logger binding issues must not
    // trigger workflow compensation.
  }
}

function assertNativeStripePayload(
  eventType: StripePaymentEventName,
  payload: StripePaymentAuditPayload
): void {
  const required = [
    "event_id",
    "request_id",
    "payment_intent_id",
    "payment_method_type",
    "processing_country",
  ]
  if (eventType === "payment.failed") required.push("failure_code")

  const missing = required.filter((field) => {
    const value = payload[field as keyof StripePaymentAuditPayload]
    return value === undefined || value === null || value === ""
  })
  if (missing.length > 0) {
    throw new MissingNativeStripePayloadFieldError(missing)
  }
}

export function buildPaymentAuditEnvelope(
  eventType: StripePaymentEventName,
  payload: StripePaymentAuditPayload,
  now = new Date()
): PaymentAuditEnvelope {
  const outcome = eventType.slice("payment.".length) as PaymentAuditOutcome
  const lifecycle_status =
    outcome === "captured" ? "paid" : outcome === "refunded" ? "refunded" : "failed"
  const level = outcome === "captured" || outcome === "refunded" ? "info" : "warn"
  const envelope: PaymentAuditEnvelope = {
    level,
    actor: "system",
    scope: `payment_intent:${payload.payment_intent_id}`,
    request_id: payload.request_id as string,
    outcome,
    lifecycle_status,
    event_type: eventType,
    timestamp: now.toISOString(),
    payment_method_type: payload.payment_method_type ?? undefined,
    processing_country: payload.processing_country ?? undefined,
  }
  const failureCode = redactFailureCode(payload.failure_code)
  if (failureCode) envelope.failure_code = failureCode
  if (payload.decline_code) envelope.decline_code = payload.decline_code
  // v1.9.0 wf5 M-8 fix: persist currency for ALL outcomes (was refund-only).
  // Downstream consumers (audit ingestion, MoR reconciliation, v1.10.0+
  // multi-currency markets) need `currency` on the lifecycle_status=paid
  // envelope too. Move out of the refund-only branch.
  if (payload.currency) envelope.currency = payload.currency.toUpperCase()
  if (eventType === "payment.refunded") {
    if (payload.refund_id) envelope.refund_id = payload.refund_id
    envelope.refund_amount = payload.refund_amount ?? undefined
    envelope.refund_reason = payload.refund_reason ?? "unspecified"
  }
  return envelope
}

async function insertDedupRow(
  client: PgClient,
  payload: StripePaymentAuditPayload,
  envelope: PaymentAuditEnvelope
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO webhook_event_processed
       (event_id, provider, market_id, envelope, received_at)
     VALUES ($1, 'stripe', $2, $3::jsonb, NOW())
     ON CONFLICT (event_id, provider) DO NOTHING`,
    [payload.event_id, payload.market_id ?? null, JSON.stringify(envelope)]
  )
  return (result.rowCount ?? 0) === 1
}

/**
 * Story 1.10.1 GAP #3 — persist `entitlement_issue_failed_reason` onto the
 * already-inserted `webhook_event_processed` envelope so the failure signal
 * survives webhook replay (the in-memory envelope is lost on re-delivery; the
 * row is the durable audit truth). JSONB merge preserves any other envelope
 * keys already written by `insertDedupRow`.
 *
 * v1.9.0 wf5 L-1 fix: only sets the key if it is not already present, so a
 * future refactor cannot accidentally overwrite a different failure reason
 * already recorded for the same event_id.
 */
async function persistAuditFailureKey(
  client: PgClient,
  eventId: string,
  reason: string
): Promise<void> {
  await client.query(
    `UPDATE webhook_event_processed
        SET envelope = envelope || jsonb_build_object('entitlement_issue_failed_reason', $2::text)
      WHERE event_id = $1
        AND provider = 'stripe'
        AND NOT (envelope ? 'entitlement_issue_failed_reason')`,
    [eventId, reason]
  )
}

/**
 * v1.9.0 wf5 (H-2 / F-CC1-003): persist deferred-reason on the dedup row when
 * a `payment.captured` webhook arrived before the order was finalized. A
 * downstream `order.placed` subscriber (see `on-order-placed-stripe-retry.ts`)
 * scans this key and re-issues entitlement retroactively.
 */
async function persistAuditDeferredKey(
  client: PgClient,
  eventId: string,
  reason: string
): Promise<void> {
  await client.query(
    `UPDATE webhook_event_processed
        SET envelope = envelope || jsonb_build_object('entitlement_issue_deferred_reason', $2::text)
      WHERE event_id = $1
        AND provider = 'stripe'
        AND NOT (envelope ? 'entitlement_issue_deferred_reason')`,
    [eventId, reason]
  )
}

/**
 * v1.9.0 wf5 (H-3 / F-CC1-002 P0): persist refund revocation summary onto the
 * dedup row so the admin refund-history view can render the per-refund
 * "voucher revoked ✓/✗" signal (F-CC1-018).
 */
async function persistAuditRevocationKey(
  client: PgClient,
  eventId: string,
  revocation: RefundEntitlementRevocationResult
): Promise<void> {
  await client.query(
    `UPDATE webhook_event_processed
        SET envelope = envelope || jsonb_build_object(
              'revoked_entitlement_ids', $2::jsonb,
              'revoked_entitlement_count', $3::int,
              'already_terminal_entitlement_ids', $4::jsonb,
              'already_terminal_entitlement_count', $5::int
            )
      WHERE event_id = $1 AND provider = 'stripe'`,
    [
      eventId,
      JSON.stringify(revocation.revoked_entitlement_ids),
      revocation.revoked_entitlement_ids.length,
      JSON.stringify(revocation.already_terminal_entitlement_ids),
      revocation.already_terminal_entitlement_ids.length,
    ]
  )
}

export function buildPaymentFailedContractEvent(
  result: StripePaymentAuditResult,
  payload: StripePaymentAuditPayload,
  now = new Date()
): Record<string, unknown> {
  const envelope = result.envelope
  const marketId = payload.market_id ?? "unknown"
  const paymentId = payload.payment_id ?? payload.payment_intent_id ?? "unknown"
  const providerPaymentId = payload.payment_intent_id ?? paymentId
  const failureCode = envelope.failure_code ?? redactFailureCode(payload.failure_code) ?? "unknown"

  return {
    schema_version: "1",
    event_type: "gp.payments.payment_failed.v1",
    occurred_at: now.toISOString(),
    actor: "system",
    scope: {
      instance_id: "gp-dev",
      market_id: marketId,
      vendor_id: null,
      location_id: null,
    },
    idempotency_key: `${marketId}:${providerPaymentId}:payment_failed`,
    correlation_id: payload.order_id ?? paymentId,
    causation_id: `stripe:webhook:${result.event_id}`,
    payload: {
      payment_id: paymentId,
      order_id: payload.order_id ?? null,
      provider_id: "stripe",
      provider_payment_id: providerPaymentId,
      failure_code: failureCode,
      decline_code: envelope.decline_code ?? payload.decline_code ?? null,
      payment_method_type:
        envelope.payment_method_type ?? payload.payment_method_type ?? "unknown",
      processing_country:
        envelope.processing_country ?? payload.processing_country ?? "unknown",
    },
  }
}

/**
 * v1.9.0 wf5 H-1 fix — `gp.payments.payment_paid.v1` contract event builder.
 *
 * Schema: `specs/contracts/events/schemas/payloads/gp.payments.payment_paid.v1.schema.json`.
 * Required fields: `payment_id`, `order_id`, `provider_id`, `currency`,
 * `paid_amount_minor`.
 *
 * Provider id literal `stripe` (NOT `pp_stripe` / `pp_stripe_stripe`) per
 * F-CC1-006/008 canonical-id decision (Stripe SDK provider name).
 */
export function buildPaymentPaidContractEvent(
  result: StripePaymentAuditResult,
  payload: StripePaymentAuditPayload,
  now = new Date()
): Record<string, unknown> {
  const envelope = result.envelope
  const marketId = payload.market_id ?? "unknown"
  const paymentId = payload.payment_id ?? payload.payment_intent_id ?? "unknown"
  const providerPaymentId = payload.payment_intent_id ?? paymentId
  const currency = envelope.currency ?? payload.currency?.toUpperCase() ?? "PLN"
  const paidAmountMinor = typeof payload.amount_minor === "number" ? payload.amount_minor : 0

  return {
    schema_version: "1",
    event_type: "gp.payments.payment_paid.v1",
    occurred_at: now.toISOString(),
    actor: "system",
    scope: {
      instance_id: "gp-dev",
      market_id: marketId,
      vendor_id: null,
      location_id: null,
    },
    idempotency_key: `${marketId}:${providerPaymentId}:payment_paid`,
    correlation_id: payload.order_id ?? paymentId,
    causation_id: `stripe:webhook:${result.event_id}`,
    payload: {
      payment_id: paymentId,
      order_id: payload.order_id ?? paymentId,
      provider_id: "stripe",
      provider_payment_id: providerPaymentId,
      request_id: envelope.request_id ?? payload.request_id ?? null,
      method: payload.payment_method_type ?? null,
      payment_method_type: envelope.payment_method_type ?? payload.payment_method_type ?? null,
      processing_country: envelope.processing_country ?? payload.processing_country ?? null,
      currency,
      paid_amount_minor: paidAmountMinor,
      fees_minor: null,
      psp_occurred_at: now.toISOString(),
    },
  }
}

/**
 * v1.9.0 wf5 — `gp.payments.payment_refunded.v1` contract event builder.
 *
 * Companion to H-1 (`gp.payments.payment_paid.v1` producer wiring). Closes
 * the matching schema-without-producer gap on the refund side. Carries the
 * revocation summary populated by `revokeEntitlementsOnRefund` so downstream
 * consumers can correlate refund → entitlement revocation in one event.
 */
export function buildPaymentRefundedContractEvent(
  result: StripePaymentAuditResult,
  payload: StripePaymentAuditPayload,
  now = new Date()
): Record<string, unknown> {
  const envelope = result.envelope
  const marketId = payload.market_id ?? "unknown"
  const paymentId = payload.payment_id ?? payload.payment_intent_id ?? "unknown"
  const providerPaymentId = payload.payment_intent_id ?? paymentId
  const currency = envelope.currency ?? payload.currency?.toUpperCase() ?? "PLN"
  const refundAmountMinor =
    typeof payload.refund_amount === "number" ? payload.refund_amount : 0

  return {
    schema_version: "1",
    event_type: "gp.payments.payment_refunded.v1",
    occurred_at: now.toISOString(),
    actor: "system",
    scope: {
      instance_id: "gp-dev",
      market_id: marketId,
      vendor_id: null,
      location_id: null,
    },
    idempotency_key: `${marketId}:${providerPaymentId}:payment_refunded:${
      payload.refund_id ?? result.event_id
    }`,
    correlation_id: payload.order_id ?? paymentId,
    causation_id: `stripe:webhook:${result.event_id}`,
    payload: {
      payment_id: paymentId,
      order_id: payload.order_id ?? null,
      provider_id: "stripe",
      provider_payment_id: providerPaymentId,
      refund_id: payload.refund_id ?? null,
      refund_amount_minor: refundAmountMinor,
      refund_reason: payload.refund_reason ?? envelope.refund_reason ?? "unspecified",
      currency,
      revoked_entitlement_ids: result.refundRevocation?.revoked_entitlement_ids ?? [],
      revoked_entitlement_count:
        result.refundRevocation?.revoked_entitlement_ids?.length ?? 0,
    },
  }
}

export type ReconcileRefundInput = {
  eventType: StripePaymentEventName
  deduplicated: boolean
  payment_id?: string | null
  payment_intent_id?: string | null
  refund_id?: string | null
  refund_amount?: number | null
  refund_reason?: string | null
}

// Pure, testable reconcile-only logic (C1/C2/C3/C5). NO provider call.
//   - Not a refund event           → explicit no-op (skipReason).
//   - Replay (dedup hit, C2)       → explicit no-op; the audit/reconcile
//                                    side-effect ran already for this event_id,
//                                    so a replay MUST NOT reconcile a 2nd time.
//   - First delivery               → emit a structured reconcile log so the
//                                    audit chain honestly states "reconciled
//                                    from Stripe webhook; no provider refund
//                                    created". Missing refund_id/amount is
//                                    surfaced as a loud `warn` (NOT swallowed —
//                                    AC2 silent-failure ban / C3), the row is
//                                    still persisted (dedup row = audit truth).
// No compensation function (M2): there is no external mutation on this path to
// undo. Rolling back the dedup row is owned by `persistStripePaymentAuditStep`'s
// compensation. No minor→major unit conversion (M3): no provider call consumes
// `refund_amount`; it is audit/display-only, consistent with `amount_minor`.
export function reconcileManualRefund(
  input: ReconcileRefundInput,
  logger?: LoggerLike
): StripeRefundReconcileResult {
  if (input.eventType !== "payment.refunded" || !input.payment_id) {
    return {
      payment_id: input.payment_id ?? "",
      reconciled: false,
      skipped: true,
      skipReason: "not-a-refund-event",
    }
  }

  if (input.deduplicated) {
    logger?.info?.(
      `[stripe-payment-audit] payment.refunded reconcile skipped (replay) ` +
        `payment_id=${input.payment_id} — dedup hit, no second reconcile`
    )
    return {
      payment_id: input.payment_id,
      reconciled: false,
      skipped: true,
      skipReason: "replay-deduplicated",
    }
  }

  const degraded = !input.refund_id || input.refund_amount == null
  if (degraded) {
    // Not silent: explicit warn so an operator/alert sees the gap during a
    // financial reconcile instead of an "info refunded" with missing data.
    logger?.warn?.(
      `[stripe-payment-audit] payment.refunded reconcile degraded ` +
        `payment_id=${input.payment_id} ` +
        `refund_id=${input.refund_id ?? "<missing>"} ` +
        `refund_amount=${input.refund_amount ?? "<missing>"} — ` +
        `audit row persisted; verify against Stripe Dashboard (source of truth)`
    )
  } else {
    logger?.info?.(
      `[stripe-payment-audit] payment.refunded reconciled ` +
        `payment_id=${input.payment_id} refund_id=${input.refund_id} ` +
        `refund_amount=${input.refund_amount} — reconcile-only, ` +
        `no provider-side refund created (manual Stripe Dashboard refund is SoT)`
    )
  }

  return {
    payment_id: input.payment_id,
    refund_id: input.refund_id ?? null,
    refund_amount: input.refund_amount ?? null,
    reconciled: true,
    skipped: false,
    degraded,
  }
}

export const reconcileRefundStep = createStep<
  ReconcileRefundInput,
  StripeRefundReconcileResult,
  void
>("gp-reconcile-manual-refund", async (input, { container }) => {
  let logger: LoggerLike | undefined
  try {
    logger = (
      container as unknown as { resolve: (key: string) => unknown }
    ).resolve("logger") as LoggerLike
  } catch {
    logger = undefined
  }
  try {
    return new StepResponse(reconcileManualRefund(input, logger))
  } catch (err) {
    // Reconcile-only failures are NOT swallowed (C3): log error and rethrow so
    // the workflow fails and `persistStripePaymentAuditStep` compensation rolls
    // back the dedup row (event becomes replayable).
    const error = err as Error
    logger?.error?.(
      `[stripe-payment-audit] payment.refunded reconcile failed: ` +
        `${error.name}: ${error.message}`
    )
    throw err
  }
})

export function createStripePaymentAuditWorkflowFromScope(scope: {
  resolve: (key: string) => unknown
}): StripePaymentAuditWorkflow {
  const db = resolvePgDatabase(scope)
  let eventBus: EventBusLike | undefined
  let logger: LoggerLike | undefined
  try {
    eventBus = scope.resolve(Modules.EVENT_BUS) as EventBusLike
  } catch {
    eventBus = undefined
  }
  try {
    logger = scope.resolve("logger") as LoggerLike
  } catch {
    logger = undefined
  }
  return new StripePaymentAuditWorkflow(db, eventBus, logger)
}

function resolvePgDatabase(scope: { resolve: (key: string) => unknown }): PgPool | KnexLike {
  try {
    return scope.resolve("__pg_pool__") as PgPool
  } catch {
    return scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as KnexLike
  }
}

function isPgPool(value: PgPool | KnexLike): value is PgPool {
  return typeof (value as PgPool).connect === "function"
}

function createKnexPgClient(db: KnexLike): PgClient {
  return {
    query: async <T = Record<string, unknown>>(
      text: string,
      values: ReadonlyArray<unknown> = []
    ) => {
      const query = toKnexSql(text, values)
      const result = await db.raw(query.sql, query.bindings)
      if (Array.isArray(result)) {
        return { rows: result as T[], rowCount: result.length }
      }
      const rows = (result.rows ?? []) as T[]
      return { rows, rowCount: result.rowCount ?? rows.length }
    },
    release: () => undefined,
  }
}

function toKnexSql(
  sql: string,
  values: ReadonlyArray<unknown>
): { sql: string; bindings: unknown[] } {
  const bindings: unknown[] = []
  const text = sql.replace(/\$(\d+)/g, (_match, index: string) => {
    bindings.push(values[Number(index) - 1])
    return "?"
  })
  return { sql: text, bindings }
}

export type StripePaymentAuditWorkflowInput = {
  eventType: StripePaymentEventName
  payload: StripePaymentAuditPayload
}

export const persistStripePaymentAuditStep = createStep<
  StripePaymentAuditWorkflowInput,
  StripePaymentAuditResult,
  StripePaymentAuditResult
>(
  "gp-persist-stripe-payment-audit",
  async (input, { container }) => {
    const workflow = createStripePaymentAuditWorkflowFromScope(
      container as unknown as { resolve: (key: string) => unknown }
    )
    const result = await workflow.processMutation(input.eventType, input.payload)
    return new StepResponse(result, result)
  },
  async (result, { container }) => {
    if (!result) return
    const workflow = createStripePaymentAuditWorkflowFromScope(
      container as unknown as { resolve: (key: string) => unknown }
    )
    await workflow.compensate(result)
  }
)

export const emitStripePaymentAuditStep = createStep<
  { result: StripePaymentAuditResult; payload: StripePaymentAuditPayload },
  void,
  void
>("gp-emit-stripe-payment-audit", async (input, { container }) => {
  const workflow = createStripePaymentAuditWorkflowFromScope(
    container as unknown as { resolve: (key: string) => unknown }
  )
  await workflow.emit(input.result, input.payload)
  return new StepResponse(undefined, undefined)
})

export const stripePaymentAuditWorkflow = createWorkflow<
  StripePaymentAuditWorkflowInput,
  StripePaymentAuditResult,
  []
>("gp-stripe-payment-audit-workflow", function (input) {
  const result = persistStripePaymentAuditStep(input)
  emitStripePaymentAuditStep({ result, payload: input.payload })
  const refundReconcile = reconcileRefundStep({
    eventType: input.eventType,
    deduplicated: result.deduplicated,
    payment_id: input.payload.payment_id,
    payment_intent_id: input.payload.payment_intent_id,
    refund_id: input.payload.refund_id,
    refund_amount: input.payload.refund_amount,
    refund_reason: input.payload.refund_reason,
  })
  // M1: compose step outputs via `transform` (WorkflowData proxies cannot be
  // spread at graph-definition time; the prior `{ ...result } as ...` cast
  // masked that and risked a malformed runtime output).
  return new WorkflowResponse(
    transform({ result, refundReconcile }, (data) => ({
      ...data.result,
      refundReconcile: data.refundReconcile,
    }))
  )
})

export { MissingEntitlementProfileError }
