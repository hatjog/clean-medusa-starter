/**
 * Story v160-7-3: GET /admin/vendors/decisions — list vendors with decision status.
 *
 * Returns paginated list of vendors filtered by decision status, lifecycle status,
 * or search query. Used by admin-panel /vendors/decisions list page.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

type DecisionStatus = "pending" | "opted_in" | "opted_out" | "forced"

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

/**
 * Dev fixture support — same pattern as Story 7.1 t30 route.
 * Real vendor query via Mercur 2 vendor table is DEFERRED (vendor query wiring
 * is shared concern across 7.1/7.2/7.3 — happens in production env).
 */
function loadDevFixtureVendors(): VendorDecisionListEntry[] {
  const raw = process.env.GP_DECISIONS_DEV_FIXTURE_VENDORS_JSON
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as VendorDecisionListEntry[]
  } catch {
    return []
  }
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse<ListResponse>,
): Promise<void> {
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

  let vendors = loadDevFixtureVendors()

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
