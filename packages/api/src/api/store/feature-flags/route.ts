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
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"
import { marketContextStorage } from "../../../lib/market-context"
import { getCurrentState } from "../../../lib/feature-flag-tri-state"

export const AUTHENTICATE = false

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  // story v160-cleanup-27f: extract market context via ALS so future per-market
  // flag overrides can drop in without route changes (AC5 / TF-45).
  // Global tri-state behaviour is unchanged for v1.6.0.
  const market_id = marketContextStorage.getStore()?.market_id ?? null

  let db: Knex | null = null
  try {
    db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  } catch {
    db = null
  }

  const state = await getCurrentState(db)
  res.status(200).json({
    multi_vendor_pdp: state,
    ...(market_id ? { market_id } : {}),
  })
}
