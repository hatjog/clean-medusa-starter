/**
 * Story v160-7-3: GET /admin/vendors/decisions — list vendors with decision status.
 *
 * Returns paginated list of vendors filtered by decision status, lifecycle status,
 * or search query. Used by admin-panel /vendors/decisions list page.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { extractActorIdOrThrow } from "../../../../lib/capability-check"
import {
  buildDecisionListEntry,
  listSellers,
  type DecisionStatus,
} from "../../../../lib/vendor-decision-store"

type VendorDecisionListEntry = {
  id: string
  handle: string
  email: string
  lifecycle_status: string
  decision_status: DecisionStatus
  last_action_at: string | null
}

type ListResponse = {
  vendors: VendorDecisionListEntry[]
  total: number
  page: number
  limit: number
}

type ErrorResponse = {
  code?: string
  message?: string
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse<ListResponse | ErrorResponse>,
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

  const { status, search, page, limit } = req.query as {
    status?: DecisionStatus | "all"
    search?: string
    page?: string
    limit?: string
  }

  const pageNum = Math.max(1, Number.parseInt(page ?? "1", 10) || 1)
  const limitNum = Math.min(
    100,
    Math.max(1, Number.parseInt(limit ?? "25", 10) || 25),
  )

  let vendors = (await listSellers(
    req.scope as { resolve: (key: string) => unknown },
    {},
  ))
    .map(buildDecisionListEntry)
    .sort((left, right) => {
      const leftAction = left.last_action_at ?? ""
      const rightAction = right.last_action_at ?? ""

      if (leftAction !== rightAction) {
        return rightAction.localeCompare(leftAction)
      }

      return left.handle.localeCompare(right.handle)
    })

  if (status && status !== "all") {
    vendors = vendors.filter((v) => v.decision_status === status)
  }

  if (search && search.trim().length > 0) {
    const q = search.trim().toLowerCase()
    vendors = vendors.filter(
      (v) =>
        v.handle.toLowerCase().includes(q) ||
        v.email.toLowerCase().includes(q),
    )
  }

  const total = vendors.length
  const offset = (pageNum - 1) * limitNum
  const paged = vendors.slice(offset, offset + limitNum)

  res.json({
    vendors: paged,
    total,
    page: pageNum,
    limit: limitNum,
  })
}
