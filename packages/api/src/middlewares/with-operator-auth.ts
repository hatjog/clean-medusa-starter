/**
 * withOperatorAuth — Higher-Order Function for operator (admin) authentication.
 *
 * Verifies that the request carries a valid Medusa admin session.
 * - Reads `req.auth_context.actor_type` — must be `"user"` (Medusa admin user)
 * - Returns 403 if non-admin token (e.g., seller token, actor_type="seller")
 * - Returns 401 if no session / missing auth context
 *
 * References:
 * - architecture-v1.2.0.md#auth-boundary — admin vs vendor separation
 * - architecture-v1.2.0.md#IP-6 — auth auto-discovery gate requirement
 * - Story 7.1 (withVendorAuth) — HOF pattern precedent
 *
 * @module middlewares/with-operator-auth
 */
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

export type OperatorAuthContext = {
  actor_id: string
  actor_type: string
  auth_identity_id?: string
}

type RequestWithOperatorAuth = MedusaRequest & {
  operatorAuth?: OperatorAuthContext
}

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
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

function getAuthContext(req: MedusaRequest): OperatorAuthContext | undefined {
  const r = req as MedusaRequest & { auth_context?: OperatorAuthContext }
  return r.auth_context
}

/**
 * withOperatorAuth — HOF middleware factory for operator-authenticated routes.
 *
 * Wraps a route handler to verify Medusa admin session and inject `req.operatorAuth`.
 * Vendor/seller tokens return 403 (valid token, insufficient permissions).
 * Missing/unauthenticated requests return 401.
 */
export function withOperatorAuth(
  handler: (
    req: RequestWithOperatorAuth,
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
    const authContext = getAuthContext(req)

    if (!authContext?.actor_id || !authContext?.actor_type) {
      res.status(401).json({
        message: "Unauthorized — valid admin session required",
      })
      return
    }

    if (authContext.actor_type !== "user") {
      logger.warn?.(
        `[operator-auth] rejected actor_type="${authContext.actor_type}" actor_id="${authContext.actor_id}"`
      )
      res.status(403).json({
        message: "Forbidden — operator access only",
      })
      return
    }

    logger.info?.(
      `[operator-auth] authenticated operator actor_id="${authContext.actor_id}"`
    )

    const operatorReq = req as RequestWithOperatorAuth
    operatorReq.operatorAuth = {
      actor_id: authContext.actor_id,
      actor_type: authContext.actor_type,
      auth_identity_id: authContext.auth_identity_id,
    }

    await handler(operatorReq, res, next)
  }
}

/**
 * operatorAuthMiddleware — Standalone middleware variant for use with defineMiddlewares.
 * Equivalent logic to withOperatorAuth, but as a plain middleware function.
 */
export async function operatorAuthMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
): Promise<void> {
  const logger = resolveLogger(req.scope)
  const authContext = getAuthContext(req)

  if (!authContext?.actor_id || !authContext?.actor_type) {
    res.status(401).json({
      message: "Unauthorized — valid admin session required",
    })
    return
  }

  if (authContext.actor_type !== "user") {
    logger.warn?.(
      `[operator-auth] rejected actor_type="${authContext.actor_type}" actor_id="${authContext.actor_id}"`
    )
    res.status(403).json({
      message: "Forbidden — operator access only",
    })
    return
  }

  logger.info?.(
    `[operator-auth] authenticated operator actor_id="${authContext.actor_id}"`
  )

  const operatorReq = req as RequestWithOperatorAuth
  operatorReq.operatorAuth = {
    actor_id: authContext.actor_id,
    actor_type: authContext.actor_type,
    auth_identity_id: authContext.auth_identity_id,
  }

  next()
}
