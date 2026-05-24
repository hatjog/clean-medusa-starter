/**
 * Story v160-8-3: GET /admin/operator/flag-flip — current state + audit.
 * POST /admin/operator/flag-flip — transition to_state with smoke-gate guard.
 * GET /admin/operator/flag-flip/audit — paginated audit history.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import { extractActorIdOrThrow } from "../../../../lib/capability-check"
import {
  ALLOWED_TRANSITIONS,
  getAuditTrail,
  getCurrentState,
  getLastTransitionInfo,
  getPersistedAuditTrail,
  getPersistedLastTransitionInfo,
  setState,
  type MultiVendorFlagState,
} from "../../../../lib/feature-flag-tri-state"

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  const current = await getCurrentState(db)
  const info = await getPersistedLastTransitionInfo(db)
  res.json({
    current_state: current,
    allowed_transitions: ALLOWED_TRANSITIONS[current],
    last_transitioned_at: info.last_transitioned_at,
    last_admin: info.last_admin,
    audit_trail: await getPersistedAuditTrail(db, 20),
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
  // cc-4 F-01 + F-02: actor MUST be an authenticated admin (actor_type=user).
  // Literal "admin" fallback removed — audit attribution now always points
  // to a real user identity.
  let triggered_by: string
  try {
    triggered_by = extractActorIdOrThrow(req)
  } catch {
    res.status(401).json({ error: "Valid admin session required" })
    return
  }
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
