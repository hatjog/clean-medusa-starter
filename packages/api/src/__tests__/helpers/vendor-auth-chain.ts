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
 */
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

import { vendorHmacGateMiddleware } from "../../lib/vendor-auth-matcher"

type AnyHandler = (
  req: any,
  res: MedusaResponse,
  next?: MedusaNextFunction
) => Promise<void> | void

/**
 * Composes the production gate with a route handler.
 *
 * The handler runs ONLY if the gate calls `next()`. A refused request therefore
 * cannot reach the handler — which is what the negative controls assert, on a
 * call counter rather than on the status code alone.
 */
export function withVendorGate(handler: AnyHandler) {
  return async (
    req: MedusaRequest,
    res: MedusaResponse,
    next?: MedusaNextFunction
  ): Promise<void> => {
    let passed = false
    await vendorHmacGateMiddleware(req, res, (() => {
      passed = true
    }) as MedusaNextFunction)

    if (passed) {
      await handler(req, res, next)
    }
  }
}
