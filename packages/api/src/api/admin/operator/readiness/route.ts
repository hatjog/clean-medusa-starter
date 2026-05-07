/**
 * Story v160-8-1: GET /admin/operator/readiness — pre-flag-flip readiness.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { computeReadiness } from "../../../../lib/operator-readiness-aggregator"

let _cache: Awaited<ReturnType<typeof computeReadiness>> | null = null
let _cacheAt = 0

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (!_cache || Date.now() - _cacheAt > 60_000) {
    _cache = await computeReadiness(req.scope as { resolve: (key: string) => unknown })
    _cacheAt = Date.now()
  }
  res.json(_cache)
}
