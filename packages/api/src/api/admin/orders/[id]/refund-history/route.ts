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
  /**
   * v1.9.0 wf5 (closes CC-1 F-CC1-018): count of entitlement_instance rows
   * transitioned to REFUNDED by the refund webhook. Populated by
   * `revokeEntitlementsOnRefund` and persisted on the audit envelope.
   */
  revoked_entitlement_count: number | null
  already_terminal_entitlement_count: number | null
  /**
   * Live entitlement state aggregate for the order (joined at query time so
   * the operator UI can render "Stripe refunded ✓ + entitlement REFUNDED ✓"
   * vs "Stripe refunded ✓ + entitlement ACTIVE ✗" P0 financial-exposure
   * signal).
   */
  live_entitlement_states: string[] | null
  live_entitlement_count: number | null
  live_active_entitlement_count: number | null
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
  //
  // v1.9.0 wf5 (closes CC-1 F-CC1-018): LEFT JOIN entitlement_instance to
  // expose the live entitlement state and the revocation summary persisted
  // by the refund webhook handler (`revokeEntitlementsOnRefund`). The
  // operator UI can now distinguish "Stripe refunded ✓ + entitlement REFUNDED
  // ✓" (closed loop) from "Stripe refunded ✓ + entitlement ACTIVE ✗" (P0
  // financial-exposure signal that ra-E5 closes structurally — this view
  // surfaces the residual exposure for any pre-fix-era data).
  const result = await db.raw(
    `
    SELECT
      wep.event_id,
      wep.envelope->>'refund_id'    AS refund_id,
      (wep.envelope->>'refund_amount')::bigint AS refund_amount,
      wep.envelope->>'refund_reason' AS refund_reason,
      wep.envelope->>'currency' AS currency,
      wep.received_at,
      SUBSTRING(wep.envelope->>'scope' FROM 'payment_intent:(.+)') AS payment_intent_id,
      (wep.envelope->>'revoked_entitlement_count')::int AS revoked_entitlement_count,
      (wep.envelope->>'already_terminal_entitlement_count')::int AS already_terminal_entitlement_count,
      ei_agg.live_states AS live_entitlement_states,
      ei_agg.live_count AS live_entitlement_count,
      ei_agg.active_count AS live_active_entitlement_count
    FROM webhook_event_processed wep
    JOIN payment p
      ON wep.envelope->>'scope' = 'payment_intent:' || (p.data->>'id')
      AND p.deleted_at IS NULL
    JOIN order_payment_collection opc
      ON opc.payment_collection_id = p.payment_collection_id
      AND opc.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT
        array_agg(ei.state ORDER BY ei.created_at) AS live_states,
        COUNT(*)::int AS live_count,
        COUNT(*) FILTER (WHERE ei.state IN ('ACTIVE','ISSUED','REDEMPTION_REQUESTED'))::int AS active_count
      FROM entitlement_instance ei
      WHERE ei.order_id = opc.order_id
    ) ei_agg ON true
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
      // v1.9.0 wf5 F-CC1-018: revocation surface for operator UI.
      revocation: {
        revoked_entitlement_count: r.revoked_entitlement_count ?? 0,
        already_terminal_entitlement_count: r.already_terminal_entitlement_count ?? 0,
        live_entitlement_count: r.live_entitlement_count ?? 0,
        live_active_entitlement_count: r.live_active_entitlement_count ?? 0,
        live_entitlement_states: r.live_entitlement_states ?? [],
        // True when ALL entitlements are in a terminal-revoked state; False
        // surfaces the residual financial-exposure (active voucher despite
        // refunded payment).
        all_revoked:
          (r.live_active_entitlement_count ?? 0) === 0 &&
          (r.live_entitlement_count ?? 0) > 0,
      },
    })),
  })
}
