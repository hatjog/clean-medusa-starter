/**
 * withVendorAuth — Higher-Order Function for vendor authentication (DD-25).
 *
 * Decision: Extend Mercur seller auth (token-based federation per ADR-034).
 * - Enforced mode: `x-vendor-signature` header — HMAC-SHA256 signed payload
 * - Legacy transition mode: `x-vendor-token` header (VENDOR_HMAC_ENFORCED=false only)
 * - Flow: verify signature -> seller_id -> resolveVendorId(seller_id) -> vendor_id -> inject
 * - Fallback: graceful HTTP 501 when resolveVendorId is stub (NotImplementedError)
 *
 * v1.6.0 HMAC design notes (story: cleanup-48):
 *   - Single shared secret (VENDOR_HMAC_SECRET env var) — simplest viable for
 *     v1.6.0 single-API-instance topology.
 *   - v1.7.0 ADR follow-up: per-vendor secret store (vendor-specific keys).
 *   - Replay protection via in-process LRU (size 10k).
 *   - v1.7.0 follow-up: Redis-backed distributed nonce cache.
 *   - VENDOR_HMAC_ENFORCED=false enables legacy x-vendor-token path (transition
 *     window only — this flag MUST be removed in v1.7.0 cleanup).
 *
 * References:
 * - ADR-025: Term "vendor" used in gp_core; "seller" only in Mercur auth context
 * - ADR-034: Federated sessions; HMAC backend-to-backend for service-to-service
 * - DD-25: Vendor auth decision — extend Mercur seller auth
 * - cleanup-48: This story — full HMAC validation implementation (TF-111 P0)
 *
 * TODO(v1.7.0): Remove VENDOR_HMAC_ENFORCED flag + legacy x-vendor-token path.
 * TODO(v1.7.0): Replace shared VENDOR_HMAC_SECRET with per-vendor secret store (ADR follow-up).
 *
 * @module vendor-auth
 */
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { NotImplementedError } from "../modules/gp-core/service"
import {
  verifyVendorSignature,
  getSharedLru,
  VENDOR_AUTH_SIGNATURE_MISSING,
  VENDOR_AUTH_SIGNATURE_INVALID,
  VENDOR_AUTH_TIMESTAMP_EXPIRED,
  VENDOR_AUTH_REPLAY_DETECTED,
} from "./vendor-hmac"
import { resolveVendorHmacConfig } from "./vendor-hmac-config"

const VENDOR_TOKEN_HEADER = "x-vendor-token"
const VENDOR_SIGNATURE_HEADER = "x-vendor-signature"

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
 * Resolves the seller_id from a request, using HMAC verification or legacy fallback.
 *
 * Returns { ok: true, sellerId } or { ok: false, status, code, message }.
 */
function resolveSellerFromRequest(
  req: MedusaRequest,
  logger: LoggerLike
):
  | { ok: true; sellerId: string }
  | { ok: false; status: 401 | 503; code: string; message: string } {
  let config: ReturnType<typeof resolveVendorHmacConfig>
  try {
    config = resolveVendorHmacConfig()
  } catch (err) {
    logger.error?.(`[vendor-auth] ${String(err)}`)
    return {
      ok: false,
      status: 503,
      code: "VENDOR_AUTH_CONFIG_ERROR",
      message: "Vendor authentication configuration error",
    }
  }

  if (config.enforced) {
    // --- Enforced HMAC mode ---
    const sigHeader = req.headers[VENDOR_SIGNATURE_HEADER]
    const sigValue = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader

    const result = verifyVendorSignature(
      sigValue,
      config.secret,
      Math.floor(Date.now() / 1000),
      config.driftSeconds,
      getSharedLru()
    )

    if (!result.ok) {
      const messages: Record<string, string> = {
        [VENDOR_AUTH_SIGNATURE_MISSING]: "Missing vendor signature header (x-vendor-signature)",
        [VENDOR_AUTH_SIGNATURE_INVALID]: "Invalid vendor signature",
        [VENDOR_AUTH_TIMESTAMP_EXPIRED]: "Vendor signature timestamp expired",
        [VENDOR_AUTH_REPLAY_DETECTED]: "Vendor signature replay detected",
      }
      return {
        ok: false,
        status: 401,
        code: result.code,
        message: messages[result.code] ?? "Vendor authentication failed",
      }
    }

    return { ok: true, sellerId: result.sellerId }
  } else {
    // --- Legacy transition window (VENDOR_HMAC_ENFORCED=false) ---
    // TODO(v1.7.0): Remove this branch + VENDOR_HMAC_ENFORCED flag.
    const vendorToken = req.headers[VENDOR_TOKEN_HEADER]
    const tokenValue = Array.isArray(vendorToken) ? vendorToken[0] : vendorToken

    if (!tokenValue) {
      return {
        ok: false,
        status: 401,
        code: "VENDOR_AUTH_SIGNATURE_MISSING",
        message: "Missing vendor authentication (legacy x-vendor-token also absent)",
      }
    }

    // Treat token as seller_id directly (legacy contract — insecure, transition only)
    logger.warn?.(
      JSON.stringify({
        event: "vendor-auth.legacy-accept",
        seller_id: tokenValue,
        transition_window: true,
      })
    )

    return { ok: true, sellerId: tokenValue }
  }
}

/**
 * withVendorAuth — HOF middleware factory for vendor-authenticated routes.
 *
 * Wraps a route handler to inject `req.vendorAuth` context.
 * When VENDOR_HMAC_ENFORCED=true (default): validates x-vendor-signature HMAC.
 * When VENDOR_HMAC_ENFORCED=false: accepts legacy x-vendor-token (transition window).
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

    const sellerResult = resolveSellerFromRequest(req, logger)
    if (!sellerResult.ok) {
      res.status(sellerResult.status).json({
        code: sellerResult.code,
        message: sellerResult.message,
      })
      return
    }

    const { sellerId } = sellerResult

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

  const sellerResult = resolveSellerFromRequest(req, logger)
  if (!sellerResult.ok) {
    res.status(sellerResult.status).json({
      code: sellerResult.code,
      message: sellerResult.message,
    })
    return
  }

  const { sellerId } = sellerResult

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
