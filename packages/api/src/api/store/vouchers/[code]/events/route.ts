/**
 * Story v160-cleanup-13b — GET /store/vouchers/:code/events
 *
 * Public audit-trail endpoint backing the recipient claim page
 * `audit-trail-molecule`. Returns the recipient-visible audit events with
 * AR45 allowlist applied (only id + event_type + occurred_at cross the
 * boundary — never buyer-side metadata).
 *
 * @see GP/storefront/src/lib/data/voucher.ts (consumer — getVoucherEvents)
 * @see Story 8.8 AC6 Step 6 (audit trail molecule renders)
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { marketContextStorage } from "../../../../../lib/market-context"
import {
  getFixtureByCode,
  type VoucherAuditEventType,
} from "../../../../../lib/voucher-fixture-store"

export const AUTHENTICATE = false

const KNOWN_TYPES: ReadonlySet<VoucherAuditEventType> = new Set([
  "created",
  "sent",
  "opened",
  "claimed",
  "withdrawn",
])

interface AuditEntry {
  id: string
  event_type: VoucherAuditEventType
  occurred_at: string
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  // story v160-cleanup-27g: ALS extract for DPIA R-12 cross-market isolation (TF-46).
  const market_id = marketContextStorage.getStore()?.market_id ?? null

  const code = (req.params as { code?: string })?.code
  if (!code || code.length < 3) {
    res.status(400).json({
      type: "invalid_request",
      message: "code parameter is required (min 3 chars)",
    })
    return
  }

  const fx = getFixtureByCode(code)
  // Cross-market isolation: if ALS market context is set and voucher market differs, 404.
  if (!fx || (market_id && "market_id" in fx && fx.market_id !== market_id)) {
    res.status(404).json({
      type: "not_found",
      message: "Voucher not found",
    })
    return
  }

  const events: AuditEntry[] = (fx.events ?? [])
    .filter((e) => KNOWN_TYPES.has(e.event_type))
    .map((e) => ({
      id: e.id,
      event_type: e.event_type,
      occurred_at: e.occurred_at,
    }))
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))

  res.status(200).json({ events })
}
