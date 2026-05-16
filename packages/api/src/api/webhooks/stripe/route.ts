/**
 * POST /webhooks/stripe — retired GP custom Stripe webhook route.
 *
 * Story v1.8.0 1.3 moves Stripe processing to the Medusa native Stripe hook
 * (`/hooks/payment/stripe`) plus a GP Path Y subscriber. This legacy
 * endpoint must not verify signatures or mutate state anymore.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export const AUTHENTICATE = false

export const STRIPE_WEBHOOK_RETIRED_MESSAGE =
  "Webhook moved to Medusa native /hooks/payment/stripe"

export async function POST(
  _req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  res.status(410).json({
    type: "gone",
    message: STRIPE_WEBHOOK_RETIRED_MESSAGE,
  })
}
