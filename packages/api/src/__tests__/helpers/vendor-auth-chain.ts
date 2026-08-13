/**
 * vendor-auth-chain — run a `/vendor/*` handler through the REAL gate.
 *
 * v1.15.0 Story 5.4. Until this story, route suites reached authentication by
 * importing the per-route HOF (`withVendorAuth`) that the routes themselves
 * used. That HOF is gone: `/vendor/*` is authenticated by the matcher, so a
 * test that calls a route handler directly now measures the handler with NO
 * authentication at all — green on code that would be wide open in production.
 *
 * `withVendorGate` restores the property those suites were written for, and
 * makes it stronger: the request goes through `vendorHmacGateMiddleware`, i.e.
 * the exact middleware `api/middlewares.ts` mounts, including the exemption
 * list. Nothing here re-implements authentication.
 *
 * == Why the route is a REQUIRED argument (v1.15.0, DW-15-175 triage) ==
 * DW-15-171 made the gate path-aware: it authenticates only routes this repo
 * owns and has not exempted. This helper built requests with no `originalUrl`,
 * so `vendorRequestPath()` returned `""`, `isVendorGpOwnedRoute("")` was false
 * and the gate called `next()` for EVERY case — 36 of the 86 standing red tests
 * came from that single gap, and the ~49 that stayed green were green on an
 * UNGATED path, i.e. asserting nothing about authentication.
 *
 * The route is therefore required, not defaulted: a default would rebuild the
 * same silent failure the moment someone added a suite and forgot it. The
 * helper also refuses a route the gate does not guard, so a wrong path fails
 * loudly here instead of producing a suite that passes without a gate.
 */
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import {
  isVendorGpOwnedRoute,
  isVendorHmacExempt,
  vendorHmacGateMiddleware,
} from "../../lib/vendor-auth-matcher"

type AnyHandler = (
  req: any,
  res: MedusaResponse,
  next?: MedusaNextFunction
) => Promise<void> | void

/**
 * Composes the production gate with a route handler.
 *
 * `route` is the path the suite exercises, e.g. `/vendor/vouchers/ABC/redeem`.
 * It is written onto `req.originalUrl`, because that is what the production
 * matcher reads to decide whether the route is gated at all.
 *
 * The handler runs ONLY if the gate calls `next()`. A refused request therefore
 * cannot reach the handler — which is what the negative controls assert, on a
 * call counter rather than on the status code alone.
 */
export function withVendorGate(handler: AnyHandler, route: string) {
  if (!isVendorGpOwnedRoute(route) || isVendorHmacExempt(route)) {
    throw new Error(
      `withVendorGate: "${route}" is not a gated GP-owned /vendor route. ` +
        `The gate would call next() unconditionally and the suite would assert ` +
        `nothing about authentication.`
    )
  }

  return async (
    req: MedusaRequest,
    res: MedusaResponse,
    next?: MedusaNextFunction
  ): Promise<void> => {
    ;(req as { originalUrl?: string }).originalUrl = route

    let passed = false
    await vendorHmacGateMiddleware(req, res, (() => {
      passed = true
    }) as MedusaNextFunction)

    if (passed) {
      await handler(req, res, next)
    }
  }
}
