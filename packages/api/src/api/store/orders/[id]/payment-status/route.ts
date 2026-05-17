/**
 * GET /store/orders/:id/payment-status — Story 6.1: Payment Hardening
 *
 * Lightweight reconciliation endpoint. Safe to poll — pure read, no state
 * mutation. Returns order payment status mapped to GP shared lifecycle
 * vocabulary plus a timestamped "last checked" evidence field and a single
 * recommended action key per AC 1 / AC 4.
 *
 * Reconciliation poke (NFR9 / AC 1):
 *   When webhook_age > 120s and status is still pending_psp_confirmation,
 *   logs a reconciliation signal. Actual Stripe status resolution is
 *   delegated to Medusa's payment module — this route does not mutate
 *   payment/order state directly (GET safety invariant).
 *
 * Idempotency (NFR8 / AC 4):
 *   This endpoint is always a pure read. Callers may retry indefinitely
 *   without risk of duplicate charges, orders, or vouchers. The `request_id`
 *   in the response is a per-call opaque identifier for log correlation only.
 *
 * Audit (AC 3):
 *   Every reconciliation poke is logged with actor=system, scope=order:<id>,
 *   outcome=poke_logged, timestamp.
 *
 * Status mapping (lifecycle SSOT enforced):
 *   Medusa `OrderPaymentStatus` + order `status` → GP lifecycle id. This
 *   mirrors the storefront proxy `/api/v1/orders/[id]/route.ts` and must stay
 *   in sync with it. Only values from the shared lifecycle state machine are
 *   returned: `payment` ∈ {paid, pending_psp_confirmation,
 *   failed_retryable, failed_nonretryable, support_required}; `order`
 *   includes `expired`.
 *
 * Reconciliation poke (webhook_age):
 *   Uses `order.created_at` (not `updated_at`) as the anchor for the
 *   webhook staleness check. `updated_at` can be reset by unrelated order
 *   mutations (metadata writes, line-item edits), making it an unreliable
 *   signal. `created_at` is immutable and represents the moment the order
 *   was placed — the age since order creation is the correct proxy for
 *   "time since PSP confirmation was expected".
 *
 * Access:
 *   Requires customer authentication and verifies the requested order belongs
 *   to the authenticated customer. Publishable-key market guard alone is not
 *   enough for an order-specific read endpoint because publishable keys are
 *   intentionally public.
 *
 * @see GP/storefront/src/app/api/v1/orders/[id]/payment-status/route.ts (consumer proxy)
 * @see specs/contracts/governance/examples/lifecycle-state-machine.v1.example.json
 * @see GP/backend/packages/api/src/subscribers/stripe-payment-audit.ts (Path Y payment audit)
 */

import { randomBytes } from "crypto"

import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { marketContextStorage } from "../../../../../lib/market-context"
import { classifyPaymentAttempt } from "../../../../../lib/payment/failure-classification"

// Customer auth is installed for this route in api/middlewares.ts. Keep the
// route-level flag off so Medusa does not apply default admin auth semantics.
export const AUTHENTICATE = false

/** Webhook age threshold beyond which a reconciliation poke is emitted (ms). */
const RECONCILIATION_POKE_THRESHOLD_MS = 120_000

/** GP lifecycle status ids surfaced on this endpoint. */
type PaymentLifecycleStatus =
  | "paid"
  | "pending_psp_confirmation"
  | "failed_retryable"
  | "failed_nonretryable"
  | "support_required"
  | "expired"

/** Single recommended action key per lifecycle status (mirrors adapter). */
const RECOMMENDED_ACTION: Record<PaymentLifecycleStatus, string> = {
  paid: "continue",
  pending_psp_confirmation: "wait",
  failed_retryable: "retry",
  failed_nonretryable: "contact_support",
  support_required: "contact_support",
  expired: "abandon",
}

function mapMedusaPaymentStatus(
  raw: string | null | undefined,
  logger?: LoggerLike,
): PaymentLifecycleStatus {
  switch (raw) {
    case "captured":
    case "partially_captured":
      return "paid"
    case "not_paid":
    case "awaiting":
    case "authorized":
    case "partially_authorized":
      return "pending_psp_confirmation"
    case "requires_action":
      // SCA / 3DS requires customer action. Waiting or refreshing will not fix it.
      return "failed_retryable"
    case "canceled":
      return "expired"
    case "refunded":
    case "partially_refunded":
      return "support_required"
    default:
      // Unknown Medusa status variant — default safe to pending_psp_confirmation
      // but warn so operators can detect mapping drift early.
      logger?.warn?.(`[payment-status] unknown Medusa payment_status: "${String(raw)}" — defaulting to pending_psp_confirmation`)
      return "pending_psp_confirmation"
  }
}

function mapMedusaOrderStatus(raw: string | null | undefined): PaymentLifecycleStatus | null {
  switch (raw) {
    case "archived":
    case "canceled":
      return "expired"
    default:
      return null
  }
}

function generateRequestId(): string {
  return `req_${randomBytes(6).toString("hex")}`
}

type LoggerLike = {
  info?: (msg: string) => void
  warn?: (msg: string) => void
  error?: (msg: string) => void
}

function resolveLogger(req: MedusaRequest): LoggerLike {
  try {
    return (req.scope.resolve("logger") as LoggerLike | undefined) ?? console
  } catch {
    return console
  }
}

type OrderModuleLike = {
  retrieveOrder: (id: string, options?: Record<string, unknown>) => Promise<{
    id?: string
    customer_id?: string | null
    payment_status?: string | null
    status?: string | null
    created_at?: string | Date | null
    sales_channel_id?: string | null
  } | null>
}

type AuthenticatedMedusaRequest = MedusaRequest & {
  auth_context?: {
    actor_id?: string
  }
}

type KnexLike = {
  raw: (sql: string, bindings?: ReadonlyArray<unknown>) => Promise<{ rows?: unknown[] }>
}

type LatestPaymentAttempt = {
  payment_collection_id: string | null
  payment_session_id: string | null
  provider_id: string | null
  status: string | null
  data: Record<string, unknown> | null
  context: Record<string, unknown> | null
  retry_count: number | string | null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

async function resolveLatestPaymentAttempt(
  req: MedusaRequest,
  orderId: string
): Promise<LatestPaymentAttempt | null> {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as KnexLike
  const result = await db.raw(
    `
      SELECT
        opc.payment_collection_id,
        ps.id AS payment_session_id,
        ps.provider_id,
        ps.status,
        ps.data,
        ps.context,
        ps.retry_count
      FROM order_payment_collection opc
      LEFT JOIN payment_session ps
        ON ps.payment_collection_id = opc.payment_collection_id
       AND ps.deleted_at IS NULL
      WHERE opc.order_id = ?
        AND opc.deleted_at IS NULL
      ORDER BY ps.created_at DESC NULLS LAST
      LIMIT 1
    `,
    [orderId]
  )
  const row = result.rows?.[0] as Record<string, unknown> | undefined
  if (!row) return null

  return {
    payment_collection_id:
      typeof row.payment_collection_id === "string" ? row.payment_collection_id : null,
    payment_session_id:
      typeof row.payment_session_id === "string" ? row.payment_session_id : null,
    provider_id: typeof row.provider_id === "string" ? row.provider_id : null,
    status: typeof row.status === "string" ? row.status : null,
    data: isObject(row.data) ? row.data : null,
    context: isObject(row.context) ? row.context : null,
    retry_count:
      typeof row.retry_count === "number" || typeof row.retry_count === "string"
        ? row.retry_count
        : null,
  }
}

function refineFailureStatus(
  baseStatus: PaymentLifecycleStatus,
  attempt: LatestPaymentAttempt | null
): {
  status: PaymentLifecycleStatus
  failure_code: string | null
  decline_code: string | null
} {
  if (!attempt) {
    return { status: baseStatus, failure_code: null, decline_code: null }
  }

  const classification = classifyPaymentAttempt({
    status: attempt.status,
    data: attempt.data,
    context: attempt.context,
  })

  if (
    baseStatus !== "failed_retryable" &&
    baseStatus !== "pending_psp_confirmation"
  ) {
    return { status: baseStatus, failure_code: null, decline_code: null }
  }

  if (classification.classification === "retryable") {
    return {
      status: "failed_retryable",
      failure_code: classification.failure_code ?? null,
      decline_code: classification.decline_code ?? null,
    }
  }

  if (classification.classification === "non_retryable") {
    return {
      status: "failed_nonretryable",
      failure_code: classification.failure_code ?? null,
      decline_code: classification.decline_code ?? null,
    }
  }

  if (classification.classification === "support_required") {
    return {
      status: "support_required",
      failure_code: classification.failure_code ?? null,
      decline_code: classification.decline_code ?? null,
    }
  }

  return { status: "pending_psp_confirmation", failure_code: null, decline_code: null }
}

function parseRetryCount(value: number | string | null): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value)
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
  }
  return 0
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const orderId = (req.params as { id?: string })?.id
  const request_id = generateRequestId()

  if (!orderId || orderId.trim().length === 0) {
    res.status(400).json({ type: "invalid_request", message: "Order ID is required", request_id })
    return
  }

  const logger = resolveLogger(req)
  const customerId = (req as AuthenticatedMedusaRequest).auth_context?.actor_id

  if (!customerId) {
    res.status(401).json({ type: "unauthorized", message: "Customer authentication required", request_id })
    return
  }

  try {
    const orderModule = req.scope.resolve(Modules.ORDER) as OrderModuleLike
    const order = await orderModule.retrieveOrder(orderId, {
      select: ["id", "customer_id", "payment_status", "status", "created_at", "sales_channel_id"],
    })

    if (!order || order.customer_id !== customerId) {
      res.status(404).json({ type: "not_found", message: "Order not found", request_id })
      return
    }

    const marketContext = marketContextStorage.getStore()
    if (
      marketContext?.sales_channel_id &&
      order.sales_channel_id &&
      order.sales_channel_id !== marketContext.sales_channel_id
    ) {
      res.status(404).json({ type: "not_found", message: "Order not found", request_id })
      return
    }

    const baseStatus =
      mapMedusaOrderStatus(order.status) ??
      mapMedusaPaymentStatus(order.payment_status, logger)
    const latestAttempt = await resolveLatestPaymentAttempt(req, orderId)
    const failureStatus = refineFailureStatus(baseStatus, latestAttempt)
    const status = failureStatus.status
    const last_checked_at = new Date().toISOString()
    const recommended_action_key = RECOMMENDED_ACTION[status]

    // Reconciliation poke: if still pending and order is stale, log signal.
    // This GET endpoint NEVER mutates state — poke is logging only.
    // Actual reconciliation is driven by Medusa's payment module retry job
    // or the Path Y Stripe payment audit subscriber.
    //
    // Anchor: order.created_at (immutable) — represents the moment the order
    // was placed. Using created_at avoids false clock resets from unrelated
    // order mutations (line-item edits, metadata writes) that update updated_at.
    if (status === "pending_psp_confirmation" && order.created_at) {
      const createdAt = order.created_at instanceof Date
        ? order.created_at
        : new Date(order.created_at)
      const orderAge = Date.now() - createdAt.getTime()

      if (orderAge > RECONCILIATION_POKE_THRESHOLD_MS) {
        // Audit: reconciliation poke logged per AC 3 / T4 audit contract.
        logger.info?.(JSON.stringify({
          actor: "system",
          scope: `order:${orderId}`,
          request_id,
          outcome: "reconciliation_poke_logged",
          order_age_ms: orderAge,
          timestamp: last_checked_at,
        }))
      }
    }

    res.status(200).json({
      status,
      last_checked_at,
      recommended_action_key,
      request_id,
      failure_code: failureStatus.failure_code,
      decline_code: failureStatus.decline_code,
      payment_collection_id: latestAttempt?.payment_collection_id ?? null,
      payment_session_id: latestAttempt?.payment_session_id ?? null,
      payment_provider_id: latestAttempt?.provider_id ?? null,
      retry_count: parseRetryCount(latestAttempt?.retry_count ?? null),
    })
  } catch (err) {
    logger.error?.(`[payment-status] GET ${orderId} error: ${String(err)}`)
    res.status(503).json({
      type: "service_unavailable",
      message: "Backend unavailable",
      request_id,
    })
  }
}
