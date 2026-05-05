/**
 * Story v160-8-6: GET/POST /admin/operator/security-gates — defense-in-depth
 * gate verification surface.
 *
 * GET  - returns current gate state (cached probe results)
 * POST /run - triggers fresh verification probe
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  verifyGate,
  verifyAllGates,
  type AllGatesResult,
  type GateResult,
  type SecurityGate,
} from "../../../../lib/security-gate-verifier"

let _cache: AllGatesResult | null = null
let _cacheAt = 0

type GateRunHistoryEntry = {
  requested_gate: SecurityGate | "all"
  overall: "pass" | "fail"
  verified_at: string
  last_run_by: string
  gates: GateResult[]
}

let _history: GateRunHistoryEntry[] = []

function aggregateOverall(gates: GateResult[]): "pass" | "fail" {
  return gates.some((gate) => gate.status !== "pass") ? "fail" : "pass"
}

function pushHistory(entry: GateRunHistoryEntry): void {
  _history = [entry, ..._history].slice(0, 5)
}

export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (!_cache || Date.now() - _cacheAt > 60_000) {
    _cache = await verifyAllGates()
    _cacheAt = Date.now()
  }
  res.json({
    ..._cache,
    history: _history,
    last_run_by: _history[0]?.last_run_by ?? null,
  })
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = (req.body ?? {}) as { gate?: SecurityGate }
  const actorId =
    (req as unknown as { auth_context?: { actor_id?: string } }).auth_context
      ?.actor_id ?? "admin"

  if (body.gate) {
    const existing = _cache ?? (await verifyAllGates())
    const refreshedGate = await verifyGate(body.gate)
    const gates = existing.gates.map((gate) =>
      gate.gate === body.gate ? refreshedGate : gate,
    )
    _cache = {
      gates,
      overall: aggregateOverall(gates),
      verified_at: refreshedGate.last_verified_at,
    }
    pushHistory({
      requested_gate: body.gate,
      overall: _cache.overall,
      verified_at: _cache.verified_at,
      last_run_by: actorId,
      gates,
    })
  } else {
    _cache = await verifyAllGates()
    pushHistory({
      requested_gate: "all",
      overall: _cache.overall,
      verified_at: _cache.verified_at,
      last_run_by: actorId,
      gates: _cache.gates,
    })
  }

  _cacheAt = Date.now()
  res.json({
    ..._cache,
    history: _history,
    last_run_by: actorId,
  })
}
