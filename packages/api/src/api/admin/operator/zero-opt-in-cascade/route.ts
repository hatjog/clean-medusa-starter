/**
 * Story v160-8-4: GET /admin/operator/zero-opt-in-cascade — cascade decision tree.
 * Story v160-cleanup-45: opted_in_count now sourced from operator-consent-report
 *   helper (AC1) — env-override stub removed (TF-106 closed).
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"
import { computeZeroOptInCascade } from "../../../../lib/cohort-metrics-aggregator"
import { getCurrentState } from "../../../../lib/feature-flag-tri-state"
import {
  countOptedInVendors,
  type Scope,
  SellerModuleUnavailableError,
} from "../../../../lib/operator-consent-report"

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  const flagState = await getCurrentState(db)

  let opted_in_count: number
  try {
    opted_in_count = await countOptedInVendors(req.scope as unknown as Scope)
  } catch (err) {
    if (err instanceof SellerModuleUnavailableError) {
      // Structured server-side log so operator alerting can detect outages
      // (review MEDIUM finding: alerting blind spot). The underlying cause
      // is preserved on `err.cause` and intentionally NOT echoed to the
      // client (review HIGH finding: information leakage).
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          event: "zero_opt_in_cascade_seller_unavailable",
          code: err.code,
          cause:
            err.cause instanceof Error
              ? { name: err.cause.name, message: err.cause.message }
              : null,
        }),
      )
      res.status(503).json({
        code: "SELLER_MODULE_UNAVAILABLE",
        message: SellerModuleUnavailableError.PUBLIC_MESSAGE,
      })
      return
    }
    throw err
  }

  const cascade = await computeZeroOptInCascade(opted_in_count, flagState)
  res.json(cascade)
}
