/**
 * Story v160-8-7: GET /admin/operator/smoke-gate-status — Phase B aggregator.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { computeSmokeGateState } from "../../../../lib/phase-b-smoke-gate-aggregator"

export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const state = await computeSmokeGateState()
  res.json(state)
}
