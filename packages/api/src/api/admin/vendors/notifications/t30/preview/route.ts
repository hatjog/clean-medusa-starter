/**
 * Story v160-7-1: T-30 preview admin route.
 *
 * GET /admin/vendors/notifications/t30/preview
 *   Response: { window_opens, flag_flip_date, eligible_count, vendors[] }
 *
 * Read-only — surfaces eligibility data for the admin-panel banner +
 * recipient list table. No side effects.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { fetchEligibleVendors } from "../../../../../../lib/t30-dispatch-service"

interface PreviewResponse {
  window_opens: string
  flag_flip_date: string
  eligible_count: number
  vendors: Array<{
    id: string
    handle: string
    email: string
    lifecycle_status: string
    locale: "pl" | "en"
    last_notified_at: string | null
  }>
}

function resolveFlagFlipDate(): { iso: string; valid: boolean } {
  const raw = process.env.GP_FLAG_FLIP_DATE ?? ""
  if (!raw) return { iso: "", valid: false }
  const d = new Date(raw)
  return { iso: raw, valid: !Number.isNaN(d.getTime()) }
}

function computeWindowOpens(flagFlipIso: string): string {
  if (!flagFlipIso) return ""
  const d = new Date(flagFlipIso)
  if (Number.isNaN(d.getTime())) return ""
  d.setUTCDate(d.getUTCDate() - 30)
  return d.toISOString().slice(0, 10)
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { iso, valid } = resolveFlagFlipDate()
  if (!valid) {
    res.status(200).json({
      window_opens: "",
      flag_flip_date: "",
      eligible_count: 0,
      vendors: [],
    } satisfies PreviewResponse)
    return
  }

  const vendors = await fetchEligibleVendors(
    undefined,
    req.scope as { resolve: (key: string) => unknown },
  )
  const response: PreviewResponse = {
    window_opens: computeWindowOpens(iso),
    flag_flip_date: iso,
    eligible_count: vendors.length,
    vendors: vendors.map((v) => ({
      id: v.id,
      handle: v.handle,
      email: v.email,
      lifecycle_status: "open",
      locale: v.preferred_locale ?? "pl",
      last_notified_at: null,
    })),
  }

  res.status(200).json(response)
}
