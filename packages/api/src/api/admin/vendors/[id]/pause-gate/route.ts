import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import {
  getAllowedTransitions,
  getCompletenessChecklist,
  type ChecklistItem,
  type LifecycleStatus,
} from "../../../../../lib/vendor-lifecycle-state-machine"
import { extractActorIdOrThrow } from "../../../../../lib/capability-check"
import {
  buildDecisionListEntry,
  buildLifecycleMetadataSnapshot,
  getSellerById,
  readSellerGpMetadata,
} from "../../../../../lib/vendor-decision-store"
import { resolveAdminMarketContext } from "../../../../../lib/admin-market-context"

type PauseGateDetailResponse = {
  vendor: {
    id: string
    handle: string
    email: string
    lifecycle_status: LifecycleStatus
    decision_status: "opted_in" | "opted_out" | "pending" | "forced"
    last_action_at: string | null
  }
  checklist: ChecklistItem[]
  completeness: { complete: number; total: number }
  allowed_transitions: LifecycleStatus[]
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse<PauseGateDetailResponse | { error: string }>,
): Promise<void> {
  try {
    extractActorIdOrThrow(req)
  } catch {
    res.status(401).json({ error: "Valid admin session required" })
    return
  }

  const id = (req.params as { id?: string }).id
  if (!id) {
    res.status(400).json({ error: "vendor id required" })
    return
  }

  const seller = await getSellerById(
    req.scope as { resolve: (key: string) => unknown },
    id,
  )

  if (!seller) {
    res.status(404).json({ error: `Vendor ${id} was not found` })
    return
  }

  // cc-4 F-04: previous version read marketContextStorage.getStore() which
  // is always undefined on /admin/* routes (the ALS is only populated by the
  // /store/* middleware chain). The cross-market guard therefore never fired,
  // and Story 8.4 AC2(d) "admin context-switch leak" was structurally
  // unreachable. Replace with the admin-side market resolver: derive the
  // admin's requested market and 404 on cross-market vendor lookups.
  const sellerMarketId = readSellerGpMetadata(seller).market_id
  const adminMarket = await resolveAdminMarketContext(req)
  if (!adminMarket.ok) {
    res.status(adminMarket.status).json({ error: adminMarket.message })
    return
  }
  // super-admins can read any market; otherwise enforce strict match.
  if (
    !adminMarket.is_super_admin &&
    typeof sellerMarketId === "string" &&
    sellerMarketId.length > 0 &&
    adminMarket.market_id &&
    sellerMarketId !== adminMarket.market_id
  ) {
    res.status(404).json({ error: `Vendor ${id} was not found` })
    return
  }

  const vendor = buildDecisionListEntry(seller)
  const snapshot = buildLifecycleMetadataSnapshot(seller)
  const checklist = getCompletenessChecklist(snapshot)

  res.json({
    vendor,
    checklist: checklist.items,
    completeness: { complete: checklist.complete, total: checklist.total },
    allowed_transitions: getAllowedTransitions(vendor.lifecycle_status),
  })
}
