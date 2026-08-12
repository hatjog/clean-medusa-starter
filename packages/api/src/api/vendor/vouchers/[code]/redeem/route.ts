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
import { randomUUID } from "node:crypto"
import {
  HttpMarketContextError,
  resolveSellerMarketId,
  runInHttpMarketContext,
} from "../../../../../lib/http-market-context"
import { resolveRlsConnectionSource } from "../../../../../lib/rls-connection-source"
import {
  resolveVendorForSeller,
  VendorSellerContextError,
  type RequestWithSellerContext,
} from "../../../../../lib/vendor-seller-context"
import { appendNotificationLog } from "../../../../../lib/vendor-notification-log"
import {
  VOUCHER_MODULE,
  type VoucherService,
  type RedeemRefusalReason,
  type VoucherStatus,
  resolveRedeemRefusalReason,
} from "../../../../../modules/voucher"
import {
  createRedemptionPosthogSink,
  emitRedemptionHotPathMetrics,
} from "../../../../../lib/instrumentation/redemption-hot-path"
import {
  POSTHOG_CONTAINER_KEY,
  type PosthogCaptureClient,
} from "../../../../../lib/instrumentation/posthog-metrics-client"
import { maskActorId } from "../../../../../lib/instrumentation/posthog-canary"
import { resolveMeasurementContext } from "../../../../../lib/instrumentation/track"
import { REDEEM_REFUSALS } from "../../../../../modules/voucher/models/types"
import { VOUCHER_NOT_FOUND_BODY } from "../lookup/route"
import {
  buildAuditLogIdFromIdempotencyKey,
  buildPanelIdempotencyKey,
  createRedeemPartialOperationFromPool,
  RedeemAmountError,
  RedeemEntitlementStateError,
  RedeemNotRedeemableError,
  RedemptionBalanceError,
  RedemptionEntitlementAmbiguousError,
  RedemptionEntitlementNotFoundError,
  RedemptionIdempotencyKeyRequiredError,
  RedemptionMarketRequiredError,
} from "../../../../../modules/voucher/workflows/redeem-partial-entitlement"

type VendorRedeemAuditEnvelope = {
  audit_log_id: string
  vendor_id: string
  seller_id: string
  market_id: string | null
  code: string
  /**
   * Stan SPRZED przejścia. `null` jest wartością ZNACZĄCĄ, nie brakiem danych:
   * dla vouchera zrealizowanego PRZED wdrożeniem 5.8 zdarzenie `claimed` nie
   * ma `payload.prior_status`, a podstawienie stanu BIEŻĄCEGO produkowałoby
   * przy powtórce inną kopertę niż pierwsze żądanie — dokładnie to, czemu to
   * pole miało zapobiec (review-fix cyklu 1, LOW).
   */
  prior_status: VoucherStatus | null
  /**
   * Skutek ZDARZENIA realizacji — zawsze `claimed`. Odpowiedź na KONKRETNE
   * żądanie (`claimed` / `already_claimed`) niesie pole `status` obok koperty:
   * gdyby siedziało tutaj, powtórka produkowałaby inną kopertę tego samego
   * zdarzenia i deklaracja „retry daje TĘ SAMĄ kopertę" byłaby nieprawdziwa.
   */
  new_status: "claimed"
  claimed_at: string
  /** 5.7: identyfikator wiersza kanonicznego — podstawa rozliczenia. */
  redemption_id: string
  /** 5.7: zrealizowane brutto (minor units) zapisane w `voucher_redemption`. */
  amount_minor: number
  /** 5.7: saldo uprawnienia po realizacji (minor units). */
  remaining_after_minor: number
}

/**
 * TRZY rozróżnialne wyniki realizacji (v1.15.0 Story 5.8, AC6, UX-DR8).
 *
 * Dwa docierają tu jako `200`; trzeci — „już zrealizowany INNYM żądaniem" —
 * jest odmową `409 VOUCHER_ALREADY_REDEEMED` z `reason: "already_redeemed"`,
 * bo `claimed` nie jest na allow-liście stanów wejściowych (AD-17). To NIE
 * jest ta sama sytuacja co replay: replay ma TEN SAM klucz idempotencji
 * klienta, więc serwer wie, że to Twoje żądanie doszło dwa razy.
 */
type VendorRedeemOutcome = "redeemed_now" | "replayed_same_request"

type VendorRedeemResponse = {
  ok: true
  /** Zachowane dla zgodności z konsumentami sprzed 5.8. */
  idempotent: boolean
  outcome: VendorRedeemOutcome
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

/**
 * Kod odmowy dla wyjatku, ktorego trasa NIE zmapowala na status (v1.15.0
 * Story 6.2, review cyklu 1 F-2). Osobny literal, bo taka porazka nie jest
 * odmowa domeny — jest awaria i ma byc rozroznialna w metryce.
 */
export const HOT_PATH_UNHANDLED_REFUSAL_CODE = "UNHANDLED_EXCEPTION" as const

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
function earliestClaimedEvent(
  events:
    | Array<{
        event_type: string
        occurred_at: Date | string
        payload?: Record<string, unknown> | null
      }>
    | undefined
): { at: string; prior_status: VoucherStatus | null } | null {
  const claimed = (events ?? [])
    .filter((e) => e.event_type === "claimed")
    .filter((e) => Number.isFinite(new Date(e.occurred_at).getTime()))
    .sort(
      (a, b) =>
        new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()
    )[0]
  if (!claimed) return null
  const prior = claimed.payload?.prior_status
  return {
    at: new Date(claimed.occurred_at).toISOString(),
    prior_status: typeof prior === "string" ? (prior as VoucherStatus) : null,
  }
}

function earliestClaimedAt(
  events:
    | Array<{ event_type: string; occurred_at: Date | string }>
    | undefined
): string | null {
  return earliestClaimedEvent(events)?.at ?? null
}

export const POST = async (
  req: RequestWithSellerContext,
  res: MedusaResponse,
): Promise<void> => {
  // v1.15.0 Story 6.2 (AC1, NFR-11): GRANICA POMIARU jest zdefiniowana TUTAJ
  // i jest jedna: `t0` = wejscie handlera, `t1` = moment, w ktorym zadanie ma
  // stan terminalny (odpowiedz wyslana). Bez zapisanej granicy „czas realizacji"
  // da sie policzyc na cztery sposoby, a kazdy dalby inny percentyl.
  //
  // Emisja siedzi w `finally`, wiec obejmuje KAZDE z wyjsc tej trasy — takze
  // odmowy i wyjatki. Instrumentacja NIE zmienia logiki decyzyjnej: nie czyta
  // niczego, co wplywa na wynik, i nie moze go wywrocic (brak nosnika jest
  // stanem `carrier_unavailable`, nie wyjatkiem).
  const hotPathStartedAt = Date.now()
  // review cyklu 1 (F-5): kod odmowy ma PRODUCENTA. Poprzednia wersja czytala
  // `res.gp_refusal_code`, pole, ktorego w calym repo nikt nie ustawial — wiec
  // etykieta `refusal_code` byla ZAWSZE `null`, takze przy odmowach (ta sama
  // klasa co `DW-15-173`: czytelnik bez producenta). Zrodlem kodu jest cialo
  // odpowiedzi, ktore trasa i tak wysyla: `{ code, ... }`. Podgladamy je na
  // szwie `res.json`, wiec zrodlo jest jedno i obejmuje WSZYSTKIE osiem wyjsc
  // (takze te spoza mapera bledow), bez rozsiewania zapisow po handlerze.
  const refusal = observeRefusalCode(res)
  // review cyklu 1 (F-2): wyjatek z handlera nie moze byc liczony jako SUKCES.
  // `res.statusCode` ma w tym momencie domyslne 200 (status ustawia middleware
  // bledow Medusy PO naszym `finally`), wiec pomiar bez tej flagi emitowal serie
  // `success` z `http_status: 200` dla kazdej nieobsluzonej awarii — czyli byl
  // slepy dokladnie na te klase porazek, ktora NFR-11 najbardziej ma widziec.
  let handlerThrew = false
  try {
    await handleRedeemRequest(req, res)
  } catch (error) {
    handlerThrew = true
    throw error
  } finally {
    emitHotPathMetrics(req, res, hotPathStartedAt, {
      handlerThrew,
      refusalCode: refusal.code(),
    })
  }
}

/** Kod odmowy z ciala odpowiedzi — jedno zrodlo dla wszystkich wyjsc trasy. */
const observeRefusalCode = (res: MedusaResponse): { code: () => string | null } => {
  let observed: string | null = null
  const target = res as unknown as {
    json?: (payload: unknown) => unknown
  }
  const original = target.json
  if (typeof original === "function") {
    target.json = function patchedJson(this: unknown, payload: unknown) {
      const code = (payload as { code?: unknown } | null | undefined)?.code
      if (typeof code === "string" && code.length > 0) observed = code
      return original.call(this, payload)
    }
  }
  return { code: () => observed }
}

/** JEDEN warn na proces — brak nosnika ma byc glosny, ale nie spamujacy. */
let hotPathCarrierWarned = false
let hotPathEmitFailureWarned = false

const warnOnce = (
  req: RequestWithSellerContext,
  alreadyWarned: boolean,
  message: string,
  meta: Record<string, unknown>,
): boolean => {
  if (alreadyWarned) return true
  let logger: { warn?: (message: string, meta?: unknown) => void } | undefined
  try {
    logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER) as {
      warn?: (message: string, meta?: unknown) => void
    }
  } catch {
    logger = undefined
  }
  if (typeof logger?.warn === "function") logger.warn(message, meta)
  // eslint-disable-next-line no-console
  else console.warn(message, meta)
  return true
}

/**
 * Emisja metryk sciezki goracej. Zadna jej porazka nie moze zepsuc realizacji
 * vouchera — telemetria jest obserwacja, nie czescia sciezki pieniadza.
 *
 * ALE cisza tez nie jest dopuszczalna (review cyklu 1, F-3): puste `catch {}`
 * zamienialo „glosna odmowe" z AC2 w brak sladu, a brak serii jest
 * NIEODROZNIALNY od braku ruchu. Kazda porazka emisji i kazdy brak nosnika
 * zostawiaja `warn` (jeden na proces, wzorzec z `posthog-metrics-client`).
 */
const emitHotPathMetrics = (
  req: RequestWithSellerContext,
  res: MedusaResponse,
  startedAt: number,
  observed: { handlerThrew: boolean; refusalCode: string | null },
): void => {
  try {
    const client = (() => {
      try {
        return req.scope.resolve(POSTHOG_CONTAINER_KEY) as PosthogCaptureClient | null
      } catch {
        return null
      }
    })()

    const context = resolveMeasurementContext()
    const actorId = maskActorId(req.seller_context?.seller_id ?? "anonymous")
    // review cyklu 1 (F-1): klient z kontenera ma ksztalt `PosthogCaptureClient`
    // (jeden obiekt z `distinctId`), a port nosnika bierze dwa argumenty.
    // Adapter jest tu obowiazkowy — bez niego trasa nie emituje NICZEGO.
    const sink = createRedemptionPosthogSink(client, actorId)
    const succeeded =
      !observed.handlerThrew && res.statusCode >= 200 && res.statusCode < 300
    // Przy wyjatku `res.statusCode` klamie (domyslne 200) — miara musi wtedy
    // powiedziec `500`, bo tyle wysle middleware bledow.
    const status = observed.handlerThrew ? 500 : res.statusCode

    const result = emitRedemptionHotPathMetrics({
      sink,
      labels: {
        request_id: resolveHotPathRequestId(req),
        idempotency_key: readIdempotencyKeyHeader(req),
        market_id: (req as { gp_market_id?: string }).gp_market_id ?? "unknown",
        env: context.env,
        instance_id: context.instance_id,
        actor_id: actorId,
      },
      outcome: {
        duration_ms: Date.now() - startedAt,
        succeeded,
        http_status: status,
        refusal_code: succeeded
          ? null
          : observed.handlerThrew
            ? HOT_PATH_UNHANDLED_REFUSAL_CODE
            : observed.refusalCode,
      },
    })

    if (result === "carrier_unavailable") {
      hotPathCarrierWarned = warnOnce(
        req,
        hotPathCarrierWarned,
        "[redemption-hot-path] nosnik metryk (kontener: 'posthog') jest " +
          "niedostepny — serie NFR-11 NIE powstaja; brak serii nie jest " +
          "dowodem braku ruchu",
        { container_key: POSTHOG_CONTAINER_KEY },
      )
    }
  } catch (error) {
    // Metryka, ktora wywraca realizacje vouchera, jest gorsza niz brak metryki —
    // dlatego lykamy wyjatek. Ale zostawiamy slad, bo cisza jest najgorszym
    // mozliwym zachowaniem nosnika (AC2: odmowa ma byc GLOSNA).
    hotPathEmitFailureWarned = warnOnce(
      req,
      hotPathEmitFailureWarned,
      "[redemption-hot-path] emisja metryk NFR-11 zakonczyla sie wyjatkiem — " +
        "serie nie powstaly; realizacja vouchera przebiegla bez zmian",
      {
        error_class: error instanceof Error ? error.constructor.name : typeof error,
        error_message: error instanceof Error ? error.message : String(error),
      },
    )
  }
}

/** Wylacznie dla testow — resetuje jednorazowe tlumienie `warn`. */
export const __resetHotPathWarnStateForTests = (): void => {
  hotPathCarrierWarned = false
  hotPathEmitFailureWarned = false
}

/**
 * Identyfikator zadania z warstwy TRANSPORTOWEJ (review cyklu 1, F-10).
 * Kolejnosc jest ta sama co w `store/voucher-pii-consent` (Story 4.4, F9):
 * naglowek trace'a, potem korelacja, a na koncu wygenerowany identyfikator —
 * nigdy stala `"unknown"`, bo etykieta o zerowej mocy korelacyjnej jest gorsza
 * niz wartosc losowa: ta druga przynajmniej rozdziela zadania.
 */
const resolveHotPathRequestId = (req: RequestWithSellerContext): string => {
  const headers =
    (req as unknown as { headers?: Record<string, unknown> }).headers ?? {}
  for (const name of ["x-request-id", "x-correlation-id"]) {
    const raw = headers[name]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value === "string" && value.length > 0 && value.length <= 200) {
      return value
    }
  }
  const framework = (req as unknown as { requestId?: unknown }).requestId
  if (typeof framework === "string" && framework.length > 0) return framework
  return randomUUID()
}

const handleRedeemRequest = async (
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

  // v1.15.0 Story 5.8 (AC2): tożsamość pochodzi z transportu przeglądarkowego
  // zadeklarowanego w `VENDOR_HMAC_EXEMPT_ROUTES`, a nie z `req.vendorAuth`
  // (ta trasa jest ZWOLNIONA z bramki HMAC — patrz nagłówek pliku).
  let vendorId: string
  let authenticatedSellerId: string
  try {
    // Odczyt kontekstu sprzedawcy JEST TUTAJ, w module trasy — to jest dowód
    // transportu, który czyta `assert_auth_transport.py`.
    ;({ vendor_id: vendorId, seller_id: authenticatedSellerId } =
      await resolveVendorForSeller(req.scope, req.seller_context?.seller_id))
  } catch (error) {
    if (error instanceof VendorSellerContextError) {
      res.status(error.status).json({ code: error.code, message: error.message })
      return
    }
    throw error
  }

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
  req: RequestWithSellerContext,
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

  // ── Early-out, NIE decyzja autoryzacyjna (v1.15.0 Story 5.8, AD-20) ────────
  // `getForSeller` zwraca `null` dla kodu nieznanego I cudzego — jedną
  // gałęzią, jednym ciałem odmowy współdzielonym z trasą lookupu
  // (`VOUCHER_NOT_FOUND_BODY`), więc „nie twój" i „nieznany" są
  // nieodróżnialne co do statusu, ciała i nagłówków (UX-DR9). Oba przypadki
  // ODMOWY kończą się w `getForSeller` na jednym wąskim `SELECT seller_id`
  // (historia zdarzeń czytana jest dopiero po przejściu predykatu), więc czas
  // odpowiedzi nie różnicuje ich na poziomie grubym. Przed review cyklu 1
  // „nie twój" ciągnął dodatkowo CAŁĄ historię zdarzeń, a to twierdzenie było
  // mocniejsze niż kod.
  //
  // WIĄŻĄCY predykat własności NIE jest tutaj: siedzi pod blokadą w
  // `redeemForSeller`, na tym samym wierszu co mutacja. Ten odczyt jest
  // wyłącznie tanim odcięciem, żeby nie otwierać transakcji realizacji dla
  // kodu, który i tak nie ma prawa przejść. Gdyby stan zmienił się między nim
  // a blokadą, rozstrzyga blokada — i to jest cała różnica wobec kształtu
  // sprzed 5.8, w którym rozstrzygał TEN odczyt.
  const existing = await voucherService.getForSeller(authenticatedSellerId, code)
  if (!existing) {
    res.status(404).json(VOUCHER_NOT_FOUND_BODY)
    return
  }

  // Producent kanonicznej jedzie TĄ SAMĄ pulą, którą łata hook RLS (Story 2.6,
  // AD-21 §4). Własna pula byłaby drugim nośnikiem kontekstu rynku i pod
  // `FORCE RLS` nie zobaczyłaby ani jednego wiersza.
  const connectionSource = resolveRlsConnectionSource(
    req.scope,
    ContainerRegistrationKeys.PG_CONNECTION,
  )

  // ── JEDNA operacja domenowa przyjmująca najemcę (AD-20) ───────────────────
  // Do 5.8 stało tu `voucherService.claim(code)` — operacja, która najemcy NIE
  // ZNA — a własność była sprawdzana wyżej, na innym snapshocie. Teraz
  // wywoływane jest `redeemForSeller(sellerId, code)`, w którym `seller_id`,
  // `status` i `expires_at` pochodzą z TEGO SAMEGO `SELECT … FOR UPDATE`, co
  // mutacja. Klient transakcji jest przekazywany, więc blokada należy do tej
  // samej transakcji, w której powstał wiersz kanoniczny (M6).
  //
  // Każde `throw` stąd wycofuje CAŁĄ transakcję — łącznie z wierszem
  // kanonicznym — więc odmowa nigdy nie zostawia faktu bez projekcji ani
  // projekcji bez faktu.
  let priorStatus: VoucherStatus | null = null
  let claimedAt: string | null = null
  const operation = createRedeemPartialOperationFromPool(connectionSource, {
    async writeProjection(client, context) {
      const result = await voucherService.redeemForSeller(
        authenticatedSellerId,
        context.voucher_code,
        { now: context.now, client },
      )
      if (result.status === "not_found") {
        // Kod zniknął ALBO zmienił właściciela między early-outem a blokadą.
        // Jedno i drugie jest tą samą odmową co wyżej — bajt w bajt.
        throw new VoucherNotFoundDuringRedeemError(context.voucher_code)
      }
      if (result.status === "refused") {
        throw new VoucherRefusedDuringRedeemError(result.reason, context.voucher_code)
      }
      priorStatus = result.prior_status
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
    // Warstwa UPRAWNIENIA odmawia PIERWSZA (`REDEEMABLE_SOURCE_STATES`), więc
    // przy voucherze już zrealizowanym gałąź `redeemForSeller` nigdy nie biegnie
    // i kosmetolożka dostawałaby `422 REDEMPTION_REFUSED` — komunikat o
    // inwariancie domeny, a nie POWÓD, który da się przeczytać (UX-DR9).
    // ZMIERZONE: bez tego tłumaczenia trzeci przypadek UX-DR8 („już było, ale
    // nie to żądanie") wychodził jako 422 bez pola `reason`.
    //
    // ZAWĘŻONE w review-fix cyklu 1 (LOW): `RedeemNotRedeemableError` jest
    // rzucany z PIĘCIU miejsc, z których tylko jedno dotyczy stanu uprawnienia.
    // Łapanie całej klasy przypinało powód stanu vouchera („wycofany") odmowom
    // o zupełnie innej przyczynie (nieobsługiwany `entitlement_type`, zerowe
    // saldo, sprzeczne identyfikatory) — odmowa poprawna, powód zmyślony,
    // a UX-DR9 żąda powodu ROZRÓŻNIALNEGO, czyli prawdziwego. Podtyp
    // `RedeemEntitlementStateError` niesie dokładnie gałąź stanową.
    if (error instanceof RedeemEntitlementStateError) {
      // Snapshot `existing` pochodzi SPRZED transakcji, a etykieta ma opisywać
      // stan, w którym voucher jest TERAZ (drugi człon tego samego findingu).
      // Odczyt jest w zakresie najemcy i tani; gdy zniknie, zostaje snapshot.
      const current =
        (await voucherService.getForSeller(authenticatedSellerId, code)) ??
        existing
      const reason = resolveRedeemRefusalReason(
        current.status,
        current.expires_at ?? null,
        new Date(),
      )
      if (reason) {
        respondToRedemptionError(
          res,
          new VoucherRefusedDuringRedeemError(reason, code),
        )
        return
      }
    }
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

  // M5: źródłem replayu jest `ON CONFLICT DO NOTHING` na kanonicznej (zero
  // wstawionych wierszy ⇒ replay), a nie sam `voucher.status`. Dwie niezależne
  // bariery idempotencji na jednej trasie to dwie prawdy o tym samym zdarzeniu.
  //
  // v1.15.0 Story 5.8 (AC6, UX-DR8): wynik ma TRZY przypadki, nie dwa.
  // Trzeci — „już zrealizowany, ale INNYM żądaniem" — nie dociera tutaj:
  // jest ODMOWĄ (`VOUCHER_ALREADY_REDEEMED`, 409) z `redeemForSeller`, bo
  // `claimed` nie jest na allow-liście stanów wejściowych. Dwa przypadki
  // kończące się sukcesem to:
  //   `redeemed_now`          — przejście zaszło TERAZ,
  //   `replayed_same_request` — TEN SAM klucz idempotencji klienta; saldo nie
  //                             schodzi drugi raz, koperta jest ta sama.
  // Bez klucza generowanego przez klienta te dwa były nieodróżnialne od
  // realizacji przez KOGOŚ INNEGO na tym samym koncie salonu — dokładnie ten
  // scenariusz opisuje UX-DR8.
  const outcome: VendorRedeemOutcome = redemption.idempotent
    ? "replayed_same_request"
    : "redeemed_now"
  const status: "claimed" | "already_claimed" = redemption.idempotent
    ? "already_claimed"
    : "claimed"

  const envelope: VendorRedeemAuditEnvelope = {
    audit_log_id: auditLogId,
    vendor_id: vendorId,
    seller_id: authenticatedSellerId,
    market_id: existing.market_id ?? sellerMarketId,
    code,
    // Przy replayu projekcja nie biegnie (M6), więc `prior_status` z blokady
    // nie powstaje. Stan BIEŻĄCY (`claimed`) NIE nadaje się na zamiennik —
    // różniłby się od koperty pierwszego żądania. Źródłem jest `payload`
    // najwcześniejszego zdarzenia `claimed`, zapisany przez `redeemForSeller`
    // W TEJ SAMEJ transakcji co przejście.
    //
    // Trzeci człon to `null`, a NIE stan bieżący (review-fix cyklu 1, LOW).
    // Dla vouchera zrealizowanego PRZED 5.8 zdarzenie `claimed` nie ma
    // `payload.prior_status` (`claim()` wstawiał event bez payloadu), więc
    // podstawienie `existing.status` zwracałoby przy powtórce `"claimed"` —
    // czyli INNĄ kopertę niż pierwsze żądanie, dokładnie ten defekt, przed
    // którym to pole miało chronić. Cichy fallback zamieniony na jawny brak.
    prior_status:
      priorStatus ?? earliestClaimedEvent(existing.events)?.prior_status ?? null,
    // Koperta opisuje ZDARZENIE REALIZACJI, a to zdarzenie zaszło raz i miało
    // jeden skutek. `already_claimed` opisuje ODPOWIEDŹ na to żądanie i żyje
    // w polu `status` odpowiedzi — nie w kopercie, bo inaczej retry
    // produkowałby inną kopertę tego samego zdarzenia.
    new_status: "claimed",
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
  //
  // DECYZJA (v1.15.0 Story 5.7, review cykl 2 / L-4 człon 2): ten log liczy
  // PRÓBY, nie zdarzenia — dlatego replay ZOSTAWIA drugi wiersz i jest to
  // zamierzone, a nie przeoczenie. Korelacja SecOps ma widzieć, że sprzedawca
  // wysłał żądanie DWA razy; wygaszenie drugiego wiersza ukryłoby drugą sesję.
  // Ale dwa wiersze o IDENTYCZNEJ kopercie (a koperta jest przy replayu bajt
  // w bajt ta sama — `audit_log_id` i `claimed_at` są deterministyczne) czytają
  // się jak DWIE realizacje. Dlatego różnica jest w metadanych JAWNIE:
  // `idempotent_replay` odróżnia próbę od zdarzenia po stronie czytelnika.
  await appendNotificationLog(req.scope, {
    vendor_id: vendorId,
    notification_type: "voucher_redeem",
    locale: "pl",
    recipient_email: "system",
    status: "sent",
    triggered_by: vendorId,
    metadata: { ...envelope, idempotent_replay: redemption.idempotent },
  }).catch(() => {
    // observability-only
  })

  const response: VendorRedeemResponse = {
    ok: true,
    idempotent: redemption.idempotent,
    outcome,
    status,
    envelope,
  }
  res.status(200).json(response)
}

/**
 * Kod zniknął albo zmienił właściciela między early-outem a blokadą.
 * Wycofuje całą transakcję i wychodzi TĄ SAMĄ odmową co early-out.
 */
class VoucherNotFoundDuringRedeemError extends Error {
  constructor(code: string) {
    super(`voucher '${code}' nie istnieje w zakresie tego sprzedawcy`)
    this.name = "VoucherNotFoundDuringRedeemError"
  }
}

/**
 * Odmowa z ROZRÓŻNIALNYM powodem (v1.15.0 Story 5.8, AC7, UX-DR9).
 *
 * Powód jest kodem MASZYNOWYM; zdanie dla kosmetolożki składa panel z klucza
 * i18n wywiedzionego z tego kodu — serwer nie wysyła polskiego tekstu, bo
 * język interfejsu jest własnością panelu, a nie odpowiedzi HTTP.
 */
class VoucherRefusedDuringRedeemError extends Error {
  readonly reason: RedeemRefusalReason
  readonly error_code: string
  readonly http_status: number

  constructor(reason: RedeemRefusalReason, code: string) {
    super(`voucher '${code}': ${REFUSAL_MESSAGES[reason]}`)
    this.name = "VoucherRefusedDuringRedeemError"
    this.reason = reason
    this.error_code = REDEEM_REFUSALS[reason].api_code
    this.http_status = REDEEM_REFUSALS[reason].http_status
  }
}

/**
 * Opis diagnostyczny per powód. Kod maszynowy i status HTTP pochodzą z
 * `REDEEM_REFUSALS`, jednego nośnika parity z kontraktem ADR-209.
 *
 * `expired` zostaje przy `410 Gone` (zachowanie zastane, semantycznie trafne).
 * `already_redeemed` i `withdrawn` to `409 Conflict`: żądanie jest poprawne,
 * ale stan zasobu je wyklucza. `422` byłoby tu gorsze — sugerowałoby błąd
 * w treści żądania, którego nie ma.
 */
const REFUSAL_MESSAGES: Record<RedeemRefusalReason, string> = {
  already_redeemed: "ten voucher został już zrealizowany",
  withdrawn: "ten voucher został wycofany i nie może zostać zrealizowany",
  expired: "ten voucher wygasł i nie może zostać zrealizowany",
  not_redeemable:
    "stan tego vouchera nie jest na allow-liście stanów wejściowych realizacji",
  refunded:
    "ten voucher został zwrócony — pieniądze wróciły do klientki, więc kodu nie można zrealizować",
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
  // v1.15.0 Story 5.8 (AC7): odmowa niesie ROZRÓŻNIALNY powód jako pole
  // `reason` obok kodu — panel mapuje je na zdanie po polsku.
  if (error instanceof VoucherRefusedDuringRedeemError) {
    res.status(error.http_status).json({
      code: error.error_code,
      reason: error.reason,
      message: error.message,
    })
    return
  }
  // Ta odmowa jest CELOWO nieodróżnialna od „kod nieznany": to samo ciało,
  // ten sam status, ten sam literał źródłowy co w trasie lookupu.
  if (error instanceof VoucherNotFoundDuringRedeemError) {
    res.status(404).json(VOUCHER_NOT_FOUND_BODY)
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
