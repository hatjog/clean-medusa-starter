/**
 * POST /vendor/vouchers/:code/reverse-redemption — KOREKTA pomyłkowej
 * realizacji przez panel salonu (v1.16.0 Story 5.7, AC2; FR-19a, AD-34;
 * decyzja PO D-36; ADR-245 `Proposed`, amendment ADR-212 §4).
 *
 * Aktor: Marta z sesji panelu (`member` + `x-seller-id`) — ten sam transport co
 * lookup/redeem (`VENDOR_HMAC_EXEMPT_ROUTES`, `mercur-seller-context`). Zakres
 * najemcy rozstrzyga domena (`getForSeller` / predykat `seller_id` w producencie
 * stanu kodu); cudzy i nieznany kod dają TO SAMO `404 VOUCHER_NOT_FOUND`.
 *
 * Skutek (jedna transakcja, AD-34): wiersz `voucher_redemption` `kind='REVERSAL'`
 * z `reverses_redemption_id` = korygowana realizacja i `resulting_state =
 * REDEMPTION_REVERSED`; przejście uprawnienia `REDEEMED_FULL → REDEMPTION_REVERSED`
 * z audytem; kod vouchera wraca do stanu realizowalnego. Pierwotny wiersz
 * `REDEMPTION` NIE jest kasowany ani aktualizowany (append-only, ADR-178 §2.3).
 *
 * Odpowiedzi:
 *   - 200 `{ ok, status: "REDEMPTION_REVERSED", correction: { corrected_at, actor, market_id } }`
 *   - 400 INVALID_INPUT — brak/krótki kod
 *   - 404 VOUCHER_NOT_FOUND — kod nieznany LUB cudzy
 *   - 404 ENTITLEMENT_NOT_FOUND / 409 ENTITLEMENT_AMBIGUOUS — most kod → uprawnienie
 *   - 409 REDEMPTION_ALREADY_REVERSED (`reason: already_reversed`) — druga korekta
 *   - 409 VOUCHER_NOT_REDEEMED (`reason: not_redeemed`) — nie ma czego korygować
 *   - 422 REDEMPTION_NOT_CORRECTABLE (`reason: not_correctable`) — gałąź kwotowa
 * `message` jest stałym zdaniem, bez identyfikatorów wewnętrznych.
 */

import type { MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { runInVendorSellerMarketContext } from "../../../../../lib/vendor-seller-market-context"
import { resolveRlsConnectionSource } from "../../../../../lib/rls-connection-source"
import {
  resolveVendorForSeller,
  VendorSellerContextError,
  type RequestWithSellerContext,
} from "../../../../../lib/vendor-seller-context"
import { VOUCHER_MODULE, type VoucherService } from "../../../../../modules/voucher"
import {
  CORRECTION_REFUSALS,
  type CorrectionRefusalApiReason,
} from "../../../../../modules/voucher/models/types"
import {
  createRedeemPartialOperationFromPool,
  RedemptionBalanceError,
  RedemptionCorrectionRefusedError,
  RedemptionEntitlementAmbiguousError,
  RedemptionEntitlementNotFoundError,
} from "../../../../../modules/voucher/workflows/redeem-partial-entitlement"
import { VOUCHER_NOT_FOUND_BODY } from "../lookup/route"

/** Stałe zdania odmowy — bez kodu vouchera i bez identyfikatorów (DW-15-335). */
export const CORRECTION_REFUSAL_MESSAGES: Record<CorrectionRefusalApiReason, string> = {
  already_reversed: "ta realizacja została już skorygowana",
  not_redeemed: "ten voucher nie jest zrealizowany — nie ma czego korygować",
  not_correctable: "korekta z panelu dotyczy wyłącznie vouchera na usługę",
}

class VoucherNotFoundDuringCorrectionError extends Error {
  constructor() {
    super("voucher nie istnieje w zakresie tego sprzedawcy")
    this.name = "VoucherNotFoundDuringCorrectionError"
  }
}

export const POST = async (
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

  let vendorId: string
  let sellerId: string
  try {
    ;({ vendor_id: vendorId, seller_id: sellerId } = await resolveVendorForSeller(
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

  await runInVendorSellerMarketContext(req, res, sellerId, async () => {
    await correctInSellerMarket(req, res, { code, vendorId, sellerId })
  })
}

async function correctInSellerMarket(
  req: RequestWithSellerContext,
  res: MedusaResponse,
  { code, vendorId, sellerId }: { code: string; vendorId: string; sellerId: string },
): Promise<void> {
  const voucherService = req.scope.resolve(VOUCHER_MODULE) as VoucherService

  // Tanie odcięcie — wiążący predykat najemcy siedzi w producencie stanu kodu
  // (`seller_id` w `WHERE`), w tej samej transakcji co wiersz korekty.
  const existing = await voucherService.getForSeller(sellerId, code)
  if (!existing) {
    res.status(404).json(VOUCHER_NOT_FOUND_BODY)
    return
  }

  const connectionSource = resolveRlsConnectionSource(
    req.scope,
    ContainerRegistrationKeys.PG_CONNECTION,
  )
  const operation = createRedeemPartialOperationFromPool(connectionSource, {
    async writeCorrectionProjection(client, context) {
      try {
        await voucherService.restoreAfterCorrectionForSeller(
          sellerId,
          context.voucher_code,
          { client, now: context.now },
        )
      } catch (error) {
        // Kod zniknął albo zmienił właściciela między odcięciem a transakcją:
        // rzut wycofuje CAŁĄ korektę, a odpowiedź jest tą samą odmową co wyżej.
        // Każdy inny błąd (np. awaria bazy) leci dalej bez przemianowania.
        if (
          error instanceof Error &&
          error.message.startsWith("restoreVoucherCodeAfterCorrection:")
        ) {
          throw new VoucherNotFoundDuringCorrectionError()
        }
        throw error
      }
    },
  })

  let result
  try {
    result = await operation.correct({
      voucher_code: code,
      vendor_id: vendorId,
      actor: "vendor",
      actor_hint: "vendor:panel-correction",
    })
  } catch (error) {
    if (error instanceof RedemptionCorrectionRefusedError) {
      const refusal = CORRECTION_REFUSALS[error.reason]
      res.status(refusal.http_status).json({
        code: refusal.api_code,
        reason: error.reason,
        message: CORRECTION_REFUSAL_MESSAGES[error.reason],
      })
      return
    }
    if (error instanceof VoucherNotFoundDuringCorrectionError) {
      res.status(404).json(VOUCHER_NOT_FOUND_BODY)
      return
    }
    if (error instanceof RedemptionEntitlementNotFoundError) {
      res.status(404).json({ code: error.error_code, message: "brak uprawnienia dla tego kodu" })
      return
    }
    if (error instanceof RedemptionEntitlementAmbiguousError) {
      res.status(409).json({ code: error.error_code, message: "kod wskazuje więcej niż jedno uprawnienie" })
      return
    }
    if (error instanceof RedemptionBalanceError) {
      res.status(422).json({ code: error.error_code, message: "korekta naruszyłaby bilans realizacji" })
      return
    }
    throw error
  }

  res.status(200).json({
    ok: true,
    status: result.entitlement_state_after,
    correction: {
      corrected_at: result.corrected_at,
      actor: "own_seller",
      market_id: result.market_id,
    },
  })
}
