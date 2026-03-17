/**
 * withVendorAuth — Higher-Order Function for vendor authentication (DD-25).
 *
 * Decision: Extend Mercur seller auth (token-based federation per ADR-034).
 * - Token: `x-vendor-token` header — Mercur seller session token
 * - Flow: token -> seller_id -> resolveVendorId(seller_id) -> vendor_id -> inject
 * - Fallback: graceful HTTP 501 when resolveVendorId is stub (NotImplementedError)
 *
 * References:
 * - ADR-025: Term "vendor" used in gp_core; "seller" only in Mercur auth context
 * - ADR-034: Federated sessions; HMAC backend-to-backend for service-to-service
 * - DD-25: Vendor auth decision — extend Mercur seller auth
 *
 * @module vendor-auth
 */
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { NotImplementedError } from "../modules/gp-core/service"

const VENDOR_TOKEN_HEADER = "x-vendor-token"

export type VendorAuthContext = {
  vendor_id: string
  seller_id: string
}

type GpCoreServiceLike = {
  resolveVendorId: (mercurSellerId: string) => Promise<string>
}

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

type RequestWithVendorAuth = MedusaRequest & {
  vendorAuth?: VendorAuthContext
}

function resolveLogger(scope: MedusaRequest["scope"] | undefined): LoggerLike {
  if (!scope) return console

  try {
    const logger = scope.resolve("logger") as LoggerLike | undefined
    return logger ?? console
  } catch {
    return console
  }
}

function resolveGpCore(scope: MedusaRequest["scope"] | undefined): GpCoreServiceLike | null {
  if (!scope) return null

  try {
    return scope.resolve("gp_core") as GpCoreServiceLike | null
  } catch {
    return null
  }
}

/**
 * Extracts seller_id from Mercur seller session token.
 *
 * In production, this will validate the token via Mercur's auth module.
 * Current implementation: treats the token as the seller_id directly
 * (sufficient for dev/test; full HMAC validation deferred to Story 3.x).
 */
function extractSellerIdFromToken(token: string): string | null {
  if (!token || token.length === 0) return null
  return token
}

/**
 * withVendorAuth — HOF middleware factory for vendor-authenticated routes.
 *
 * Wraps a route handler to inject `req.vendorAuth` context.
 * If the vendor token is missing or invalid, responds with 401.
 * If resolveVendorId is still a stub (NotImplementedError), responds with 501.
 */
export function withVendorAuth(
  handler: (
    req: RequestWithVendorAuth,
    res: MedusaResponse,
    next: MedusaNextFunction
  ) => Promise<void> | void
) {
  return async (
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
  ): Promise<void> => {
    const logger = resolveLogger(req.scope)
    const vendorToken = req.headers[VENDOR_TOKEN_HEADER]
    const tokenValue = Array.isArray(vendorToken) ? vendorToken[0] : vendorToken

    if (!tokenValue) {
      res.status(401).json({
        message: "Missing vendor authentication token",
        header: VENDOR_TOKEN_HEADER,
      })
      return
    }

    const sellerId = extractSellerIdFromToken(tokenValue)
    if (!sellerId) {
      res.status(401).json({
        message: "Invalid vendor authentication token",
      })
      return
    }

    const gpCore = resolveGpCore(req.scope)
    if (!gpCore) {
      logger.warn?.("[vendor-auth] GpCoreService not available")
      res.status(503).json({
        message: "Vendor authentication service unavailable",
      })
      return
    }

    try {
      const vendorId = await gpCore.resolveVendorId(sellerId)
      const vendorReq = req as RequestWithVendorAuth
      vendorReq.vendorAuth = {
        vendor_id: vendorId,
        seller_id: sellerId,
      }

      logger.info?.(`[vendor-auth] authenticated vendor=${vendorId} seller=${sellerId}`)
      await handler(vendorReq, res, next)
    } catch (error) {
      if (error instanceof NotImplementedError) {
        // Graceful 501 — resolveVendorId is still a stub (Story 1.3)
        logger.warn?.(`[vendor-auth] resolveVendorId stub: ${error.message}`)
        res.status(501).json({
          message: "Vendor ID resolution not yet implemented",
          stub: true,
          story: "1.3",
        })
        return
      }

      logger.error?.(`[vendor-auth] error resolving vendor: ${String(error)}`)
      res.status(500).json({
        message: "Vendor authentication failed",
      })
    }
  }
}

/**
 * vendorAuthMiddleware — Standalone middleware that injects vendorAuth context.
 * Use when you need vendorAuth on a route without wrapping the handler.
 */
export async function vendorAuthMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
): Promise<void> {
  const logger = resolveLogger(req.scope)
  const vendorToken = req.headers[VENDOR_TOKEN_HEADER]
  const tokenValue = Array.isArray(vendorToken) ? vendorToken[0] : vendorToken

  if (!tokenValue) {
    res.status(401).json({
      message: "Missing vendor authentication token",
      header: VENDOR_TOKEN_HEADER,
    })
    return
  }

  const sellerId = extractSellerIdFromToken(tokenValue)
  if (!sellerId) {
    res.status(401).json({
      message: "Invalid vendor authentication token",
    })
    return
  }

  const gpCore = resolveGpCore(req.scope)
  if (!gpCore) {
    logger.warn?.("[vendor-auth] GpCoreService not available")
    res.status(503).json({
      message: "Vendor authentication service unavailable",
    })
    return
  }

  try {
    const vendorId = await gpCore.resolveVendorId(sellerId)
    const vendorReq = req as RequestWithVendorAuth
    vendorReq.vendorAuth = {
      vendor_id: vendorId,
      seller_id: sellerId,
    }

    logger.info?.(`[vendor-auth] authenticated vendor=${vendorId} seller=${sellerId}`)
    next()
  } catch (error) {
    if (error instanceof NotImplementedError) {
      logger.warn?.(`[vendor-auth] resolveVendorId stub: ${error.message}`)
      res.status(501).json({
        message: "Vendor ID resolution not yet implemented",
        stub: true,
        story: "1.3",
      })
      return
    }

    logger.error?.(`[vendor-auth] error resolving vendor: ${String(error)}`)
    res.status(500).json({
      message: "Vendor authentication failed",
    })
  }
}
