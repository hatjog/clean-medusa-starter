/**
 * Story v160-cleanup-13c — GET /store/feature-flags
 *
 * Public storefront endpoint exposing the multi-vendor tri-state flag value
 * so the storefront can resolve the gate at request-time (instead of relying
 * on the build-baked `NEXT_PUBLIC_MULTI_VENDOR_PRICING_ENABLED` value).
 *
 * Read-only. No auth beyond the publishable-api-key middleware applied
 * upstream by the `/store/*` matcher in `src/api/middlewares.ts`.
 *
 * Response:
 *   {
 *     "multi_vendor_pdp": "off" | "shadow" | "on"
 *   }
 *
 * Latency budget: < 5 ms (in-memory singleton from feature-flag-tri-state).
 *
 * @see GP/storefront/src/lib/flags/multiVendorPricing.ts (consumer)
 * @see Story 8.8 AC7 (flag-OFF snapshot guard)
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { getCurrentState } from "../../../lib/feature-flag-tri-state"

export const AUTHENTICATE = false

export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const state = await getCurrentState()
  res.status(200).json({
    multi_vendor_pdp: state,
  })
}
