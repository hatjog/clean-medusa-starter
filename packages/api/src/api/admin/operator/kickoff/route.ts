/**
 * Story v160-8-2: POST /admin/operator/kickoff — trigger T-30 window.
 * GET — return current kickoff state.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  getDaysRemaining,
  getKickoffState,
  triggerT30Kickoff,
} from "../../../../workflows/operator/trigger-t30-kickoff"

export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const state = getKickoffState()
  res.json({
    state,
    days_remaining: getDaysRemaining(),
  })
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = (req.body ?? {}) as {
    confirm?: boolean
    admin_note?: string
    override?: boolean
  }
  if (!body.confirm) {
    res.status(400).json({ error: "confirm: true required" })
    return
  }
  const triggered_by =
    (req as unknown as { auth_context?: { actor_id?: string } }).auth_context
      ?.actor_id ?? "admin"
  try {
    const result = await triggerT30Kickoff({
      triggered_by,
      admin_note: body.admin_note,
      override: body.override === true,
    })
    res.json(result)
  } catch (err) {
    const e = err as Error & { code?: number }
    res.status(e.code === 409 ? 409 : 500).json({ error: e.message })
  }
}
