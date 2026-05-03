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

interface VendorRow {
  id: string
  handle: string
  email: string
  preferred_locale: "pl" | "en" | null
}

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

async function fetchEligibleVendors(): Promise<VendorRow[]> {
  const fixture = process.env.GP_T30_DEV_FIXTURE_VENDORS_JSON
  if (fixture) {
    try {
      return JSON.parse(fixture) as VendorRow[]
    } catch {
      return []
    }
  }
  return []
}

export async function GET(
  _req: MedusaRequest,
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

  const vendors = await fetchEligibleVendors()
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
