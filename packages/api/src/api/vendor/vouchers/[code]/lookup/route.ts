/**
 * GET /vendor/vouchers/:code/lookup — Story 8.4 cross-actor handoff (vendor side).
 *
 * cc-4 finding F-05: Story 8.4 AC4-AC6 required a real vendor-panel
 * voucher lookup endpoint. The previous version of the route group
 * docs (ROUTE_GROUPS.md line 36) promised "entitlement verify/redeem"
 * under /vendor/* but no implementation existed. C17 PASS was structurally
 * unreachable; the harness ran against a mocked Playwright route only.
 *
 * Auth model (v1.15.0 Story 5.8, AC2 — ZMIANA):
 *   - Ta trasa jest ZWOLNIONA z bramki HMAC wpisem
 *     `/vendor/vouchers/:code/lookup` w `VENDOR_HMAC_EXEMPT_ROUTES`
 *     (`lib/vendor-auth-matcher.ts`) z transportem `mercur-seller-context`.
 *     Powód: wywołującym jest PRZEGLĄDARKA panelu, a przeglądarka nie może
 *     trzymać materiału podpisującego S2S. Do 5.8 trasa stała za bramką HMAC,
 *     panel wołał ją sesją sprzedawcy — i dostawał `401`.
 *   - Uwierzytelnia łańcuch Mercura zamontowany na `/vendor/*`
 *     (`authenticate("member", ["session","bearer"])` + `ensureSellerMiddleware`),
 *     który wypełnia `req.seller_context.seller_id` ALBO odrzuca żądanie zanim
 *     dotrze tutaj. To DOKŁADNIE JEDEN punkt uwierzytelnienia — drugi
 *     (bramka HMAC) zgłosiłby roszczenie do tego samego klucza anty-replay
 *     (Story 5.3) i każde legalne żądanie kończyłoby się `401`.
 *   - Zakres najemcy rozstrzyga DOMENA: `VoucherService.getForSeller`
 *     zwraca `null` dla kodu nieznanego I dla cudzego — jedną gałęzią, bo
 *     rozróżnienie ich jest wyciekiem istnienia cudzych danych (UX-DR9).
 *
 * Response shape:
 *   { voucher: <AR45-projected view> } — public projection matches the
 *   /store/vouchers/:code shape; recipient PII is NOT included.
 *
 * Note: this endpoint reads through the existing VoucherService.getByCode
 * (zero schema changes). The matching POST /vendor/vouchers/:code/redeem
 * route does the state transition.
 */

import type { MedusaResponse } from "@medusajs/framework/http"
import {
  resolveVendorForSeller,
  VendorSellerContextError,
  type RequestWithSellerContext,
} from "../../../../../lib/vendor-seller-context"
import {
  VOUCHER_MODULE,
  type VoucherService,
  type VoucherWithEvents,
  type VoucherStatus,
} from "../../../../../modules/voucher"

interface VendorVoucherView {
  code: string
  seller_id: string
  seller_name: string
  seller_handle: string
  product_title: string
  value_minor: number
  currency_code: string
  /**
   * v1.15.0 Story 5.8: `VoucherStatus`, nie lokalna unia. Lokalna kopia była
   * WĘŻSZA od CHECK-a bazy (brakowało `expired`), więc projekcja obiecywała
   * konsumentowi zbiór, którego domena nie gwarantuje.
   */
  status: VoucherStatus
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

/**
 * JEDNO ciało odmowy dla „nieznany kod" i „nie twój voucher" — literał
 * współdzielony, nie dwie kopie. Dwa identyczne literały w dwóch gałęziach
 * rozjeżdżają się cicho w chwili, w której ktoś doda do jednej z nich pole
 * diagnostyczne (UX-DR9). Test porównuje odpowiedzi obu przypadków
 * bajt-w-bajt; ta stała sprawia, że test mierzy kod, a nie dyscyplinę.
 */
export const VOUCHER_NOT_FOUND_BODY = {
  code: "VOUCHER_NOT_FOUND",
  message: "Voucher not found",
} as const

export const GET = async (
  req: RequestWithSellerContext,
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

  let sellerId: string
  try {
    // Odczyt kontekstu sprzedawcy JEST TUTAJ, w module trasy — to jest dowód
    // transportu, który czyta `assert_auth_transport.py` (patrz komentarz przy
    // `resolveVendorForSeller`).
    ;({ seller_id: sellerId } = await resolveVendorForSeller(
      req.scope,
      req.seller_context?.seller_id,
    ))
  } catch (error) {
    if (error instanceof VendorSellerContextError) {
      res.status(error.status).json({ code: error.code, message: error.message })
      return
    }
    throw error
  }

  const voucherService = req.scope.resolve(VOUCHER_MODULE) as VoucherService

  // JEDNA odpowiedź dla „nieznany" i dla „nie twój" — identyczna co do
  // statusu, ciała i nagłówków. Predykat własności należy do domeny
  // (`getForSeller`), więc ta trasa nie ma gałęzi, którą dałoby się rozjechać
  // z gałęzią trasy realizacji.
  const voucher = await voucherService.getForSeller(sellerId, code)
  if (!voucher) {
    res.status(404).json(VOUCHER_NOT_FOUND_BODY)
    return
  }

  const view = projectVendorView(voucher)
  res.status(200).json({ voucher: view })
}
