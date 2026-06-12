/**
 * POST /hooks/notifications/brevo — placeholder route for the Brevo
 * notification webhook ingress.
 *
 * Story 5.10 ships the HMAC validator + rate-limit + circuit-breaker chain
 * that protects this prefix. The actual delivery handler (Brevo notification
 * provider plugin → Path Y subscriber) is owned by a downstream story; until
 * it is registered, this stub accepts the request post-validation so that
 * the security middleware (`brevoWebhookRateLimitMiddleware`,
 * `brevoWebhookCircuitBreakerMiddleware`, `brevoHmacValidatorMiddleware`)
 * has a terminating handler to engage against rather than letting the
 * framework return an unguarded 404. See F-09 in the Story 5.10 review.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { BREVO_PROVIDER_PLUGIN_PENDING_MESSAGE } from "./helpers"

export const AUTHENTICATE = false

export async function POST(
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  res.status(202).json({
    type: "accepted_noop",
    message: BREVO_PROVIDER_PLUGIN_PENDING_MESSAGE,
  })
}
