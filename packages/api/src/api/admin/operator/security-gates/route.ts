/**
 * Story v160-8-6: GET/POST /admin/operator/security-gates — defense-in-depth
 * gate verification surface.
 *
 * GET  - returns current gate state (cached probe results)
 * POST /run - triggers fresh verification probe
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  verifyAllGates,
  type AllGatesResult,
} from "../../../../lib/security-gate-verifier"

let _cache: AllGatesResult | null = null
let _cacheAt = 0

export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (!_cache || Date.now() - _cacheAt > 60_000) {
    _cache = await verifyAllGates()
    _cacheAt = Date.now()
  }
  res.json(_cache)
}

export async function POST(
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  _cache = await verifyAllGates()
  _cacheAt = Date.now()
  res.json(_cache)
}
