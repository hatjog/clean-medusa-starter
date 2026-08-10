/**
 * GET /store/entitlements?order_id=… — v1.15.0 DW-15-132 (Story 3.7, FR-8 człon b).
 *
 * ── Czego tu nie było ───────────────────────────────────────────────────────
 * Storefrontowy BFF `/api/v1/entitlements?order_id=` wołał tę ścieżkę od Story
 * 3.7, a ona NIGDY nie istniała: backend odpowiadał `Cannot GET
 * /store/entitlements` (domyślny handler Expressa), BFF mapował 404 na `502
 * entitlements_read_failed`, a kupująca dostawała „Nie udało nam się teraz
 * odczytać całego zakupu" — mimo że voucher istniał i mail poszedł. Testy BFF
 * mockują `fetch`, więc nie miały jak tego zmierzyć.
 *
 * ── Model dostępu: SKOPIOWANY, nie wymyślony ────────────────────────────────
 * Kolejność sprawdzeń, kody i audyt są takie same jak w
 * `store/orders/[id]/payment-status/route.ts`, bo to ta sama powierzchnia
 * post-payment i ten sam aktor. Rozstrzyga `lib/orders/guest-order-access.ts`:
 * sesja klientki ALBO dowód posiadania koszyka, który to zamówienie
 * wyprodukował. Bez sesji i bez dowodu odmawiamy PRZED dotknięciem bazy, żeby
 * odpowiedź nie zdradzała istnienia zamówienia. „Cudze" i „nieistniejące"
 * dostają IDENTYCZNE `404` z identycznym ciałem — to jawna decyzja: trasa nie
 * może być wyrocznią istnienia zamówienia.
 *
 * ── Trasa NIE zwraca danych odbiorcy (decyzja PO, 2026-08-10, po recenzji) ──
 * W ładunku NIE MA `recipient_name` ani `recipient_email` — i nie ma żadnego
 * zapytania, które by je czytało. Ekran potwierdzenia wykrywa prezent po
 * metadanych zamówienia po stronie storefrontu (`resolveRecipient` ma tam
 * własny fallback), a nie po tej odpowiedzi.
 *
 * ── Ładunek jest instrumentem na okaziciela ─────────────────────────────────
 * `voucher_code` ma `transferability: "bearer"`, więc odpowiedź jest wartością,
 * nie samym opisem stanu. Stąd `Cache-Control: no-store` na `200`: nic tego nie
 * przechowuje po drodze — ani proxy, ani dysk przeglądarki.
 *
 * ── Status zwracamy SUROWY ──────────────────────────────────────────────────
 * `entitlement_instance.state` bez tłumaczenia. UI czyta go DWIEMA drogami
 * naraz: `isGiftOrder` porównuje `status.toUpperCase() === 'ISSUED'`, a
 * `normalizeEntitlementPipelineStatus` lowercase'uje i mapuje przez aliasy.
 * Każde tłumaczenie po stronie backendu zepsułoby jedną z nich.
 *
 * ── Kształt: GOŁA TABLICA ───────────────────────────────────────────────────
 * BFF sprawdza `Array.isArray` i inaczej zwraca `502
 * entitlements_shape_invalid`. Jedno zamówienie ma N uprawnień (po jednym na
 * `line_item_id`) — nigdy `LIMIT 1`. Brak uprawnień to `200` z `[]`, NIE błąd:
 * „jeszcze nie wystawiono" musi być odróżnialne od awarii (AD-19), bo poller
 * na błędzie kończy pętlę, a na pustej tablicy czeka dalej.
 *
 * @see GP/storefront/src/app/api/v1/entitlements/route.ts (konsument / BFF)
 * @see GP/backend/packages/api/src/api/store/orders/[id]/payment-status/route.ts (wzorzec dostępu)
 * @see GP/backend/packages/api/src/api/v1/entitlements/by-claim-token/[token]/route.ts (wzorzec odczytu)
 */

import { randomBytes } from "crypto"

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { marketContextStorage } from "../../../lib/market-context"
import { isWithinMarketScope } from "../../../lib/market-scope-guard"
import { assertOrderAccess, parseCartProof } from "../../../lib/orders/guest-order-access"
import {
  buildVoucherPageUrl,
  resolveStorefrontBaseUrl,
} from "../../../modules/voucher-delivery/voucher-page-url"
import {
  resolveOrderModule,
  retrieveOrderByStatusIdentifier,
} from "../orders/[id]/payment-status/helpers"

// `AUTHENTICATE = false` znaczy dla frameworka DOKŁADNIE tyle: trasa jest
// `optedOutOfAuth`, więc globalny middleware `/store` (`router.js` montuje tam
// `authenticate("customer", ["bearer","session"], { allowUnauthenticated: true })`)
// ją POMIJA. Żadnej „semantyki auth admina" tu nie ma i nigdy nie było — admin
// dostaje własny middleware pod `/admin`. Uwierzytelnienie klientki instaluje
// dla tej trasy JAWNY wpis w `api/middlewares.ts`, żeby stało za nim
// rate-limitowanie w ustalonej kolejności.
export const AUTHENTICATE = false

/**
 * Locale deep-linku użyte, gdy zamówienie ani snapshot polityki go nie niosą.
 * Kolejność źródeł jest ta sama, co w `voucher/service.ts`:
 * `order.metadata.purchase_locale` → `policy_snapshot.purchase_locale` → tutaj.
 */
const DEFAULT_CLAIM_LOCALE = "pl"

type LoggerLike = {
  info?: (msg: string) => void
  warn?: (msg: string) => void
  error?: (msg: string) => void
}

type AuthenticatedMedusaRequest = MedusaRequest & {
  auth_context?: {
    actor_id?: string
  }
}

type KnexLike = {
  raw: (sql: string, bindings?: ReadonlyArray<unknown>) => Promise<{ rows?: unknown[] }>
}

function generateRequestId(): string {
  return `req_${randomBytes(6).toString("hex")}`
}

function resolveLogger(req: MedusaRequest): LoggerLike {
  try {
    return (req.scope.resolve("logger") as LoggerLike | undefined) ?? console
  } catch {
    return console
  }
}

/**
 * Okno próbkowania wpisu „gość dostał dostęp". Ekran potwierdzenia odpytuje tę
 * trasę co 5 s przez maksymalnie 10 minut, czyli ~120 razy na JEDNO zamówienie.
 * Wpis na każdy tick nie jest audytem, tylko szumem, który wypycha z logu
 * odmowy — a to one są tu sygnałem. Logujemy więc PIERWSZY dostęp w oknie
 * równym długości pollingu; kolejne w tym samym oknie są pominięte.
 */
const GUEST_ACCESS_LOG_WINDOW_MS = 10 * 60_000
/** Sufit pamięci dedupu — bez niego mapa rosłaby z każdym zamówieniem. */
const GUEST_ACCESS_LOG_MAX_ENTRIES = 5_000
const guestAccessLoggedAt = new Map<string, number>()

/** `true` dla pierwszego dostępu gościa do tego zamówienia w bieżącym oknie. */
function shouldLogGuestAccess(orderId: string, nowMs: number = Date.now()): boolean {
  const previous = guestAccessLoggedAt.get(orderId)
  if (previous !== undefined && nowMs - previous < GUEST_ACCESS_LOG_WINDOW_MS) {
    return false
  }
  if (guestAccessLoggedAt.size >= GUEST_ACCESS_LOG_MAX_ENTRIES) {
    for (const [key, at] of guestAccessLoggedAt) {
      if (nowMs - at >= GUEST_ACCESS_LOG_WINDOW_MS) guestAccessLoggedAt.delete(key)
    }
    // Nadal pełna (same świeże wpisy) — zwalniamy najstarszy wpis, żeby sufit
    // pamięci nie zamienił się w trwałe wyciszenie logu.
    if (guestAccessLoggedAt.size >= GUEST_ACCESS_LOG_MAX_ENTRIES) {
      const oldest = guestAccessLoggedAt.keys().next()
      if (!oldest.done) guestAccessLoggedAt.delete(oldest.value)
    }
  }
  guestAccessLoggedAt.set(orderId, nowMs)
  return true
}

/** Wyłącznie dla testów: czyści stan próbkowania logu dostępu gościa. */
export function resetGuestAccessLogSamplingForTests(): void {
  guestAccessLoggedAt.clear()
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function rowsOf(result: { rows?: unknown[] } | unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  const maybeRows = (result as { rows?: unknown } | null)?.rows
  return Array.isArray(maybeRows) ? (maybeRows as Record<string, unknown>[]) : []
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

/**
 * `reference_price_minor` jest `bigint`, a node-pg oddaje BIGINT jako STRING —
 * bez tej konwersji kwota wychodziłaby na front jako `"26000"` i psuła
 * formatowanie ceny po stronie UI.
 */
function readMinorAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function readIsoDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}

/**
 * Deep-link do strony vouchera. Świadomie przez JEDYNY builder linku
 * (`voucher-page-url.ts`) — drugi wariant ścieżki rozjechałby się z mailami
 * przy pierwszej zmianie routingu.
 *
 * Brak skonfigurowanej bazy per rynek nie może wywrócić odczytu zakupu: builder
 * RZUCA (bo dla wysyłki maila martwy link jest błędem operacyjnym), tutaj
 * degradujemy do `null`, a konsument renderuje wtedy zastępcze CTA.
 *
 * Degradacja jest NAZWANA w logu. Samo `catch { return null }` znaczyłoby, że
 * każdy brak konfiguracji rynku (i każdy przyszły błąd buildera) kończy się
 * zniknięciem przycisku „otwórz voucher" bez jednego śladu — a to jest dokładnie
 * ta klasa ciszy, którą ta trasa zamyka.
 */
function buildClaimUrl(input: {
  marketId: string | null
  locale: string | null
  voucherCode: string | null
  logger: LoggerLike
  request_id: string
}): string | null {
  if (!input.marketId || !input.voucherCode) return null
  try {
    const baseUrl = resolveStorefrontBaseUrl({ marketId: input.marketId })
    return buildVoucherPageUrl({
      baseUrl,
      locale: input.locale ?? DEFAULT_CLAIM_LOCALE,
      voucherCode: input.voucherCode,
    })
  } catch (err) {
    input.logger.warn?.(
      JSON.stringify({
        request_id: input.request_id,
        outcome: "claim_url_build_degraded",
        // Sam FAKT i klasa błędu — NIGDY kod vouchera (instrument na okaziciela).
        market_id: input.marketId,
        error: String(err),
        timestamp: new Date().toISOString(),
      }),
    )
    return null
  }
}

/**
 * Uprawnienia zamówienia. Kod vouchera NIE leży w `entitlement_instance` —
 * wiąże go join po JSON-ie (`policy_snapshot->>'voucher_code'`), tak samo jak
 * w trasie `by-claim-token`. `order_line_item` dokłada JEDYNIE tytuł pozycji
 * (ostatni fallback nazwy produktu); jego `metadata` nie jest już czytana, bo
 * służyła wyłącznie zdjętym danym odbiorcy. `"order".metadata` dokłada
 * `purchase_locale` dla deep-linku.
 *
 * Knex `db.raw()` przyjmuje `?` albo `:name`; PostgreSQL-owe `$N` daje
 * `Expected N bindings, saw 0` (SB-4).
 */
async function loadEntitlementRows(
  req: MedusaRequest,
  orderId: string,
): Promise<Record<string, unknown>[]> {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as KnexLike
  const result = await db.raw(
    `
      SELECT ei.id,
             ei.order_id,
             ei.line_item_id,
             ei.state,
             ei.policy_snapshot,
             ei.expires_at,
             ei.market_id,
             ei.remaining_amount,
             ei.reference_price_minor,
             ei.created_at,
             oli.title AS line_item_title,
             o.metadata AS order_metadata,
             v.code AS voucher_code,
             v.product_title,
             v.seller_name,
             v.seller_handle,
             v.value_minor,
             v.currency_code,
             v.expires_at AS voucher_expires_at
        FROM entitlement_instance ei
        LEFT JOIN voucher v ON v.code = (ei.policy_snapshot->>'voucher_code')
        LEFT JOIN order_line_item oli ON oli.id = ei.line_item_id
        LEFT JOIN "order" o ON o.id = ei.order_id
       WHERE ei.order_id = ?
       ORDER BY ei.created_at ASC, ei.id ASC
    `,
    [orderId],
  )
  return rowsOf(result)
}

/**
 * Reguły vouchera przepisane po JAWNEJ LIŚCIE PÓL.
 *
 * Wcześniej szedł tu CAŁY `policy_snapshot`. Zmierzone na realnym zamówieniu:
 * niesie m.in. `source_payment_intent_id: "pi_…"`, czyli identyfikator
 * płatności Stripe — dane wewnętrzne, które nie mają czego szukać w
 * przeglądarce. Konsumentem jest DOKŁADNIE JEDNA funkcja
 * (`normalizeVoucherRules` w storefroncie) i czyta z tego snapshotu dokładnie
 * pięć kluczy. Przepisujemy więc te pięć, a nie „wszystko, co akurat jest".
 *
 * Wartości idą VERBATIM (bez normalizacji kształtu): normalizacja po stronie
 * storefrontu jest osobnym zakresem, a milcząca zmiana kształtu tutaj byłaby
 * drugim, niezależnie dryfującym kontraktem.
 */
function projectVoucherRules(
  policySnapshot: Record<string, unknown>,
): Record<string, unknown> {
  const extension = isObject(policySnapshot.extension) ? policySnapshot.extension : undefined
  return {
    validity_months: policySnapshot.validity_months ?? null,
    cancellation: policySnapshot.cancellation ?? null,
    refund_channel: policySnapshot.refund_channel ?? null,
    no_show: policySnapshot.no_show ?? null,
    extension: extension
      ? {
          allowed: extension.allowed ?? null,
          paid: extension.paid ?? null,
          fee_pct: extension.fee_pct ?? null,
          max_extension_months: extension.max_extension_months ?? null,
        }
      : null,
  }
}

/**
 * Element odpowiedzi. NADZBIÓR tego, czym karmią BFF fixture'y e2e
 * (`status`, `voucher_code`, `product_name`, `salon_name`, `face_value_minor`,
 * `currency`, `claim_url`), plus `policy_snapshot` ZAWĘŻONY do reguł, bo BFF
 * liczy z niego `voucherRules` przez `normalizeVoucherRules`.
 *
 * ── Czego tu NIE MA i dlaczego ──────────────────────────────────────────────
 * Danych odbiorcy (decyzja PO) oraz WARTOŚCI DOMYŚLNYCH, które kłamią. `0` jest
 * nieodróżnialne od vouchera o zerowej wartości i UI wyrenderowałby „0,00 zł";
 * twarde `"PLN"` na rynku DE/UA byłoby po prostu złą walutą; `"ISSUED"` w
 * miejscu brakującego stanu mapuje się na stan TERMINALNY i zatrzymałby poller
 * na ekranie „dostarczone" przy wystawieniu, które jeszcze nie nastąpiło.
 * Brak danej wychodzi jako `null` — konsument ma prawo wiedzieć, że jej nie ma.
 */
function projectEntitlement(
  row: Record<string, unknown>,
  context: { logger: LoggerLike; request_id: string },
): Record<string, unknown> {
  const policySnapshot = isObject(row.policy_snapshot) ? row.policy_snapshot : {}
  const snapshotProduct = isObject(policySnapshot.product) ? policySnapshot.product : {}
  const snapshotSeller = isObject(policySnapshot.seller) ? policySnapshot.seller : {}
  const orderMetadata = isObject(row.order_metadata) ? row.order_metadata : {}

  const voucherCode = readString(row.voucher_code) ?? readString(policySnapshot.voucher_code)
  const marketId = readString(row.market_id)

  const faceValueMinor =
    readMinorAmount(row.value_minor) ??
    readMinorAmount(policySnapshot.amount_minor) ??
    readMinorAmount(row.reference_price_minor)

  const currency = readString(row.currency_code) ?? readString(policySnapshot.currency)

  // Locale ZAKUPU (AD-8), tą samą drogą co `voucher/service.ts`. Zdjęcie PII
  // odbiorcy zabrało poprzednie źródło (`voucher_recipient_pii.locale`) — a to
  // źródło i tak nigdy nie odpowiadało, bo tamto zapytanie padało zawsze.
  const claimLocale =
    readString(orderMetadata.purchase_locale) ?? readString(policySnapshot.purchase_locale)

  return {
    id: readString(row.id),
    order_id: readString(row.order_id),
    line_item_id: readString(row.line_item_id),
    // SUROWY stan — patrz nagłówek pliku. Brak stanu to `null`, NIE „ISSUED".
    status: readString(row.state),
    voucher_code: voucherCode,
    product_name:
      readString(snapshotProduct.name) ??
      readString(row.product_title) ??
      readString(row.line_item_title),
    salon_name: readString(snapshotSeller.name) ?? readString(row.seller_name),
    seller_handle: readString(row.seller_handle),
    face_value_minor: faceValueMinor,
    currency,
    remaining_amount: readMinorAmount(row.remaining_amount),
    expires_at: readIsoDate(row.expires_at) ?? readIsoDate(row.voucher_expires_at),
    created_at: readIsoDate(row.created_at),
    claim_url: buildClaimUrl({
      marketId,
      locale: claimLocale,
      voucherCode,
      logger: context.logger,
      request_id: context.request_id,
    }),
    // Nośnik reguł dla `normalizeVoucherRules` — po jawnej liście pól.
    policy_snapshot: projectVoucherRules(policySnapshot),
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const request_id = generateRequestId()
  const rawOrderId = (req.query as { order_id?: unknown } | undefined)?.order_id
  // Powtórzony parametr daje z Expressa tablicę — odrzucamy zamiast zgadywać,
  // który element jest „prawdziwy" (ta sama reguła co w `parseCartProof`).
  const orderId = typeof rawOrderId === "string" ? rawOrderId.trim() : ""

  if (!orderId) {
    res
      .status(400)
      .json({ type: "invalid_request", message: "order_id is required", request_id })
    return
  }

  const logger = resolveLogger(req)
  const customerId = (req as AuthenticatedMedusaRequest).auth_context?.actor_id
  const proof = parseCartProof((req.query as { cart_id?: unknown } | undefined)?.cart_id)

  // Bez sesji i bez dowodu nie ma czego rozstrzygać — odmawiamy zanim dotkniemy
  // bazy, więc odpowiedź nie zdradza, czy zamówienie istnieje.
  if (!customerId && !proof) {
    res
      .status(401)
      .json({ type: "unauthorized", message: "Customer authentication required", request_id })
    return
  }

  try {
    const orderModule = resolveOrderModule(req)
    const order = await retrieveOrderByStatusIdentifier(req, orderModule, orderId)

    if (!order) {
      res.status(customerId ? 404 : 401).json(
        customerId
          ? { type: "not_found", message: "Order not found", request_id }
          : { type: "unauthorized", message: "Customer authentication required", request_id },
      )
      return
    }

    const access = await assertOrderAccess({ req, order, orderId, customerId, proof })

    if (!access.granted) {
      // Audyt odmowy jest równie potrzebny jak audyt zgody: bez niego próby
      // zgadywania identyfikatora koszyka nie zostawiają żadnego śladu.
      logger.warn?.(
        JSON.stringify({
          actor: customerId ? "customer" : "guest",
          scope: `order:${orderId}`,
          request_id,
          outcome: "order_access_denied",
          reason: access.reason,
          timestamp: new Date().toISOString(),
        }),
      )
      if (access.reason === "no_proof") {
        res
          .status(401)
          .json({ type: "unauthorized", message: "Customer authentication required", request_id })
      } else {
        res.status(404).json({ type: "not_found", message: "Order not found", request_id })
      }
      return
    }

    // FAIL-CLOSED: brak KTÓREJKOLWIEK ze stron to odmowa. `404` (nie `403`),
    // żeby odmowa nie różniła się od „nie ma takiego zamówienia".
    const marketContext = marketContextStorage.getStore()
    if (!isWithinMarketScope(marketContext?.sales_channel_id, order.sales_channel_id)) {
      logger.warn?.(
        JSON.stringify({
          scope: `order:${orderId}`,
          request_id,
          outcome: "order_market_scope_denied",
          // Sam FAKT obecności kanałów, NIGDY wartości — log nie jest mapą rynków.
          context_channel_present: Boolean(marketContext?.sales_channel_id),
          order_channel_present: Boolean(order.sales_channel_id),
          timestamp: new Date().toISOString(),
        }),
      )
      res.status(404).json({ type: "not_found", message: "Order not found", request_id })
      return
    }

    if (access.actor === "guest" && shouldLogGuestAccess(orderId)) {
      logger.info?.(
        JSON.stringify({
          actor: "guest",
          scope: `order:${orderId}`,
          request_id,
          outcome: "guest_order_access_granted",
          proof: access.proof,
          // Wpis jest PRÓBKĄ, nie licznikiem — patrz `shouldLogGuestAccess`.
          sampled: true,
          sample_window_ms: GUEST_ACCESS_LOG_WINDOW_MS,
          timestamp: new Date().toISOString(),
        }),
      )
    }

    // Dopiero teraz czytamy dane: żądanie, które i tak dostanie 401/404, nie ma
    // prawa uruchamiać zapytań — inaczej sam czas odpowiedzi staje się wyrocznią.
    const resolvedOrderId = order.id ?? orderId
    const rows = await loadEntitlementRows(req, resolvedOrderId)

    // Ładunek niesie kod na okaziciela — nic go nie przechowuje po drodze.
    res.setHeader?.("Cache-Control", "no-store")
    // GOŁA TABLICA. Pusta = „jeszcze nie wystawiono", NIE awaria (AD-19).
    res
      .status(200)
      .json(rows.map((row) => projectEntitlement(row, { logger, request_id })))
  } catch (err) {
    logger.error?.(`[store-entitlements] GET ${orderId} error: ${String(err)}`)
    res.status(503).json({
      type: "service_unavailable",
      message: "Backend unavailable",
      request_id,
    })
  }
}
