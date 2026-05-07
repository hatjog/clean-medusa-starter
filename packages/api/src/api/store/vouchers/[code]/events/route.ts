/**
 * Story v160-cleanup-25 — GET /store/vouchers/:code/events
 *
 * Public audit-trail endpoint backing the recipient claim page
 * `audit-trail-molecule`. Returns the recipient-visible audit events with
 * AR45 allowlist applied (only id + event_type + occurred_at cross the
 * boundary — never buyer-side metadata).
 *
 * Backed by Medusa 2 voucher module (PG-persistent) replacing the former
 * in-memory voucher-fixture-store.ts.
 *
 * @see GP/storefront/src/lib/data/voucher.ts (consumer — getVoucherEvents)
 * @see Story 8.8 AC6 Step 6 (audit trail molecule renders)
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { marketContextStorage } from "../../../../../lib/market-context"
import type { VoucherService, VoucherEventType } from "../../../../../modules/voucher"

export const AUTHENTICATE = false

const KNOWN_TYPES: ReadonlySet<VoucherEventType> = new Set([
  "created",
  "sent",
  "opened",
  "claimed",
  "withdrawn",
])

interface AuditEntry {
  id: string
  event_type: VoucherEventType
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

  const voucherService = req.scope.resolve("voucher") as VoucherService
  const voucher = await voucherService.getByCode(code)

  // Cross-market isolation: if ALS market context is set and voucher market differs, 404.
  if (!voucher || (market_id && voucher.market_id !== null && voucher.market_id !== market_id)) {
    res.status(404).json({
      type: "not_found",
      message: "Voucher not found",
    })
    return
  }

  const events: AuditEntry[] = (voucher.events ?? [])
    .filter((e) => KNOWN_TYPES.has(e.event_type))
    .map((e) => ({
      id: e.id,
      event_type: e.event_type,
      occurred_at: e.occurred_at instanceof Date
        ? e.occurred_at.toISOString()
        : String(e.occurred_at),
    }))
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))

  res.status(200).json({ events })
}
