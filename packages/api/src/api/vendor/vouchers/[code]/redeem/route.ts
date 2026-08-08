/**
 * POST /vendor/vouchers/:code/redeem — realizacja vouchera przez panel salonu.
 *
 * ── Co zmieniła v1.15.0 Story 5.7 (FR-12a/b/c, ADR-178) ─────────────────────
 * Do tej story trasa zapisywała WYŁĄCZNIE projekcję: `VoucherService.claim`
 * robił atomową tranzycję `ACTIVE → claimed` i dopisywał wiersz `voucher_event`
 * z kopertą audytową. Kwoty, salda ani `redemption_id` nie zapisywała, a
 * `entitlement_id` nie występowało w tym pliku ANI RAZU — podczas gdy kanoniczna
 * `voucher_redemption` (jedyny byt niosący kwotę, saldo i `redemption_id`, którego
 * `ledger-writer` wymaga fail-closed) miała ZERO producentów produkcyjnych.
 * Licznik rozliczeniowy był zerem z powodu martwego producenta.
 *
 * Od 5.7 trasa:
 *   1. WYMAGA nagłówka `Idempotency-Key` (ADR-178 §2.2 M4 pkt 1–2). Brak ⇒ 400
 *      `IDEMPOTENCY_KEY_REQUIRED`. Serwer NIE podstawia klucza za klienta:
 *      klucz losowy per żądanie sprawia, że `ON CONFLICT DO NOTHING` nigdy nie
 *      konfliktuje, powstaje drugi wiersz kanoniczny i saldo schodzi drugi raz;
 *   2. OŻYWIA istniejącego producenta `PostgresRedeemPartialStore.insertRedemption`
 *      (napisanie drugiego writera jest zakazane — ADR-178 §2.2 / A2);
 *   3. rozwiązuje MOST `code → entitlement_id` WEWNĄTRZ tej samej transakcji co
 *      `SELECT … FOR UPDATE` (rezolucja poza transakcją to TOCTOU), fail-closed:
 *      `ENTITLEMENT_NOT_FOUND` (404) i `ENTITLEMENT_AMBIGUOUS` (409) — nigdy
 *      „pierwszy lepszy wiersz", nigdy ciche zejście do zapisu `voucher_event`-only;
 *   4. pisze PROJEKCJĘ (`voucher_event` + `voucher.status` przez `VoucherService.claim`)
 *      W TEJ SAMEJ TRANSAKCJI, PO wierszu kanonicznym i TYLKO gdy on powstał
 *      (M6: projekcja nigdy nie może istnieć bez faktu, który projektuje);
 *   5. wyprowadza `audit_log_id` Z KLUCZA idempotencji, a nie odwrotnie (M4 pkt 4),
 *      więc retry produkuje TĘ SAMĄ kopertę audytową, a nie drugą kopertę
 *      opisującą to samo zdarzenie.
 *
 * ── Zachowania zastane, które ZOSTAJĄ ───────────────────────────────────────
 *   - `/vendor/*` matcher (Story 5.4) uwierzytelnia i wypełnia `vendorAuth.seller_id`;
 *   - cross-vendor lookup zwraca 404 (bez wycieku istnienia);
 *   - kontekst rynku pochodzi z UWIERZYTELNIONEGO sprzedawcy (Story 2.6,
 *     `lib/http-market-context.ts`) — vendor nie poda go nagłówkiem, więc nie da
 *     się go podmienić. Pod `FORCE RLS` połączenie bez `app.gp_market_id` widzi
 *     ZERO wierszy, więc bez tego kroku trasa po prostu nie działa;
 *   - odpowiedź `{ idempotent: true, status: "already_claimed" }` przy powtórzeniu.
 *     Jej ŹRÓDŁEM staje się jednak `ON CONFLICT DO NOTHING` na kanonicznej
 *     (M5), a nie sam `voucher.status`.
 *
 * ── Czego ta trasa NIE robi (granice zakresu 5.7) ───────────────────────────
 * `redeemForSeller`, allow-lista stanów w trasie i UI panelu należą do Story 5.8;
 * unieważnienie kodu przy zwrocie — do Story 5.9. Kwota realizacji jest tu
 * CAŁYM pozostałym saldem uprawnienia, bo dzisiejsza akcja panelu jest
 * realizacją całości (`claim`); realizacja częściowa z kwotą to 5.8.
 *
 * Walidacja:
 *   - 400 INVALID_INPUT — brak/krótki kod
 *   - 400 IDEMPOTENCY_KEY_REQUIRED — brak nagłówka `Idempotency-Key`
 *   - 401 UNAUTHORIZED — odrzucone przez bramkę `/vendor/*`, nigdy tu nie dociera
 *   - 404 VOUCHER_NOT_FOUND — kod nieznany LUB próba cross-vendor
 *   - 404 ENTITLEMENT_NOT_FOUND — kod bez uprawnienia (M2)
 *   - 409 ENTITLEMENT_AMBIGUOUS — wiele uprawnień na kod (M3)
 *   - 409 MARKET_CONTEXT_REQUIRED — sprzedawca bez rynku
 *   - 410 VOUCHER_EXPIRED — voucher wygasł
 *   - 422 REDEMPTION_REFUSED — inwariant domeny realizacji (saldo, stan, bilans)
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"
import {
  HttpMarketContextError,
  resolveSellerMarketId,
  runInHttpMarketContext,
} from "../../../../../lib/http-market-context"
import { resolveRlsConnectionSource } from "../../../../../lib/rls-connection-source"
import type { VendorAuthContext } from "../../../../../lib/vendor-auth"
import { appendNotificationLog } from "../../../../../lib/vendor-notification-log"
import {
  VOUCHER_MODULE,
  type VoucherService,
} from "../../../../../modules/voucher"
import {
  buildAuditLogIdFromIdempotencyKey,
  buildPanelIdempotencyKey,
  createRedeemPartialOperationFromPool,
  RedeemAmountError,
  RedeemNotRedeemableError,
  RedemptionBalanceError,
  RedemptionEntitlementAmbiguousError,
  RedemptionEntitlementNotFoundError,
  RedemptionIdempotencyKeyRequiredError,
  RedemptionMarketRequiredError,
} from "../../../../../modules/voucher/workflows/redeem-partial-entitlement"

type RequestWithVendorAuth = MedusaRequest & {
  vendorAuth?: VendorAuthContext
}

type VendorRedeemAuditEnvelope = {
  audit_log_id: string
  vendor_id: string
  seller_id: string
  market_id: string | null
  code: string
  prior_status: "idle" | "consent_pending" | "claimed" | "withdrawn"
  new_status: "claimed" | "already_claimed"
  claimed_at: string
  /** 5.7: identyfikator wiersza kanonicznego — podstawa rozliczenia. */
  redemption_id: string
  /** 5.7: zrealizowane brutto (minor units) zapisane w `voucher_redemption`. */
  amount_minor: number
  /** 5.7: saldo uprawnienia po realizacji (minor units). */
  remaining_after_minor: number
}

type VendorRedeemResponse = {
  ok: true
  idempotent: boolean
  status: "claimed" | "already_claimed"
  envelope: VendorRedeemAuditEnvelope
}

/**
 * Nagłówek `Idempotency-Key` — JEDEN UUID na akcję użytkownika, NIEZMIENIANY
 * przy ponowieniu. Kształt jest walidowany, ale serwer nagłówkowi NIE UFA:
 * wiąże go z uprawnieniem ({@link buildPanelIdempotencyKey}).
 */
const IDEMPOTENCY_KEY_HEADER = "idempotency-key"
const IDEMPOTENCY_KEY_SHAPE = /^[A-Za-z0-9._:-]{8,200}$/

function readIdempotencyKeyHeader(req: MedusaRequest): string | null {
  const raw = (req.headers as Record<string, unknown> | undefined)?.[
    IDEMPOTENCY_KEY_HEADER
  ]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return IDEMPOTENCY_KEY_SHAPE.test(trimmed) ? trimmed : null
}

/**
 * Czas NAJWCZEŚNIEJSZEGO zdarzenia `claimed` z projekcji — jedno źródło dla
 * pierwszego żądania i dla replayu. „Najwcześniejsze", nie „ostatnie": koperta
 * opisuje zdarzenie realizacji, a ono zaszło raz.
 */
function earliestClaimedAt(
  events: Array<{ event_type: string; occurred_at: Date | string }> | undefined
): string | null {
  const claimed = (events ?? [])
    .filter((e) => e.event_type === "claimed")
    .map((e) => new Date(e.occurred_at).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0]
  return claimed === undefined ? null : new Date(claimed).toISOString()
}

export const POST = async (
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

  // ADR-178 §2.2 M4 pkt 2: brak nagłówka jest ODMOWĄ. Podstawienie klucza
  // serwerowego „na wszelki wypadek" odtworzyłoby usuwany defekt.
  const idempotencyKeyHeader = readIdempotencyKeyHeader(req)
  if (!idempotencyKeyHeader) {
    res.status(400).json({
      code: "IDEMPOTENCY_KEY_REQUIRED",
      message:
        "nagłówek Idempotency-Key jest wymagany: jeden identyfikator na akcję " +
        "użytkownika, niezmieniany przy ponowieniu (retry sieciowy, drugie " +
        "kliknięcie). Bez niego powtórzona realizacja obniżyłaby saldo drugi raz.",
    })
    return
  }

  const { vendor_id: vendorId, seller_id: authenticatedSellerId } = req.vendorAuth!

  // v1.15.0 Story 2.6 (FR-14e, AD-21 §4) — ta trasa jest HTTP, ale NIE `/store/*`,
  // więc nie przechodzi przez `marketContextMiddleware`. Po włączeniu FORCE RLS
  // na tabelach modułu voucher połączenie bez `app.gp_market_id` widzi ZERO
  // wierszy: `getByCode` zwróciłby `null` („voucher nie istnieje"), a `claim`
  // zostałby odrzucony przez `WITH CHECK`. Rynek pochodzi z uwierzytelnionego
  // sprzedawcy — vendor nie może go podać nagłówkiem, więc nie da się go podmienić.
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  let sellerMarketId: string
  try {
    sellerMarketId = await resolveSellerMarketId(db, authenticatedSellerId)
  } catch (error) {
    if (error instanceof HttpMarketContextError) {
      res.status(409).json({
        code: "MARKET_CONTEXT_REQUIRED",
        message: error.message,
      })
      return
    }
    throw error
  }

  await runInHttpMarketContext(sellerMarketId, async () => {
    await redeemInSellerMarket(req, res, {
      code,
      vendorId,
      authenticatedSellerId,
      sellerMarketId,
      idempotencyKeyHeader,
    })
  })
}

async function redeemInSellerMarket(
  req: RequestWithVendorAuth,
  res: MedusaResponse,
  {
    code,
    vendorId,
    authenticatedSellerId,
    sellerMarketId,
    idempotencyKeyHeader,
  }: {
    code: string
    vendorId: string
    authenticatedSellerId: string
    sellerMarketId: string
    idempotencyKeyHeader: string
  },
): Promise<void> {
  const voucherService = req.scope.resolve(VOUCHER_MODULE) as VoucherService

  // Pre-check: cross-vendor lookup attempts return 404 BEFORE claim() runs
  // so a malicious vendor cannot flip another vendor's voucher to "claimed".
  // VoucherService.claim does not enforce vendor scoping on its own.
  const existing = await voucherService.getByCode(code)
  if (!existing) {
    res.status(404).json({ code: "VOUCHER_NOT_FOUND", message: "Voucher not found" })
    return
  }
  if (existing.seller_id !== authenticatedSellerId) {
    res.status(404).json({ code: "VOUCHER_NOT_FOUND", message: "Voucher not found" })
    return
  }

  // Capture prior status BEFORE the redemption mutates state so the audit
  // envelope reflects the actual pre-transition value.
  const priorStatus = existing.status

  // Producent kanonicznej jedzie TĄ SAMĄ pulą, którą łata hook RLS (Story 2.6,
  // AD-21 §4). Własna pula byłaby drugim nośnikiem kontekstu rynku i pod
  // `FORCE RLS` nie zobaczyłaby ani jednego wiersza.
  const connectionSource = resolveRlsConnectionSource(
    req.scope,
    ContainerRegistrationKeys.PG_CONNECTION,
  )

  // Projekcja ma JEDNEGO producenta: `VoucherService`. Jest wołana z KLIENTEM
  // TEJ SAMEJ TRANSAKCJI, w której powstał wiersz kanoniczny (M6).
  let claimStatus: "claimed" | "already_claimed" | null = null
  let claimedAt: string | null = null
  const operation = createRedeemPartialOperationFromPool(connectionSource, {
    async writeProjection(client, context) {
      const result = await voucherService.claim(context.voucher_code, {
        now: context.now,
        client,
      })
      if (result.status === "not_found") {
        // Kanoniczna już powstała w tej tx — rozjazd fakt↔projekcja byłby
        // gorszy niż odmowa. Rzucenie wycofuje CAŁĄ transakcję.
        throw new RedeemNotRedeemableError(
          `realizacja: projekcja nie znalazła vouchera '${context.voucher_code}' ` +
            "po zapisie kanonicznym — rollback fail-closed",
        )
      }
      if (result.status === "expired") {
        throw new VoucherExpiredDuringRedeemError(context.voucher_code)
      }
      claimStatus = result.status
      claimedAt =
        earliestClaimedAt(result.voucher.events) ?? context.now.toISOString()
    },
  })

  let redemption
  try {
    redemption = await operation.redeem({
      voucher_code: code,
      // Panel realizuje CAŁE pozostałe saldo (odpowiednik dzisiejszego `claim`).
      // Kwota wpisywana przez sprzedawcę to Story 5.8.
      redeem_full: true,
      idempotency_key_header: idempotencyKeyHeader,
      redemption_market_id: sellerMarketId,
      vendor_id: vendorId,
      actor: "vendor",
      actor_hint: "vendor:panel-redeem",
    })
  } catch (error) {
    respondToRedemptionError(res, error)
    return
  }

  // `audit_log_id` jest POCHODNĄ klucza idempotencji (M4 pkt 4) — przy retry
  // ta sama koperta, nie druga koperta opisująca to samo zdarzenie.
  const boundIdempotencyKey = buildPanelIdempotencyKey(
    redemption.entitlement_id,
    idempotencyKeyHeader,
  )
  const auditLogId = buildAuditLogIdFromIdempotencyKey(boundIdempotencyKey)

  // M5: źródłem `already_claimed` jest `ON CONFLICT DO NOTHING` na kanonicznej
  // (zero wstawionych wierszy ⇒ replay), a nie sam `voucher.status`. Dwie
  // niezależne bariery idempotencji na jednej trasie to dwie prawdy o tym
  // samym zdarzeniu.
  const status: "claimed" | "already_claimed" = redemption.idempotent
    ? "already_claimed"
    : claimStatus ?? "claimed"

  const envelope: VendorRedeemAuditEnvelope = {
    audit_log_id: auditLogId,
    vendor_id: vendorId,
    seller_id: authenticatedSellerId,
    market_id: existing.market_id ?? sellerMarketId,
    code,
    prior_status: priorStatus,
    new_status: status,
    // Przy REPLAYU `writeProjection` nie jest wołany (M6 — projekcja tylko
    // razem z faktem), więc `claimedAt` zostaje `null`. Świeży `new Date()`
    // dawałby wtedy czas DRUGIEGO żądania: `audit_log_id` byłby ten sam,
    // a koperta — inna. Deklarowana własność „retry produkuje TĘ SAMĄ kopertę"
    // ma obejmować CAŁĄ kopertę, więc czas realizacji jest odczytywany
    // z istniejącego `voucher_event`, pobranego PRZED realizacją.
    claimed_at:
      claimedAt ?? earliestClaimedAt(existing.events) ?? new Date().toISOString(),
    redemption_id: redemption.redemption_id,
    amount_minor: redemption.amount_minor,
    remaining_after_minor: redemption.remaining_after_minor,
  }

  // Best-effort audit-log row in vendor_notification_log so SecOps can
  // correlate the redeem event with the vendor session. Failure does not
  // block the 200 response (audit row is observability, not business
  // invariant — the canonical record lives in `voucher_redemption`).
  await appendNotificationLog(req.scope, {
    vendor_id: vendorId,
    notification_type: "voucher_redeem",
    locale: "pl",
    recipient_email: "system",
    status: "sent",
    triggered_by: vendorId,
    metadata: { ...envelope },
  }).catch(() => {
    // observability-only
  })

  const response: VendorRedeemResponse = {
    ok: true,
    idempotent: redemption.idempotent,
    status,
    envelope,
  }
  res.status(200).json(response)
}

/** Voucher wygasł między pre-checkiem a projekcją — wycofuje całą transakcję. */
class VoucherExpiredDuringRedeemError extends Error {
  readonly error_code = "VOUCHER_EXPIRED"
  constructor(code: string) {
    super(`voucher '${code}' wygasł i nie może zostać zrealizowany`)
    this.name = "VoucherExpiredDuringRedeemError"
  }
}

/**
 * Mapowanie odmów domeny na kody HTTP. Każda gałąź jest ODMOWĄ — żadna nie
 * degraduje do zapisu `voucher_event`-only, bo to byłoby odtworzenie defektu,
 * który ta story usuwa.
 */
function respondToRedemptionError(res: MedusaResponse, error: unknown): void {
  if (error instanceof RedemptionEntitlementNotFoundError) {
    res.status(404).json({ code: error.error_code, message: error.message })
    return
  }
  if (error instanceof RedemptionEntitlementAmbiguousError) {
    res.status(409).json({ code: error.error_code, message: error.message })
    return
  }
  if (error instanceof RedemptionIdempotencyKeyRequiredError) {
    res.status(400).json({ code: error.error_code, message: error.message })
    return
  }
  if (error instanceof VoucherExpiredDuringRedeemError) {
    res.status(410).json({ code: error.error_code, message: error.message })
    return
  }
  if (
    error instanceof RedemptionMarketRequiredError ||
    error instanceof RedemptionBalanceError
  ) {
    res.status(422).json({ code: error.error_code, message: error.message })
    return
  }
  if (
    error instanceof RedeemAmountError ||
    error instanceof RedeemNotRedeemableError
  ) {
    res.status(422).json({
      code: "REDEMPTION_REFUSED",
      message: error.message,
    })
    return
  }
  throw error
}
