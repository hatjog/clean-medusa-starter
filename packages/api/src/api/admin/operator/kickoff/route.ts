/**
 * Story v160-8-2: POST /admin/operator/kickoff — trigger T-30 window.
 * GET — return current kickoff state.
 *
 * Story v160-cleanup-5: Added 503 handling for T30DispatcherFixtureModeError
 * (AC3 — production hard-block when fixture mode active).
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { extractActorIdOrThrow } from "../../../../lib/capability-check"
import { T30DispatcherFixtureModeError } from "../../../../lib/t30-dispatch-service"
import {
  getDaysRemaining,
  getKickoffState,
  triggerT30Kickoff,
} from "../../../../workflows/operator/trigger-t30-kickoff"
import type { T30Logger } from "../../../../lib/t30-dispatch-service"

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  try {
    extractActorIdOrThrow(req)
  } catch {
    res.status(401).json({
      code: "UNAUTHORIZED",
      message: "Valid admin session required",
    })
    return
  }

  const scope = req.scope as { resolve: (key: string) => unknown }
  const state = await getKickoffState(scope)
  res.json({
    state,
    days_remaining: await getDaysRemaining(scope),
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

  let triggered_by = ""
  try {
    triggered_by = extractActorIdOrThrow(req)
  } catch {
    res.status(401).json({
      code: "UNAUTHORIZED",
      message: "Valid admin session required",
    })
    return
  }

  const logger =
    (req.scope.resolve(ContainerRegistrationKeys.LOGGER) as T30Logger | undefined) ??
    {}

  try {
    const result = await triggerT30Kickoff({
      triggered_by,
      admin_note: body.admin_note,
      override: body.override === true,
      logger,
      scope: req.scope as { resolve: (key: string) => unknown },
    })
    res.json(result)
  } catch (err) {
    if (err instanceof T30DispatcherFixtureModeError) {
      res.status(503).json({
        code: (err as T30DispatcherFixtureModeError).code,
        message: err.message,
      })
      return
    }
    const e = err as Error & { code?: number }
    res.status(e.code === 409 ? 409 : 500).json({ error: e.message })
  }
}
