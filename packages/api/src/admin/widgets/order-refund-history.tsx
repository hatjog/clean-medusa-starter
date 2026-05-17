import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { useEffect, useState } from "react"

// v1.8.0: admin-only refund history (customer-facing display = named_retry_slot: v1.10.0+, NFR15)
type RefundEntry = {
  event_id: string
  refund_id: string | null
  refund_amount: number | null
  refund_reason: string | null
  currency: string | null
  received_at: string
  payment_intent_id: string | null
}

type RefundHistoryResponse = {
  refunds: RefundEntry[]
  order_id: string
}

function formatAmount(amount: number | null, currency: string | null): string {
  if (amount == null) return "—"
  const curr = (currency ?? "PLN").toUpperCase()
  try {
    return new Intl.NumberFormat("pl-PL", { style: "currency", currency: curr }).format(
      amount / 100
    )
  } catch {
    return `${(amount / 100).toFixed(2)} ${curr}`
  }
}

function formatTimestamp(iso: string): string {
  try {
    return new Intl.DateTimeFormat("pl-PL", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

// L2: link points to the Stripe payment-intent detail (which shows refund
// history) — AC4 explicitly allows the payment-intent link. The Stripe
// per-refund deep-link (`/refunds/<re_*>`) is not officially documented, so we
// do not guess it. Env note: test vs live mode cannot be derived from
// `payment_intent_id` alone — the operator must open the Stripe Dashboard in
// the environment that matches `STRIPE_SECRET_KEY_*` (test `sk_test_*` →
// dashboard.stripe.com/test/...). The unused `refundId` param was removed (was
// dead).
function stripeRefundLink(paymentIntentId: string | null): string | null {
  if (!paymentIntentId) return null
  return `https://dashboard.stripe.com/payments/${paymentIntentId}`
}

function OrderRefundHistoryWidget({ data }: { data: { id: string } }) {
  const [refunds, setRefunds] = useState<RefundEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/admin/gp/orders/${data.id}/refund-history`, {
      credentials: "include",
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<RefundHistoryResponse>
      })
      .then((body) => {
        if (!cancelled) {
          setRefunds(body.refunds ?? [])
          setLoading(false)
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [data.id])

  if (loading) {
    return (
      <div className="bg-ui-bg-base shadow-elevation-card-rest rounded-xl p-6">
        <p className="text-ui-fg-subtle text-sm">Ładowanie historii refundów…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-ui-bg-base shadow-elevation-card-rest rounded-xl p-6">
        <p className="text-ui-fg-error text-sm">Błąd ładowania historii refundów: {error}</p>
      </div>
    )
  }

  if (refunds.length === 0) {
    return (
      <div className="bg-ui-bg-base shadow-elevation-card-rest rounded-xl p-6">
        <h2 className="text-ui-fg-base inter-large-semibold mb-2">Historia refundów</h2>
        <p className="text-ui-fg-subtle text-sm">
          Brak refundów dla tego zamówienia. Refundy manualne wykonuje operator w Stripe Dashboard.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-ui-bg-base shadow-elevation-card-rest rounded-xl p-6">
      <h2 className="text-ui-fg-base inter-large-semibold mb-4">Historia refundów</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-ui-fg-subtle border-b border-ui-border-base">
            <th className="text-left pb-2 font-medium">Data</th>
            <th className="text-left pb-2 font-medium">Kwota</th>
            <th className="text-left pb-2 font-medium">Powód</th>
            <th className="text-left pb-2 font-medium">Stripe Refund ID</th>
          </tr>
        </thead>
        <tbody>
          {refunds.map((r) => {
            const link = stripeRefundLink(r.payment_intent_id)
            // L1: never present the internal `event_id` as a Stripe Refund ID
            // (misleads operators reconciling against the Dashboard). Show an
            // explicit placeholder when the Stripe `re_*` id is unavailable.
            const refundIdLabel = r.refund_id ?? "— (brak refund_id)"
            return (
              <tr key={r.event_id} className="border-b border-ui-border-base last:border-0">
                <td className="py-2 pr-4">{formatTimestamp(r.received_at)}</td>
                <td className="py-2 pr-4">{formatAmount(r.refund_amount, r.currency)}</td>
                <td className="py-2 pr-4">{r.refund_reason ?? "unspecified"}</td>
                <td className="py-2">
                  {link ? (
                    <a
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-ui-fg-interactive hover:underline font-mono text-xs"
                    >
                      {refundIdLabel}
                    </a>
                  ) : (
                    <span className="text-ui-fg-subtle font-mono text-xs">
                      {refundIdLabel}
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.after",
})

export default OrderRefundHistoryWidget
