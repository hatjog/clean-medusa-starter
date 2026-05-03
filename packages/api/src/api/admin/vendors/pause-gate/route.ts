/**
 * Story v160-7-4: GET /admin/vendors/pause-gate — list vendors with completeness data.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  getCompletenessChecklist,
  type LifecycleStatus,
  type VendorMetadataSnapshot,
} from "../../../../lib/vendor-lifecycle-state-machine"

type PauseGateVendor = {
  id: string
  handle: string
  email: string
  lifecycle_status: LifecycleStatus
  decision_status: "opted_in" | "opted_out" | "pending"
  completeness: { complete: number; total: number }
  last_action_at: string | null
}

type ListResponse = {
  vendors: PauseGateVendor[]
  total: number
  page: number
  limit: number
}

function loadDevFixtureVendors(): Array<
  PauseGateVendor & { _meta: VendorMetadataSnapshot }
> {
  const raw = process.env.GP_PAUSE_GATE_DEV_FIXTURE_VENDORS_JSON
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
  } catch {
    return []
  }
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse<ListResponse>,
): Promise<void> {
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

  let vendors = loadDevFixtureVendors().map((v) => {
    const checklist = getCompletenessChecklist(v._meta)
    return {
      ...v,
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
  const paged = vendors.slice(offset, offset + limitNum).map((v) => {
    const { _meta: _omit, ...rest } = v as PauseGateVendor & {
      _meta: VendorMetadataSnapshot
    }
    void _omit
    return rest
  })

  res.json({
    vendors: paged,
    total,
    page: pageNum,
    limit: limitNum,
  })
}
