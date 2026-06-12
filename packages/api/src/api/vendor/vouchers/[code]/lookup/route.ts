/**
 * GET /vendor/vouchers/:code/lookup — Story 8.4 cross-actor handoff (vendor side).
 *
 * cc-4 finding F-05: Story 8.4 AC4-AC6 required a real vendor-panel
 * voucher lookup endpoint. The previous version of the route group
 * docs (ROUTE_GROUPS.md line 36) promised "entitlement verify/redeem"
 * under /vendor/* but no implementation existed. C17 PASS was structurally
 * unreachable; the harness ran against a mocked Playwright route only.
 *
 * Auth model:
 *   - withVendorAuth (HMAC x-vendor-signature only — legacy x-vendor-token
 *     path removed in cc-4 F-10). Returns 401 on missing/invalid.
 *   - Market binding: the voucher.seller_id must match the authenticated
 *     seller_id (cross-vendor lookup attempts return 403). voucher.market_id
 *     is propagated into the response so the vendor-panel UI can surface
 *     it for audit narrative.
 *
 * Response shape:
 *   { voucher: <AR45-projected view> } — public projection matches the
 *   /store/vouchers/:code shape; recipient PII is NOT included.
 *
 * Note: this endpoint reads through the existing VoucherService.getByCode
 * (zero schema changes). The matching POST /vendor/vouchers/:code/redeem
 * route does the state transition.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { withVendorAuth } from "../../../../../lib/vendor-auth"
import type { VendorAuthContext } from "../../../../../lib/vendor-auth"
import {
  VOUCHER_MODULE,
  type VoucherService,
  type VoucherWithEvents,
} from "../../../../../modules/voucher"

type RequestWithVendorAuth = MedusaRequest & {
  vendorAuth?: VendorAuthContext
}

interface VendorVoucherView {
  code: string
  seller_id: string
  seller_name: string
  seller_handle: string
  product_title: string
  value_minor: number
  currency_code: string
  status: "idle" | "consent_pending" | "claimed" | "withdrawn"
  market_id: string | null
  expires_at: string | null
}

/**
 * Project the persisted voucher to the vendor-facing view (AR45 allowlist).
 * The vendor surface deliberately exposes market_id (admin/vendor context
 * carries market authority); recipient PII is never included regardless.
 */
function projectVendorView(
  voucher: VoucherWithEvents | null,
): VendorVoucherView | null {
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
    market_id: voucher.market_id ?? null,
    expires_at: voucher.expires_at ? voucher.expires_at.toISOString() : null,
  }
}

export const GET = withVendorAuth(async (
  req: RequestWithVendorAuth,
  res: MedusaResponse,
): Promise<void> => {
  const code = (req.params as { code?: string })?.code
  if (!code || code.length < 3) {
    res.status(400).json({
      code: "INVALID_INPUT",
      message: "code parameter is required (min 3 chars)",
    })
    return
  }

  const voucherService = req.scope.resolve(VOUCHER_MODULE) as VoucherService
  const voucher = await voucherService.getByCode(code)

  // 404 for unknown code (do NOT leak existence to non-owner vendors).
  if (!voucher) {
    res.status(404).json({ code: "VOUCHER_NOT_FOUND", message: "Voucher not found" })
    return
  }

  // Cross-vendor isolation: only the issuing seller can lookup the voucher.
  // withVendorAuth populates vendorAuth.seller_id from the HMAC signature.
  const { seller_id: authenticatedSellerId } = req.vendorAuth!
  if (voucher.seller_id !== authenticatedSellerId) {
    res.status(404).json({ code: "VOUCHER_NOT_FOUND", message: "Voucher not found" })
    return
  }

  const view = projectVendorView(voucher)
  res.status(200).json({ voucher: view })
})
