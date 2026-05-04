/**
 * Multi-vendor metadata middleware for /store/products and /store/products/:id
 *
 * Story: v160-cleanup-12a — backend /store/products multi-vendor resolver
 *
 * When MULTI_VENDOR_PRICING_ENABLED=true, this middleware intercepts the
 * outgoing JSON response and augments each product with:
 *   - vendor_count: number (open sellers count)
 *   - lowest_price_pln: number | null
 *   - vendor_offers: VendorOfferOption[]
 *
 * Uses res.json monkey-patch pattern (same as customerResponseSanitizerMiddleware)
 * but with async augmentation via a Promise wrapper around res.json.
 *
 * @see src/api/middlewares.ts — customerResponseSanitizerMiddleware for pattern reference
 * @see src/lib/multi-vendor-resolver.ts — resolver implementation
 */

import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"
import {
  augmentProductsWithVendorMeta,
  isMultiVendorPricingEnabled,
} from "../../../lib/multi-vendor-resolver"

type ProductsResponseBody = {
  products?: Array<Record<string, unknown>>
  product?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Middleware that augments product list responses with vendor metadata.
 * Wraps res.json so the augmentation happens before the response is sent.
 *
 * Must be registered AFTER the standard Mercur/Medusa validators so that
 * the native route handler can run normally; this middleware then enriches
 * the outgoing body.
 */
export async function vendorMetaMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  // Short-circuit: flag OFF → pass through, zero overhead
  if (!isMultiVendorPricingEnabled()) {
    return next()
  }

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  const originalJson = res.json.bind(res)

  // Replace res.json with an async interceptor.
  // We use a cast because MedusaResponse.json signature is synchronous, but
  // the actual Express send mechanism allows returning a Promise here for the
  // interceptor phase (augment then delegate to original).
  ;(res as unknown as { json: (body: unknown) => Promise<void> }).json =
    async (body: unknown): Promise<void> => {
      try {
        if (body && typeof body === "object" && !Array.isArray(body)) {
          const typedBody = body as ProductsResponseBody

          // List endpoint: body.products = Product[]
          if (Array.isArray(typedBody.products) && typedBody.products.length > 0) {
            await augmentProductsWithVendorMeta(typedBody.products, db)
          }

          // Detail endpoint: body.product = Product
          if (
            typedBody.product &&
            typeof typedBody.product === "object" &&
            !Array.isArray(typedBody.product)
          ) {
            await augmentProductsWithVendorMeta([typedBody.product], db)
          }
        }
      } catch (err) {
        // Non-fatal: log and fall through with un-augmented response.
        // Prevents vendor-meta errors from breaking core product listings.
        const logger = (() => {
          try {
            return req.scope.resolve(ContainerRegistrationKeys.LOGGER) as {
              warn?: (msg: string, ctx?: unknown) => void
            }
          } catch {
            return null
          }
        })()
        logger?.warn?.("[vendor-meta-middleware] augmentation error, serving un-augmented response", {
          error: err instanceof Error ? err.message : String(err),
          path: req.url,
        })
      }

      return originalJson(body)
    }

  next()
}
