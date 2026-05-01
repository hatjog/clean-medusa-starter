/**
 * GET /api/v1/admin/entitlements
 *
 * Operator entitlement lookup (Story 8.1 — "30-second test").
 * Protected by operatorAuthMiddleware (AC-4, AC-5, AC-6).
 *
 * Query params:
 *   q (required, min 3 chars): email | voucher_code | claim_token | order_id
 *
 * Response: apiSuccess({ entitlements: EntitlementAdminView[] })
 *
 * References:
 * - architecture-v1.2.0.md#DD-16 — admin search design decision + cross-DB strategy
 * - architecture-v1.2.0.md#CST-1 — cross-system buyer email search
 * - architecture-v1.2.0.md#IP-3,4,5 — response conventions
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { AdminEntitlementsQuerySchema } from "../../../../lib/contracts/admin"
import { apiError, apiSuccess } from "../../../../lib/api/response"
import { ErrorCode } from "../../../../lib/contracts/errors"

type GpCoreServiceLike = {
  adminSearchEntitlements: (q: string) => Promise<unknown[]>
}

function resolveGpCore(req: MedusaRequest): GpCoreServiceLike | null {
  try {
    return req.scope.resolve("gp_core") as GpCoreServiceLike
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

  const gpCore = resolveGpCore(req)
  if (!gpCore) {
    apiError(res, ErrorCode.SERVICE_UNAVAILABLE, 503, {
      message: "GpCoreService unavailable",
    })
    return
  }

  const entitlements = await gpCore.adminSearchEntitlements(q)
  apiSuccess(res, { entitlements })
}
