/**
 * Story v160-cleanup-13b — GET /store/vouchers/:code
 *
 * Public storefront endpoint backing the recipient claim page
 * (`/voucher/[code]`). Returns the public projection of a voucher fixture
 * (AR45 PII allowlist applied — only listed fields cross the boundary).
 *
 * v1.6.0 backed by an in-memory fixture store (see
 * `src/lib/voucher-fixture-store.ts`). v1.7.0 will swap to Mercur 2 native
 * voucher entity or a PG-backed table without changing this contract.
 *
 * @see GP/storefront/src/lib/data/voucher.ts (consumer)
 * @see specs/constitution/AR45-pii.md
 * @see Story 8.8 AC6 Step 5 (claim page renders)
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { marketContextStorage } from "../../../../lib/market-context"
import { getFixtureByCode } from "../../../../lib/voucher-fixture-store"

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
 * AR45 allowlist projection. Defensive — even if upstream fixture grows new
 * fields, only the listed keys leave this boundary. NEVER replace with a
 * deny-list (whitelist preserves invariant under future schema additions).
 */
function projectAllowlist(
  fx: ReturnType<typeof getFixtureByCode>,
): VoucherPublicView | null {
  if (!fx) return null
  return {
    code: fx.code,
    seller_id: fx.seller_id,
    seller_name: fx.seller_name,
    seller_handle: fx.seller_handle,
    product_title: fx.product_title,
    value_minor: fx.value_minor,
    currency_code: fx.currency_code,
    status: fx.status,
    expires_at: fx.expires_at,
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

  const fx = getFixtureByCode(code)
  // Cross-market isolation (DPIA R-12): if ALS market context is set, voucher must
  // declare a matching market_id. Fail-CLOSED: a fixture missing market_id is treated
  // as "not in this market" (404). Review fix M2 — prevents legacy/unscoped fixtures
  // from leaking across markets when ALS context is present.
  if (fx && market_id && fx.market_id !== market_id) {
    res.status(404).json({
      type: "not_found",
      message: "Voucher not found",
    })
    return
  }
  const view = projectAllowlist(fx)
  if (!view) {
    res.status(404).json({
      type: "not_found",
      message: "Voucher not found",
    })
    return
  }
  res.status(200).json({ voucher: view })
}
