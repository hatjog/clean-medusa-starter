/**
 * vendor-seller-market-context — ONE carrier of the market context for the
 * GP `/vendor/vouchers/*` subtree (v1.16.0 Story 5.4, fix round 2, R-10/R-11).
 *
 * `/vendor/*` has no `marketContextMiddleware` (it handles `/store/*` only), so
 * a route that touches the pool without a context is denied by the RLS pool
 * hook (`missing_market_context`). Before this module only the redeem route
 * resolved the seller's market; the lookup route — the FIRST step of the panel
 * flow — did not, so the panel could not redeem anything.
 *
 * Every route under `api/vendor/vouchers/` MUST run its pool work through
 * {@link runInVendorSellerMarketContext}. A structural test
 * (`vendor-vouchers-market-context.unit.spec.ts`) enumerates the subtree's
 * `route.ts` files and fails on any that does not call it, so a new route in
 * this subtree cannot skip the carrier silently.
 *
 * The market comes from the AUTHENTICATED seller (`member` + `x-seller-id`,
 * resolved by Mercur into `req.seller_context.seller_id`) via
 * `resolveSellerMarketId` (named hook exception ADR-241) — never from a header
 * the vendor could set.
 *
 * @module lib/vendor-seller-market-context
 */

import type { MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import {
  HttpMarketContextError,
  resolveSellerMarketId,
  runInHttpMarketContext,
} from "./http-market-context"
import type { RequestWithSellerContext } from "./vendor-seller-context"

/** Refusal body code when the seller has no declared market. */
export const MARKET_CONTEXT_REQUIRED = "MARKET_CONTEXT_REQUIRED"

/**
 * Resolve the authenticated seller's market and run `work` inside that market
 * context. A seller without a market is answered `409 MARKET_CONTEXT_REQUIRED`
 * BEFORE any voucher read (a silent empty read under FORCE RLS would look like
 * "voucher does not exist").
 *
 * `onMarketResolved` runs after resolution and before entering the context
 * (redeem publishes the metric label there).
 */
export async function runInVendorSellerMarketContext(
  req: RequestWithSellerContext,
  res: MedusaResponse,
  authenticatedSellerId: string,
  work: (sellerMarketId: string) => Promise<void>,
  options?: { onMarketResolved?: (sellerMarketId: string) => void },
): Promise<void> {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  let sellerMarketId: string
  try {
    sellerMarketId = await resolveSellerMarketId(db, authenticatedSellerId)
  } catch (error) {
    if (error instanceof HttpMarketContextError) {
      res.status(409).json({
        code: MARKET_CONTEXT_REQUIRED,
        message: error.message,
      })
      return
    }
    throw error
  }
  options?.onMarketResolved?.(sellerMarketId)
  await runInHttpMarketContext(sellerMarketId, () => work(sellerMarketId))
}
