/**
 * Story v160-cleanup-25 — GET /store/vouchers/:code
 *
 * Public storefront endpoint backing the recipient claim page
 * (`/voucher/[code]`). Returns the public projection of a voucher
 * (AR45 PII allowlist applied — only listed fields cross the boundary).
 *
 * Backed by Medusa 2 voucher module (PG-persistent) replacing the former
 * in-memory voucher-fixture-store.ts.
 *
 * @see GP/storefront/src/lib/data/voucher.ts (consumer)
 * @see specs/constitution/AR45-pii.md
 * @see Story 8.8 AC6 Step 5 (claim page renders)
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { marketContextStorage } from "../../../../lib/market-context"
import { VOUCHER_MODULE, type VoucherService, type VoucherWithEvents } from "../../../../modules/voucher"

// Disable Medusa's default admin auth — this is a public store endpoint
// gated by publishable-api-key middleware (handled upstream).
export const AUTHENTICATE = false

interface VoucherPublicView {
  code: string
  seller_id: string
  seller_name: string
  seller_handle: string
  product_title: string
  value_minor: number
  currency_code: string
  status: "idle" | "consent_pending" | "claimed" | "withdrawn"
  expires_at: string | null
}

/**
 * AR45 allowlist projection. Defensive — even if upstream model grows new
 * fields, only the listed keys leave this boundary. NEVER replace with a
 * deny-list (whitelist preserves invariant under future schema additions).
 */
function projectAllowlist(
  voucher: VoucherWithEvents | null,
): VoucherPublicView | null {
  if (!voucher) return null
  return {
    code: voucher.code,
    seller_id: voucher.seller_id,
    seller_name: voucher.seller_name,
    seller_handle: voucher.seller_handle,
    product_title: voucher.product_title,
    value_minor: voucher.value_minor,
    currency_code: voucher.currency_code,
    status: voucher.status,
    expires_at: voucher.expires_at ? voucher.expires_at.toISOString() : null,
  }
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  // story v160-cleanup-27g: ALS extract for DPIA R-12 cross-market isolation (TF-46).
  // Voucher lookup is market-scoped: if ALS context is present AND voucher.market_id
  // differs, return 404 (do NOT leak existence across markets per AC6).
  const market_id = marketContextStorage.getStore()?.market_id ?? null

  const code = (req.params as { code?: string })?.code
  if (!code || code.length < 3) {
    res.status(400).json({
      type: "invalid_request",
      message: "code parameter is required (min 3 chars)",
    })
    return
  }

  const voucherService = req.scope.resolve(VOUCHER_MODULE) as VoucherService
  const voucher = await voucherService.getByCode(code)

  // Cross-market isolation: if ALS market context is set and voucher market differs, 404.
  if (voucher && market_id && voucher.market_id !== market_id) {
    res.status(404).json({
      type: "not_found",
      message: "Voucher not found",
    })
    return
  }

  const view = projectAllowlist(voucher)
  if (!view) {
    res.status(404).json({
      type: "not_found",
      message: "Voucher not found",
    })
    return
  }
  res.status(200).json({ voucher: view })
}
