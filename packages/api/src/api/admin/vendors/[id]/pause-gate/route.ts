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
import { marketContextStorage } from "../../../../../lib/market-context"

type PauseGateDetailResponse = {
  vendor: {
    id: string
    handle: string
    email: string
    lifecycle_status: LifecycleStatus
    decision_status: "opted_in" | "opted_out" | "pending"
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
  const marketContext = marketContextStorage.getStore()

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
  const sellerMarketId = readSellerGpMetadata(seller).market_id
  if (
    marketContext?.market_id &&
    typeof sellerMarketId === "string" &&
    sellerMarketId !== marketContext.market_id
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
