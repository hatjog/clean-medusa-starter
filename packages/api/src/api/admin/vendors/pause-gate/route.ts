/**
 * Story v160-7-4: GET /admin/vendors/pause-gate — list vendors with completeness data.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  getCompletenessChecklist,
  type LifecycleStatus,
} from "../../../../lib/vendor-lifecycle-state-machine"
import { extractActorIdOrThrow } from "../../../../lib/capability-check"
import {
  buildDecisionListEntry,
  buildLifecycleMetadataSnapshot,
  listSellers,
} from "../../../../lib/vendor-decision-store"

type PauseGateVendor = {
  id: string
  handle: string
  email: string
  lifecycle_status: LifecycleStatus
  decision_status: "opted_in" | "opted_out" | "pending" | "forced"
  completeness: { complete: number; total: number }
  last_action_at: string | null
}

type ListResponse = {
  vendors: PauseGateVendor[]
  total: number
  page: number
  limit: number
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse<ListResponse>,
): Promise<void> {
  try {
    extractActorIdOrThrow(req)
  } catch {
    res.status(401).json({
      vendors: [],
      total: 0,
      page: 1,
      limit: 25,
    })
    return
  }

  const { status, completeness, search, page, limit } = req.query as {
    status?: LifecycleStatus | "all"
    completeness?: "complete" | "incomplete"
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
  )).map((seller) => {
    const entry = buildDecisionListEntry(seller)
    const checklist = getCompletenessChecklist(
      buildLifecycleMetadataSnapshot(seller),
    )

    return {
      ...entry,
      completeness: { complete: checklist.complete, total: checklist.total },
    }
  })

  if (status && status !== "all") {
    vendors = vendors.filter((v) => v.lifecycle_status === status)
  }

  if (completeness === "complete") {
    vendors = vendors.filter(
      (v) => v.completeness.complete === v.completeness.total,
    )
  } else if (completeness === "incomplete") {
    vendors = vendors.filter(
      (v) => v.completeness.complete < v.completeness.total,
    )
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
