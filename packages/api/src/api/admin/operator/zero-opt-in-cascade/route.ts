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
    opted_in_count = await countOptedInVendors(
      req.scope as { resolve: (key: string) => unknown },
    )
  } catch (err) {
    if (err instanceof SellerModuleUnavailableError) {
      res
        .status(503)
        .json({ code: "SELLER_MODULE_UNAVAILABLE", message: err.message })
      return
    }
    throw err
  }

  const cascade = await computeZeroOptInCascade(opted_in_count, flagState)
  res.json(cascade)
}
