import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

type KnexLike = {
  raw: (sql: string, bindings?: ReadonlyArray<unknown>) => Promise<{ rows?: unknown[] }>
}

type RefundRow = {
  event_id: string
  refund_id: string | null
  refund_amount: number | null
  refund_reason: string | null
  currency: string | null
  received_at: string
  payment_intent_id: string | null
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const orderId = (req.params as Record<string, string>).id
  if (!orderId) {
    res.status(400).json({ message: "Missing order id" })
    return
  }

  let db: KnexLike
  try {
    db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as KnexLike
  } catch {
    res.status(503).json({ message: "Database unavailable" })
    return
  }

  // C6: currency MUST come from the audit envelope (real currency code, e.g.
  // "PLN"), NOT `wep.market_id` (which is a market id like "bonbeauty" and
  // produced a wrong/RangeError currency in the widget).
  // M5: this admin-only view projects directly off `webhook_event_processed`
  // (the idempotency/dedup store). That is an accepted v1.8.0 reconcile-only
  // trade-off — a dedicated refund projection table is deferred to
  // named_retry_slot v1.10.0+ (NFR15, customer-facing/operator dashboard).
  // The JOIN matches the envelope `scope` (`payment_intent:<pi>`) against
  // `payment.data->>'id'`; if the Stripe payment-intent id cannot be derived
  // the row simply does not surface (admin-only, non-financial path).
  const result = await db.raw(
    `
    SELECT
      wep.event_id,
      wep.envelope->>'refund_id'    AS refund_id,
      (wep.envelope->>'refund_amount')::bigint AS refund_amount,
      wep.envelope->>'refund_reason' AS refund_reason,
      wep.envelope->>'currency' AS currency,
      wep.received_at,
      SUBSTRING(wep.envelope->>'scope' FROM 'payment_intent:(.+)') AS payment_intent_id
    FROM webhook_event_processed wep
    JOIN payment p
      ON wep.envelope->>'scope' = 'payment_intent:' || (p.data->>'id')
      AND p.deleted_at IS NULL
    JOIN order_payment_collection opc
      ON opc.payment_collection_id = p.payment_collection_id
      AND opc.deleted_at IS NULL
    WHERE opc.order_id = ?
      AND wep.provider = 'stripe'
      AND wep.envelope->>'outcome' = 'refunded'
    ORDER BY wep.received_at ASC
    `,
    [orderId]
  )

  const rows = (result.rows ?? []) as RefundRow[]

  res.json({
    order_id: orderId,
    refunds: rows.map((r) => ({
      event_id: r.event_id,
      refund_id: r.refund_id ?? null,
      refund_amount: r.refund_amount ?? null,
      refund_reason: r.refund_reason ?? "unspecified",
      currency: r.currency ?? null,
      received_at: r.received_at,
      payment_intent_id: r.payment_intent_id ?? null,
    })),
  })
}
