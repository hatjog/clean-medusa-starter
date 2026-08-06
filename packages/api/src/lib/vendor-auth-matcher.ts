/**
 * vendor-auth-matcher — the SINGLE source of truth about what authenticates
 * a `/vendor/*` route (v1.15.0 Story 5.4, FR-11 closure, AD-20, NFR-1, ADR-194).
 *
 * == Why this module exists ==
 * Before 5.4 the answer to "what authenticates this vendor route?" had two
 * carriers that agreed by accident: a per-route HOF (`withVendorAuth`) and a
 * pinned inventory inside `_grow/tools/assert_auth_transport.py`. Neither was
 * derived from the middleware chain, so a NEW `/vendor/*` route was
 * unauthenticated by default and both carriers stayed green about it.
 *
 * Now there is one carrier: the matcher below. Everything else — the gate in
 * `api/middlewares.ts`, the static validator, the negative control test — reads
 * THIS module. A route is authenticated unless it appears in
 * `VENDOR_HMAC_EXEMPT_ROUTES`, and every exemption has to say what
 * authenticates it INSTEAD. "Nothing" is not an available answer.
 *
 * == Why exemptions live in code and not in matcher ordering ==
 * Medusa applies EVERY matching middleware entry, so "put the bearer routes
 * first" would not exempt anything — it would run both. The exemption therefore
 * has to be a decision the gate makes per request, from a named list, which is
 * also the only shape a static validator can read back.
 */
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { vendorAuthMiddleware } from "./vendor-auth"

/** The one matcher that puts `/vendor/*` behind vendor authentication. */
export const VENDOR_HMAC_MATCHER = "/vendor/*"

export type VendorHmacExemption = {
  /** Express-style matcher, `:param` segments allowed. */
  matcher: string
  /** What authenticates the route INSTEAD of the S2S signature. */
  transport: "browser-bearer" | "mercur-seller-context"
  /** Why this surface cannot carry an S2S signature. */
  reason: string
}

/**
 * Routes that are deliberately NOT behind the HMAC gate.
 *
 * These are browser-initiated surfaces: the vendor panel holds a seller JWT, it
 * does not hold (and must never hold) a server-to-server signing secret. Each
 * entry still names a transport, so an exemption can never mean "unauthenticated".
 */
export const VENDOR_HMAC_EXEMPT_ROUTES: readonly VendorHmacExemption[] = [
  {
    matcher: "/vendor/auth/sessions",
    transport: "browser-bearer",
    reason:
      "vendor-panel session list — browser holds a seller JWT; wired to " +
      'authenticate("seller", ["bearer"]) in middlewares.ts',
  },
  {
    matcher: "/vendor/magic-links/:jti/revoke",
    transport: "browser-bearer",
    reason:
      "vendor-panel magic-link revoke — browser-initiated, same seller JWT as the session list",
  },
  {
    matcher: "/vendor/competitive-insights",
    transport: "mercur-seller-context",
    reason:
      "Mercur `ensureSeller` populates req.seller_context; identity comes from the " +
      "upstream seller session, not from a GP signature",
  },
]

function exemptionToRegExp(matcher: string): RegExp {
  const pattern = matcher
    .split("/")
    .map((segment) =>
      segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    )
    .join("/")
  return new RegExp(`^${pattern}/?$`)
}

const EXEMPT_PATTERNS: readonly RegExp[] = VENDOR_HMAC_EXEMPT_ROUTES.map((entry) =>
  exemptionToRegExp(entry.matcher)
)

/**
 * The request path as the ROUTER sees it, not as this middleware's mount point
 * sees it. `req.path` is relative to the mount when Express strips a prefix, so
 * using it here would silently mis-classify exemptions; `originalUrl` is the
 * only field guaranteed to carry the full path.
 */
export function vendorRequestPath(req: Pick<MedusaRequest, "originalUrl"> & { url?: string }): string {
  const raw = req.originalUrl ?? req.url ?? ""
  const withoutQuery = raw.split("?")[0]
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, "") : withoutQuery
}

/** True when the path is on the named exemption list (browser transports). */
export function isVendorHmacExempt(path: string): boolean {
  return EXEMPT_PATTERNS.some((pattern) => pattern.test(path))
}

/**
 * vendorHmacGateMiddleware — mounted once, on `VENDOR_HMAC_MATCHER`.
 *
 * Non-exempt `/vendor/**` request without a valid signature never reaches its
 * handler. That is the property AC4 measures with a route fixture that exists
 * in no inventory at all: default-authenticated, not default-open.
 */
export async function vendorHmacGateMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
): Promise<void> {
  if (isVendorHmacExempt(vendorRequestPath(req))) {
    next()
    return
  }

  await vendorAuthMiddleware(req, res, next)
}
