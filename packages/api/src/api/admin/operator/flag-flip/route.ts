/**
 * Story v160-8-3: GET /admin/operator/flag-flip — current state + audit.
 * POST /admin/operator/flag-flip — transition to_state with smoke-gate guard.
 * GET /admin/operator/flag-flip/audit — paginated audit history.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import {
  ALLOWED_TRANSITIONS,
  getAuditTrail,
  getCurrentState,
  getLastTransitionInfo,
  setState,
  type MultiVendorFlagState,
} from "../../../../lib/feature-flag-tri-state"

export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const current = await getCurrentState()
  const info = getLastTransitionInfo()
  res.json({
    current_state: current,
    allowed_transitions: ALLOWED_TRANSITIONS[current],
    last_transitioned_at: info.last_transitioned_at,
    last_admin: info.last_admin,
    audit_trail: getAuditTrail(20),
  })
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = (req.body ?? {}) as {
    to_state?: MultiVendorFlagState
    admin_note?: string
    override_gate?: boolean
  }
  if (!body.to_state) {
    res.status(400).json({ error: "to_state required" })
    return
  }
  const triggered_by =
    (req as unknown as { auth_context?: { actor_id?: string } }).auth_context
      ?.actor_id ?? "admin"
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  try {
    const result = await setState(body.to_state, {
      triggered_by,
      admin_note: body.admin_note,
      bypass_smoke_gate: body.override_gate === true,
      db,
    })
    res.json(result)
  } catch (err) {
    const msg = (err as Error).message
    if (msg.startsWith("SmokeGateBlocked")) {
      res.status(403).json({ error: msg })
      return
    }
    if (msg.startsWith("InvalidTransition")) {
      res.status(409).json({ error: msg })
      return
    }
    res.status(500).json({ error: msg })
  }
}
