/**
 * GET /v1/admin/entitlements
 * (Medusa file-routing: src/api/v1/... → URL /v1/...; `api/` is the router root, not a URL segment.)
 *
 * Operator entitlement lookup (Story 8.1 — "30-second test").
 * Protected by operatorAuthMiddleware (AC-4, AC-5, AC-6).
 *
 * Query params:
 *   q (required, min 3 chars): email | voucher_code | claim_token | order_id
 *
 * Response: apiSuccess({ entitlements: EntitlementAdminView[] })
 *
 * v1.9.0 Wave F6 / Epic-2 HIGH-01 + CC-2 #1 — System 1 elimination.
 *   Pre-F6 this route delegated to `gpCore.adminSearchEntitlements` which
 *   read from the deprecated `gp_core.entitlements` table (ADR-052) AND
 *   ran cross-DB JOINs against `gp_mercur.public.order` — violating both the
 *   ADR-052 invariant ("Mercur uses outbox, NOT direct SELECT on gp_core")
 *   and the boundary that Stripe Path Y was already writing to. Result: every
 *   admin search missed entitlements issued by the live capture path.
 *
 *   Post-F6 the route delegates to `voucherService.adminSearchEntitlements`,
 *   which reads from Layer 4 (`entitlement_instance` joined on `voucher`) per
 *   ADR-099. The legacy gp_core path is preserved as a `@deprecated` stub
 *   that throws — see `gp-core/service.ts#adminSearchEntitlements`.
 *
 * References:
 * - architecture-v1.2.0.md#DD-16 — admin search design decision + cross-DB strategy (legacy)
 * - architecture-v1.2.0.md#CST-1 — cross-system buyer email search
 * - architecture-v1.2.0.md#IP-3,4,5 — response conventions
 * - ADR-099 (4-layer entitlement model — Layer 4 is the canonical store)
 * - new ADR (`specs/adr/2026-05-24-entitlement-system-1-elimination.md`)
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { AdminEntitlementsQuerySchema } from "../../../../lib/contracts/admin"
import { apiError, apiSuccess } from "../../../../lib/api/response"
import { ErrorCode } from "../../../../lib/contracts/errors"
import {
  VOUCHER_MODULE,
  type VoucherService,
} from "../../../../modules/voucher"

type VoucherSearchLike = {
  adminSearchEntitlements: (q: string) => Promise<unknown[]>
}

function resolveVoucherService(req: MedusaRequest): VoucherSearchLike | null {
  try {
    const svc = req.scope.resolve(VOUCHER_MODULE) as VoucherService &
      VoucherSearchLike
    if (typeof svc?.adminSearchEntitlements === "function") return svc
    return null
  } catch {
    return null
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  // Validate query param
  const parseResult = AdminEntitlementsQuerySchema.safeParse(req.query)
  if (!parseResult.success) {
    apiError(res, ErrorCode.VOUCHER_INVALID, 400, {
      message: "VALIDATION_ERROR",
      details: { issues: parseResult.error.issues },
    })
    return
  }

  const { q } = parseResult.data

  const voucher = resolveVoucherService(req)
  if (!voucher) {
    apiError(res, ErrorCode.SERVICE_UNAVAILABLE, 503, {
      message: "VoucherService unavailable",
    })
    return
  }

  const entitlements = await voucher.adminSearchEntitlements(q)
  apiSuccess(res, { entitlements })
}
