/**
 * Story v160-8-4: GET /admin/operator/zero-opt-in-cascade — cascade decision tree.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"
import { computeZeroOptInCascade } from "../../../../lib/cohort-metrics-aggregator"
import { getCurrentState } from "../../../../lib/feature-flag-tri-state"

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  const flagState = await getCurrentState(db)
  // opted_in_count source DEFER — read from consents endpoint or 0 fallback.
  const opted_in_count = Number.parseInt(
    process.env.GP_OPTED_IN_COUNT_OVERRIDE || "0",
    10,
  )
  const cascade = await computeZeroOptInCascade(opted_in_count, flagState)
  res.json(cascade)
}
