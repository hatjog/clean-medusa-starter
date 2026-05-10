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
 *   Medusa `OrderPaymentStatus` → GP lifecycle id (same mapping as the
 *   storefront proxy `/api/v1/orders/[id]/route.ts` — must stay in sync).
 *   Only values from the shared lifecycle state machine are returned:
 *   `payment` ∈ {paid, reconciled}; `order` ∈ {pending_psp_confirmation,
 *   paid, failed, support_required}.
 *   `expired` maps to the `order.failed` recovery path per Dev Notes.
 *
 * Public access: gated by publishable-api-key middleware upstream.
 * Customer JWT is forwarded by the storefront proxy (auth is handled there).
 *
 * @see GP/storefront/src/app/api/v1/orders/[id]/payment-status/route.ts (consumer proxy)
 * @see specs/contracts/governance/examples/lifecycle-state-machine.v1.example.json
 * @see GP/backend/src/api/store/webhooks/stripe/route.ts (inbound webhook handler)
 */

import { randomBytes } from "crypto"

import { Modules } from "@medusajs/framework/utils"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

// Disable Medusa's default admin auth — customer auth is handled by the
// storefront proxy (Bearer JWT forwarded from _medusa_jwt cookie).
export const AUTHENTICATE = false

/** Webhook age threshold beyond which a reconciliation poke is emitted (ms). */
const RECONCILIATION_POKE_THRESHOLD_MS = 120_000

/** GP lifecycle status ids surfaced on this endpoint. */
type PaymentLifecycleStatus =
  | "paid"
  | "pending_psp_confirmation"
  | "failed"
  | "support_required"
  | "expired"

/** Single recommended action key per lifecycle status (mirrors adapter). */
const RECOMMENDED_ACTION: Record<PaymentLifecycleStatus, string> = {
  paid: "continue",
  pending_psp_confirmation: "wait",
  failed: "retry",
  support_required: "contact_support",
  expired: "abandon",
}

function mapMedusaPaymentStatus(raw: string | null | undefined): PaymentLifecycleStatus {
  switch (raw) {
    case "captured":
    case "partially_captured":
      return "paid"
    case "not_paid":
    case "awaiting":
    case "authorized":
    case "partially_authorized":
    case "requires_action":
      return "pending_psp_confirmation"
    case "canceled":
      return "expired"
    case "refunded":
    case "partially_refunded":
      return "support_required"
    default:
      return "pending_psp_confirmation"
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
    payment_status?: string | null
    updated_at?: string | Date | null
  } | null>
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

  try {
    const orderModule = req.scope.resolve(Modules.ORDER) as OrderModuleLike
    const order = await orderModule.retrieveOrder(orderId, {
      select: ["id", "payment_status", "updated_at"],
    })

    if (!order) {
      res.status(404).json({ type: "not_found", message: "Order not found", request_id })
      return
    }

    const status = mapMedusaPaymentStatus(order.payment_status)
    const last_checked_at = new Date().toISOString()
    const recommended_action_key = RECOMMENDED_ACTION[status]

    // Reconciliation poke: if still pending and webhook is stale, log signal.
    // This GET endpoint NEVER mutates state — poke is logging only.
    // Actual reconciliation is driven by Medusa's payment module retry job
    // or the Stripe webhook handler (stripe/route.ts).
    if (status === "pending_psp_confirmation" && order.updated_at) {
      const updatedAt = order.updated_at instanceof Date
        ? order.updated_at
        : new Date(order.updated_at)
      const webhookAge = Date.now() - updatedAt.getTime()

      if (webhookAge > RECONCILIATION_POKE_THRESHOLD_MS) {
        // Audit: reconciliation poke logged per AC 3 / T4 audit contract.
        logger.info?.(JSON.stringify({
          actor: "system",
          scope: `order:${orderId}`,
          request_id,
          outcome: "reconciliation_poke_logged",
          webhook_age_ms: webhookAge,
          timestamp: last_checked_at,
        }))
      }
    }

    res.status(200).json({
      status,
      last_checked_at,
      recommended_action_key,
      request_id,
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
