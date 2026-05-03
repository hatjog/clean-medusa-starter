/**
 * Story v160-8-2: GET /admin/operator/consents — live consent status report.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  getDaysRemaining,
  getKickoffState,
} from "../../../../workflows/operator/trigger-t30-kickoff"

type DecisionStatus = "opted_in" | "opted_out" | "no_decision"

type ConsentVendor = {
  id: string
  handle: string
  decision_status: DecisionStatus
  decision_at: string | null
  nudges_sent: number
  time_remaining_days: number | null
  last_action: string | null
}

function loadFixture(): ConsentVendor[] {
  const raw = process.env.GP_CONSENT_FIXTURE_JSON
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { decision, search, sort, page, limit } = req.query as {
    decision?: DecisionStatus
    search?: string
    sort?: string
    page?: string
    limit?: string
  }
  const state = getKickoffState()
  const days_remaining = getDaysRemaining()

  let vendors = loadFixture()
  if (decision) vendors = vendors.filter((v) => v.decision_status === decision)
  if (search) {
    const q = search.toLowerCase()
    vendors = vendors.filter((v) => v.handle.toLowerCase().includes(q))
  }
  if (sort) {
    const [field, dir] = sort.split(":") as [keyof ConsentVendor, "asc" | "desc"]
    vendors = [...vendors].sort((a, b) => {
      const av = String(a[field] ?? "")
      const bv = String(b[field] ?? "")
      return dir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv)
    })
  }

  const summary = {
    opted_in: vendors.filter((v) => v.decision_status === "opted_in").length,
    opted_out: vendors.filter((v) => v.decision_status === "opted_out").length,
    no_decision: vendors.filter((v) => v.decision_status === "no_decision").length,
    total: vendors.length,
  }

  const pageNum = Math.max(1, Number.parseInt(page ?? "1", 10) || 1)
  const limitNum = Math.min(200, Math.max(1, Number.parseInt(limit ?? "50", 10) || 50))
  const sliced = vendors.slice((pageNum - 1) * limitNum, pageNum * limitNum)

  res.json({
    window: state
      ? {
          started_at: state.started_at,
          t0_target: state.t0_target,
          days_remaining,
        }
      : null,
    vendors: sliced,
    summary,
    page: pageNum,
    limit: limitNum,
    total: vendors.length,
  })
}
