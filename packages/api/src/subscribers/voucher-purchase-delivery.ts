/**
 * voucher-purchase-delivery.ts — subscriber pierwszej REALNEJ wysyłki produktowej
 * strumienia S3 (Story 2.3; FR-13, NFR3; AD-5 / AD-6 / AD-7).
 *
 * Story 2.4 (FR-15, FR-15a; AD-8) rozszerza go o DRUGI `template_key`
 * (`voucher_handoff_link` → obdarowana) — ta sama mechanika, ten sam ledger,
 * ten sam plik. Żadnej drugiej ścieżki wysyłki.
 *
 * ── Matryca normatywna AD-7 (stan → szablon) ────────────────────────────────
 *   `to_state = ISSUED` → `voucher_purchase_confirmation` → buyer
 *                       → `voucher_handoff_link` → recipient, WYŁĄCZNIE gdy
 *                         `purchase_mode = gift` ∧ send-timing „od razu" (2.4)
 *   `to_state = ACTIVE` → **ŻADEN nowy szablon**; konsumowane WYŁĄCZNIE dla
 *                          idempotentnego dogonienia TYCH SAMYCH kluczy
 *                          (gdy ISSUED przepadł — emit jest best-effort)
 *   każdy inny stan      → **no-op** (nie błąd)
 *
 * Obie wysyłki są NIEZALEŻNE: osobne wiersze ledgera (różny `template_key`
 * i różny `recipient_hash`), osobny retry, `failed` jednej nie rusza drugiej.
 *
 * ── Single-writer ledgera ───────────────────────────────────────────────────
 * Ten plik jest JEDYNYM pisarzem `voucher_delivery_dispatch`. Provider `brevo`
 * nie dotyka ledgera i nie importuje modułu voucher-delivery (kierunek
 * zależności pilnuje test `voucher-purchase-delivery-boundaries`).
 * Sekwencja: INSERT-first `ON CONFLICT DO NOTHING` (`queued`) →
 * `Modules.NOTIFICATION.createNotifications` → `queued→sent` albo `queued→failed`.
 *
 * ── `gp.communication.delivery_state_changed.v1` NIE jest emitowany ─────────
 * AD-7: enum stanów jest ZAPOŻYCZONY, event nie jest emitowany w v1.14.0. Ten
 * subscriber nie ma zależności od event busa — nie może go emitować nawet
 * przez pomyłkę, a test statyczny pilnuje, by nikt tego nie dodał.
 *
 * ── Defensywność (inwariant AD-6) ───────────────────────────────────────────
 * Brak encji / brak adresu / brak entitlementu → graceful skip + log
 * (`market_id` + przyczyna, ZERO PII). Awaria wysyłki → wiersz `failed`
 * z KODEM błędu (nigdy treścią odpowiedzi providera). Handler NIGDY nie rzuca:
 * mail nie może wywrócić konsumpcji eventu ani transakcji biznesowej, a mail
 * jest nieodwracalny, więc kompensacji nie ma — jest ledger i retry.
 *
 * ── Locale wysyłki: brak treści dla locale = FAIL-LOUD (decyzja 2.3) ────────
 * `ua`/`de` nie mają jeszcze treści (Epic 4) i mają `not_configured` w rejestrze
 * AD-6, więc provider skończy `BREVO_TEMPLATE_NOT_CONFIGURED` → wiersz `failed`
 * + log. ŚWIADOMIE NIE degradujemy do `pl`: mail w złym języku jest gorszy niż
 * brak maila, którego widać w ledgerze i który retry dogoni po uzupełnieniu
 * szablonu. Zapis decyzji: story Dev Agent Record + ADR-161.
 *
 * Fail-loud działa tylko wtedy, gdy REALNIE znamy `locales.supported` rynku.
 * Gdy konfiguracja locale jest niedostępna (błąd odczytu / brak bloku), a dane
 * domenowe niosą inne locale, wysyłka jest wstrzymywana z
 * `VOUCHER_DELIVERY_MARKET_LOCALES_UNAVAILABLE` zamiast cichego downgrade'u
 * do locale domyślnego (R-2.3-M6).
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import { resolveMarketLocale } from "../lib/get-market-locales"
import { resolveMarketScopedNotificationMarketId } from "../lib/notification-market-context"
import {
  createMarketLocalesReader,
  type MarketLocalesReader,
  type MarketLocalesSql,
} from "../lib/read-market-locales"
import { VOUCHER_MODULE } from "../modules/voucher"
import {
  PgDispatchLedger,
  type DispatchLedgerPort,
  type DispatchLedgerSql,
} from "../modules/voucher-delivery/dispatch-ledger"
import {
  evaluateGiftHandoff,
  type GiftHandoffSkipReason,
} from "../modules/voucher-delivery/gift-handoff"
import { buildHandoffLinkNotification } from "../modules/voucher-delivery/handoff-link-intent"
import { formatSalonAddress } from "../modules/voucher-delivery/notification-formatting"
import {
  buildPurchaseConfirmationNotification,
  VOUCHER_PURCHASE_DELIVERY_FLOW_ID,
  type PurchaseConfirmationIntentInput,
} from "../modules/voucher-delivery/purchase-confirmation-intent"
import {
  buildSalonUrl,
  buildVoucherPageUrl,
  resolveStorefrontBaseUrl,
} from "../modules/voucher-delivery/voucher-page-url"
import {
  hashRecipientEmail,
  RecipientHashError,
} from "../modules/voucher-delivery/recipient-hash"
import {
  extractErrorCodeMarker,
  extractProviderDetailMarker,
  extractProviderStatusMarker,
  NOTIFICATION_TEMPLATE_KEYS,
  sanitizeProviderDetail,
} from "@gp/messaging"

/** Ten sam literał, co `ENTITLEMENT_STATE_CHANGED_EVENT_TYPE` z 2.1 (AR-EVENTS). */
export const ENTITLEMENT_STATE_CHANGED_EVENT =
  "gp.entitlements.entitlement_state_changed.v1" as const

/**
 * Stany, dla których subscriber cokolwiek robi (AD-7). ACTIVE nie dodaje
 * szablonu — służy WYŁĄCZNIE dogonieniu tych samych kluczy.
 */
const DELIVERABLE_TO_STATES = new Set(["ISSUED", "ACTIVE"])

/**
 * Kod błędu dla „konfiguracja locale rynku nieznana" (R-2.3-M6). Odróżnia
 * degradację KONFIGURACJI od legalnego „locale niewspierane przez rynek" —
 * bez niego jedno i drugie kończyło się cichym mailem po polsku.
 */
export const MARKET_LOCALES_UNAVAILABLE_ERROR_CODE =
  "VOUCHER_DELIVERY_MARKET_LOCALES_UNAVAILABLE"

/**
 * Story 5.7 (AC2) — odczyt `market_runtime_config` nie doszedł do skutku
 * (np. tabela nie istnieje w tym runtime). Odróżnione od „rynek istnieje, ale
 * nie ma kompletu danych", bo remediacja jest inna: migracja vs sync.
 */
export const MARKET_RUNTIME_CONFIG_UNAVAILABLE_ERROR_CODE =
  "VOUCHER_DELIVERY_MARKET_RUNTIME_CONFIG_UNAVAILABLE"

/** Story 5.7 (AC2) — wiersz rynku istnieje, ale brakuje w nim kontaktu/URL. */
export const MARKET_RUNTIME_CONFIG_INCOMPLETE_ERROR_CODE =
  "VOUCHER_DELIVERY_MARKET_RUNTIME_CONFIG_INCOMPLETE"

/**
 * Próg staleness porzuconej rezerwacji (R-2.3-L9). `queued` starsze niż ten
 * próg nie jest „wysyłką w locie u innego workera" — z dużym prawdopodobieństwem
 * to wiersz po crashu procesu między INSERT-em a `markSent/markFailed`.
 * Do czasu dostarczenia sweepa (Story 2.5 — TWARDA zależność 2.3 → 2.5) jedynym
 * sygnałem alarmowym jest log: dlatego wtedy `warn`, nie `info`.
 */
export const STALE_QUEUED_THRESHOLD_MS = 15 * 60 * 1000

type LoggerLike = {
  info?: (message: string, meta?: Record<string, unknown>) => void
  warn?: (message: string, meta?: Record<string, unknown>) => void
  error?: (message: string, error?: unknown) => void
}

type TransitionEnvelopeLike = {
  event_type?: string
  occurred_at?: string
  scope?: {
    instance_id?: string
    market_id?: string
    vendor_id?: string | null
    location_id?: string | null
  }
  payload?: {
    entitlement_id?: string
    from_state?: string
    to_state?: string
    transitioned_at?: string
    actor_hint?: string
  }
}

/** Znormalizowane wejście: koperta `envelope.v1` ALBO płaski payload. */
export type PurchaseDeliveryTrigger = {
  entitlement_id: string | null
  to_state: string | null
  from_state: string | null
  market_id: string | null
}

/** Projekcja źródła — wąski podzbiór `VoucherService.findBuyerClaimSource`. */
export type PurchaseDeliverySource = {
  buyer_email: string | null
  voucher_code: string | null
  market_id?: string | null
  purchase_locale?: string | null
  buyer_locale?: string | null
  /**
   * Story 2.4 (ADR-163 gift-flow-v1) — kontrakt prezentu z `line_item.metadata`.
   * Pola są OPCJONALNE: zamówienia sprzed 2.4 i ścieżki bez koszyka ich nie
   * niosą, co jest legalnym „to nie prezent", a nie błędem.
   */
  purchase_mode?: string | null
  gift_recipient_email?: string | null
  gift_recipient_send_timing?: string | null
  gift_recipient_bound_to_voucher_issue?: boolean | null
  /**
   * Story 5.7 (AC3/AC4) — dane TREŚCI maila z projekcji źródłowej. Opcjonalne
   * w typie, bo tę samą strukturę zwracają zastane atrapy; brak wartości nie
   * przechodzi jednak dalej niż do buildera, który odmawia zbudowania payloadu
   * bez pokrycia kontraktu `body_vars`.
   */
  customer_first_name?: string | null
  seller_name?: string | null
  seller_handle?: string | null
  order_id?: string | null
  order_display_id?: string | null
  purchase_date?: string | null
  voucher_expires_at?: string | null
  voucher_value_minor?: number | string | null
  voucher_currency?: string | null
  salon_address_1?: string | null
  salon_address_2?: string | null
  salon_postal_code?: string | null
  salon_city?: string | null
}

export type PurchaseDeliverySourceReader = {
  findBuyerClaimSource(
    voucher_id: string,
    voucher_code: string | null,
  ): Promise<PurchaseDeliverySource | null>
}

export type PurchaseDeliveryDispatcher = {
  dispatch(payload: Record<string, unknown>): Promise<unknown>
}

export type PurchaseDeliveryOutcome =
  | "skipped_state_out_of_matrix"
  | "skipped_missing_entitlement_id"
  | "skipped_source_not_found"
  | "skipped_missing_recipient"
  | "skipped_missing_voucher_code"
  | "skipped_already_sent"
  | "skipped_in_flight"
  /** Story 2.4 — predykat gift/handoff nie przepuścił wysyłki (AC2). */
  | "skipped_not_eligible"
  | "sent"
  | "failed"

/**
 * Story 2.4 — wynik handoffu. Rozłączny od wyniku buyer-maila, bo obie wysyłki
 * są NIEZALEŻNE (osobne wiersze ledgera, osobny retry). `skip_reason` jest
 * enumem, nigdy adresem — ta struktura bywa logowana (D-70).
 */
export type GiftHandoffResult = {
  outcome: PurchaseDeliveryOutcome
  dispatch_id: string | null
  locale: string | null
  error_code: string | null
  skip_reason: GiftHandoffSkipReason | null
}

export type PurchaseDeliveryResult = {
  outcome: PurchaseDeliveryOutcome
  entitlement_id: string | null
  dispatch_id: string | null
  market_id: string | null
  locale: string | null
  error_code: string | null
  /**
   * Story 2.4 — wynik handoffu; `null` gdy w ogóle nie był rozważany (stan
   * spoza matrycy, brak encji źródłowej, brak kodu vouchera, błąd konfiguracji).
   */
  handoff: GiftHandoffResult | null
}

/** Która z dwóch wysyłek matrycy AD-7 jest właśnie realizowana. */
type DispatchKind = "buyer" | "handoff"

/** Kontekst wspólny dla obu wysyłek — liczony RAZ, nie per szablon. */
type DispatchAttemptContext = {
  trigger: PurchaseDeliveryTrigger
  entitlementId: string
  marketId: string
  locale: string
  voucherCode: string
  /** Deep-link `/{locale}/voucher/{code}` — jeden dla obu maili (5.7 AC6.5). */
  voucherPageUrl: string
  /** Zmienne treści wspólne dla obu szablonów (5.7 AC3/AC4). */
  body: Omit<
    PurchaseConfirmationIntentInput,
    | "recipient_email"
    | "recipient_hash"
    | "entitlement_id"
    | "voucher_code"
    | "market_id"
    | "locale"
    | "dispatch_id"
    | "voucher_page_url"
  >
}

export interface PurchaseDeliveryDeps {
  sourceReader: PurchaseDeliverySourceReader
  ledger: DispatchLedgerPort
  dispatcher: PurchaseDeliveryDispatcher
  marketLocales: MarketLocalesReader
  logger?: LoggerLike
  env?: NodeJS.ProcessEnv
  /** Provider zapisywany do ledgera (audit korelacji), domyślnie `brevo`. */
  provider?: string
  /** Zegar — wstrzykiwalny dla testów progu staleness (`STALE_QUEUED_THRESHOLD_MS`). */
  now?: () => Date
}

export function extractPurchaseDeliveryTrigger(
  data: unknown,
): PurchaseDeliveryTrigger {
  const envelope = (data ?? {}) as TransitionEnvelopeLike
  const payload =
    envelope.payload && typeof envelope.payload === "object"
      ? envelope.payload
      : ((data ?? {}) as NonNullable<TransitionEnvelopeLike["payload"]>)
  const scope = envelope.scope

  return {
    entitlement_id: nonEmpty(payload?.entitlement_id),
    to_state: nonEmpty(payload?.to_state),
    from_state: nonEmpty(payload?.from_state),
    // `scope.market_id` JEST w kopercie eventu (2.1) — to pierwszy, najtańszy
    // nośnik rynku z danych domenowych (R-2.2-M4 / AC6b).
    market_id: nonEmpty(scope?.market_id),
  }
}

/**
 * Eksportowany czysty handler — testowalny bez kontenera Medusy, bez DB
 * i bez sieci. NIGDY nie rzuca: każdy błąd staje się wynikiem + logiem.
 */
export async function handleVoucherPurchaseDelivery(
  data: unknown,
  deps: PurchaseDeliveryDeps,
): Promise<PurchaseDeliveryResult> {
  const trigger = extractPurchaseDeliveryTrigger(data)

  if (!trigger.to_state || !DELIVERABLE_TO_STATES.has(trigger.to_state)) {
    // No-op, NIE błąd: subscriber słucha wszystkich tranzycji L4, a matryca
    // AD-7 mówi, że tylko dwie z nich cokolwiek wysyłają.
    return result("skipped_state_out_of_matrix", trigger, null, null, null)
  }

  if (!trigger.entitlement_id) {
    deps.logger?.warn?.(
      "[voucher-purchase-delivery] pominięto: event bez entitlement_id",
      { to_state: trigger.to_state, market_id: trigger.market_id },
    )
    return result("skipped_missing_entitlement_id", trigger, null, null, null)
  }

  const entitlementId = trigger.entitlement_id

  let source: PurchaseDeliverySource | null = null
  try {
    source = await deps.sourceReader.findBuyerClaimSource(entitlementId, null)
  } catch (error) {
    // Projekcja to I/O — jej awaria nie może wywrócić konsumpcji eventu.
    deps.logger?.warn?.(
      "[voucher-purchase-delivery] pominięto: odczyt projekcji źródłowej nieudany",
      {
        entitlement_id: entitlementId,
        market_id: trigger.market_id,
        error_class: errorClass(error),
      },
    )
    return result("skipped_source_not_found", trigger, null, null, null)
  }

  if (!source) {
    deps.logger?.warn?.(
      "[voucher-purchase-delivery] pominięto: brak encji źródłowej dla entitlementu",
      { entitlement_id: entitlementId, market_id: trigger.market_id },
    )
    return result("skipped_source_not_found", trigger, null, null, null)
  }

  // R-2.2-M4 / AC6b: rynek z DANYCH DOMENOWYCH (koperta eventu → projekcja).
  // Fallback konfiguracyjny zostaje jako ostatnia linia obrony, ale na tej
  // ścieżce nie powinien się już odpalać — dlatego jest głośny.
  const marketId = resolveMarketScopedNotificationMarketId({
    market_id: trigger.market_id ?? source.market_id ?? null,
    call_site: "voucher-purchase-delivery",
    logger: deps.logger,
    env: deps.env,
  })

  const recipientEmail = nonEmpty(source.buyer_email)
  if (!recipientEmail) {
    deps.logger?.warn?.(
      "[voucher-purchase-delivery] pominięto: brak adresu odbiorcy w danych domenowych",
      { entitlement_id: entitlementId, market_id: marketId },
    )
    // Story 2.4: brak adresu KUPUJĄCEJ nie kończy konsumpcji — handoff ma
    // własnego odbiorcę i własny wiersz ledgera, więc nie może paść przez
    // brak buyer-maila (AC2: obie wysyłki są niezależne w awarii).
  }

  const voucherCode = nonEmpty(source.voucher_code)
  if (!voucherCode) {
    // Bez kodu vouchera mail nie ma treści wymaganej przez AC4 (kod + link
    // claim), a wysłanie „czegoś" byłoby cichym pogorszeniem.
    deps.logger?.warn?.(
      "[voucher-purchase-delivery] pominięto: brak voucher_code w projekcji źródłowej",
      { entitlement_id: entitlementId, market_id: marketId },
    )
    return result("skipped_missing_voucher_code", trigger, null, marketId, null)
  }

  // LOW#6 (code-review 2.4): decyzja handoffu jest PURE (nie zależy od locale
  // rynku ani base URL), więc liczymy ją PRZED bramkami fail-loud poniżej.
  // Gdy NIC nie ma być wysłane — brak buyer-maila I handoff nieeligible — nie
  // wolno wchodzić w bramki locale/claim URL: przed 2.4 taki przypadek (np.
  // zamówienie importowe bez buyer-maila, na rynku bez skonfigurowanego
  // GP_STOREFRONT_URL) kończył się cichym `skipped_missing_recipient`; wejście
  // w bramki fail-loud zamieniłoby to na fałszywy sygnał awarii konfiguracji
  // w KPI/logu dla przypadku, w którym nie było komu nic wysłać.
  const handoffDecision = evaluateGiftHandoff(source)
  if (!recipientEmail && !handoffDecision.eligible) {
    return {
      outcome: "skipped_missing_recipient",
      entitlement_id: entitlementId,
      dispatch_id: null,
      market_id: marketId,
      locale: null,
      error_code: null,
      handoff: {
        outcome: "skipped_not_eligible",
        dispatch_id: null,
        locale: null,
        error_code: null,
        skip_reason: handoffDecision.reason,
      },
    }
  }

  // AC3: locale ZAKUPU z `order.metadata.purchase_locale`; `buyer_locale`
  // (snapshot polityki) jest wtórnym nośnikiem tej samej intencji.
  const requestedLocale = source.purchase_locale ?? source.buyer_locale ?? null
  const marketLocaleRead = await deps.marketLocales.read(marketId)
  const localeResolution = resolveMarketLocale({
    requested: requestedLocale,
    marketId,
    locales: marketLocaleRead.config,
    callSite: "voucher-purchase-delivery",
    logger: deps.logger,
  })
  const locale = localeResolution.locale

  // R-2.3-M6 / AC4 („FAIL-LOUD, bez downgrade'u"): gdy konfiguracja locale rynku
  // jest NIEZNANA (błąd odczytu / brak bloku `locales` → shim env), a dane
  // domenowe niosą locale, którego ten shim nie zna, to NIE jest „locale
  // niewspierane przez rynek" — to niewiedza o rynku. Cichy downgrade do `pl`
  // dałby maila w złym języku wyglądającego jak sukces, więc wstrzymujemy
  // wysyłkę z własnym kodem błędu; retry dogoni po naprawie konfiguracji.
  //
  // Brak `purchase_locale` (zamówienia historyczne, ścieżki admin/import) NIE
  // jest tym przypadkiem — tam `locales.default` jest legalnym wyborem (AC3).
  if (marketLocaleRead.degraded && localeResolution.reason === "not_supported_by_market") {
    deps.logger?.error?.(
      "[voucher-purchase-delivery] konfiguracja locale rynku niedostępna, a dane domenowe " +
        "niosą inne locale — wysyłka wstrzymana zamiast downgrade'u do locale domyślnego",
      {
        entitlement_id: entitlementId,
        market_id: marketId,
        requested_locale: requestedLocale,
        error_code: MARKET_LOCALES_UNAVAILABLE_ERROR_CODE,
      },
    )
    return {
      outcome: "failed",
      entitlement_id: entitlementId,
      // Wiersz ograniczający: bez niego sweep widzi „brak wiersza" i ponawia
      // bez licznika. Locale wiersza to locale ŻĄDANE (to, którego rynek
      // rzekomo nie wspiera) — nie fallback, którego ta gałąź wprost odmawia.
      dispatch_id: await recordPreflightConfigurationFailure(
        {
          entitlementId,
          marketId,
          locale: requestedLocale ?? locale,
          errorCode: MARKET_LOCALES_UNAVAILABLE_ERROR_CODE,
          recipientEmail,
        },
        deps,
      ),
      market_id: marketId,
      locale: null,
      error_code: MARKET_LOCALES_UNAVAILABLE_ERROR_CODE,
      handoff: null,
    }
  }

  // Link liczymy PRZED rezerwacją: brak/zła baza URL to błąd konfiguracji,
  // nie nieudana wysyłka — nie chcemy zostawiać po nim wiersza `queued`.
  let voucherPageUrl: string
  try {
    voucherPageUrl = buildVoucherPageUrl({
      // Logger jest przekazywany po to, żeby baza z zakresu LAN zostawiła
      // `warn` (finding #1): guard sprawdza KSZTAŁT, nie osiągalność.
      baseUrl: resolveStorefrontBaseUrl({
        marketId,
        env: deps.env,
        logger: deps.logger,
      }),
      locale,
      voucherCode,
    })
  } catch (error) {
    const errorCode = readErrorCode(error, "VOUCHER_DELIVERY_STOREFRONT_URL_NOT_CONFIGURED")
    deps.logger?.error?.(
      "[voucher-purchase-delivery] konfiguracja base URL storefrontu niekompletna — wysyłka wstrzymana",
      { entitlement_id: entitlementId, market_id: marketId, error_code: errorCode },
    )
    return {
      outcome: "failed",
      entitlement_id: entitlementId,
      dispatch_id: await recordPreflightConfigurationFailure(
        { entitlementId, marketId, locale, errorCode, recipientEmail },
        deps,
      ),
      market_id: marketId,
      locale,
      error_code: errorCode,
      handoff: null,
    }
  }

  // Story 5.7 (AC2): `support_email` i `market_url` pochodzą WYŁĄCZNIE z
  // ożywionego kanału gp-config → `market_runtime_config`. Brak metody odczytu
  // (zastana atrapa), błąd odczytu i brak wiersza są traktowane jednakowo —
  // fail-loud PRZED rezerwacją. Cichy fallback do env był dokładnie tym, co
  // wysłało do PO maila z pustą stopką i pustym adresem rynku.
  const runtimeConfig = deps.marketLocales.readRuntimeConfig
    ? await deps.marketLocales.readRuntimeConfig(marketId)
    : { row: null, degraded: true }
  const supportEmail = nonEmpty(runtimeConfig.row?.support_email)
  const marketUrl = nonEmpty(runtimeConfig.row?.market_url)

  if (!supportEmail || !marketUrl) {
    const errorCode = runtimeConfig.degraded
      ? MARKET_RUNTIME_CONFIG_UNAVAILABLE_ERROR_CODE
      : MARKET_RUNTIME_CONFIG_INCOMPLETE_ERROR_CODE
    deps.logger?.error?.(
      "[voucher-purchase-delivery] runtime config rynku bez kompletu danych kontaktowych — " +
        "wysyłka wstrzymana (uruchom `gp-config-sync-market-runtime … --apply`)",
      {
        entitlement_id: entitlementId,
        market_id: marketId,
        error_code: errorCode,
        // Nazwy brakujących pól, nigdy ich wartości.
        missing: [
          ...(supportEmail ? [] : ["support_email"]),
          ...(marketUrl ? [] : ["market_url"]),
        ],
      },
    )
    return {
      outcome: "failed",
      entitlement_id: entitlementId,
      dispatch_id: await recordPreflightConfigurationFailure(
        { entitlementId, marketId, locale, errorCode, recipientEmail },
        deps,
      ),
      market_id: marketId,
      locale,
      error_code: errorCode,
      handoff: null,
    }
  }

  const sellerHandle = nonEmpty(source.seller_handle)

  // Wszystko poniżej jest WSPÓLNE dla obu wysyłek: ten sam rynek, to samo
  // locale (`purchase_locale` — locale KUPUJĄCEJ, AD-8), ten sam deep-link i
  // ten sam komplet zmiennych treści.
  const context: DispatchAttemptContext = {
    trigger,
    entitlementId,
    marketId,
    locale,
    voucherCode,
    voucherPageUrl,
    body: {
      customer_first_name: nonEmpty(source.customer_first_name),
      salon_name: nonEmpty(source.seller_name),
      salon_address: formatSalonAddress({
        address_1: source.salon_address_1 ?? null,
        address_2: source.salon_address_2 ?? null,
        postal_code: source.salon_postal_code ?? null,
        city: source.salon_city ?? null,
      }),
      support_email: supportEmail,
      market_url: marketUrl,
      voucher_expires_at: source.voucher_expires_at ?? null,
      // `display_id` jest tym, co kupująca widzi w koncie i na fakturze; ULID
      // zamówienia byłby dla niej nieczytelny. Fallback na `order_id` istnieje,
      // bo zamówienia importowe bywają bez `display_id`.
      order_id: nonEmpty(source.order_display_id) ?? nonEmpty(source.order_id),
      purchase_date: source.purchase_date ?? null,
      voucher_value_minor: source.voucher_value_minor ?? null,
      voucher_currency: nonEmpty(source.voucher_currency),
      salon_url: sellerHandle
        ? buildSalonUrl({ marketUrl, locale, sellerHandle })
        : null,
    },
  }

  // ── Buyer-mail (Story 2.3) ────────────────────────────────────────────────
  // Brak adresu kupującej NIE przerywa konsumpcji — handoff ma własnego
  // odbiorcę i własny wiersz ledgera (AC2: niezależność w awarii).
  const buyerResult: PurchaseDeliveryResult = recipientEmail
    ? await runDispatchAttempt("buyer", recipientEmail, context, deps)
    : result("skipped_missing_recipient", trigger, null, marketId, null)

  // ── Handoff do obdarowanej (Story 2.4, AC1/AC2) ───────────────────────────
  // TA SAMA sekwencja, TEN SAM ledger, TEN SAM subscriber — różni się wyłącznie
  // `template_key` i `recipient_hash`. Awaria buyer-maila nie może zabrać
  // handoffu ani odwrotnie, więc kolejność jest bez znaczenia dla wyniku.
  const handoff = await runGiftHandoff(handoffDecision, context, deps)

  return { ...buyerResult, handoff }
}

/**
 * Story 2.4 (AC1/AC2) — decyzja o handoffie + wysyłka tą samą sekwencją.
 *
 * NIGDY nie rzuca i NIGDY nie loguje adresu: powodem odmowy jest zawsze enum
 * `GiftHandoffSkipReason`. Rezerwacja w ledgerze powstaje DOPIERO po przejściu
 * predykatu — dzięki temu wariant „przekażę osobiście" i zastane `scheduled`
 * nie zostawiają sierocego wiersza `queued`.
 *
 * Decyzja jest przekazana z `handleVoucherPurchaseDelivery` (LOW#6, code-review
 * 2.4) — liczona TAM raz, przed bramkami fail-loud locale/claim URL, żeby ta
 * funkcja i wczesny fast-path „nic do wysłania" nigdy się nie rozjechały.
 */
async function runGiftHandoff(
  decision: ReturnType<typeof evaluateGiftHandoff>,
  context: DispatchAttemptContext,
  deps: PurchaseDeliveryDeps,
): Promise<GiftHandoffResult> {
  if (!decision.eligible) {
    if (decision.reason !== "not_gift") {
      // `not_gift` to zdecydowana większość ruchu (zakup dla siebie) — logowanie
      // go zalałoby log. Każdy inny powód oznacza „to MIAŁ być prezent, a mail
      // nie poszedł" i musi być widoczny.
      deps.logger?.info?.(
        "[voucher-purchase-delivery/handoff] pominięto wysyłkę do obdarowanej",
        {
          entitlement_id: context.entitlementId,
          market_id: context.marketId,
          to_state: context.trigger.to_state,
          reason: decision.reason,
        },
      )
    }
    return {
      outcome: "skipped_not_eligible",
      dispatch_id: null,
      locale: null,
      error_code: null,
      skip_reason: decision.reason,
    }
  }

  const attempt = await runDispatchAttempt(
    "handoff",
    decision.recipient_email,
    context,
    deps,
  )

  return {
    outcome: attempt.outcome,
    dispatch_id: attempt.dispatch_id,
    locale: attempt.locale,
    error_code: attempt.error_code,
    // INFO#11 (code-review 2.4): predykat już uznał adres za eligible, więc
    // `attempt.outcome === "skipped_missing_recipient"` tutaj może wyjść
    // WYŁĄCZNIE z `hashRecipientEmail` (adres, który przeszedł walidację
    // kształtu w `evaluateGiftHandoff`, ale nie da się zahashować). Bez tego
    // rozróżnienia dwa różne „handoff nie poszedł" były nierozróżnialne w
    // wyniku (ADR-163 §5 obiecuje enum powodu dla KAŻDEGO pominięcia).
    skip_reason:
      attempt.outcome === "skipped_missing_recipient"
        ? "invalid_recipient_email"
        : null,
  }
}

/**
 * Jedyna sekwencja wysyłki w tym subscriberze: `recipient_hash` → rezerwacja
 * (INSERT-first `ON CONFLICT DO NOTHING`) → `Modules.NOTIFICATION` →
 * `queued→sent|failed`. Buyer-mail i handoff różnią się WYŁĄCZNIE kluczem
 * szablonu, odbiorcą i budowniczym payloadu — reszta jest wspólna, żeby nie
 * mogły się rozjechać (największe ryzyko Story 2.4: druga ścieżka wysyłki).
 */
async function runDispatchAttempt(
  kind: DispatchKind,
  recipientEmail: string,
  context: DispatchAttemptContext,
  deps: PurchaseDeliveryDeps,
): Promise<PurchaseDeliveryResult> {
  const { trigger, entitlementId, marketId, locale, voucherCode, voucherPageUrl } =
    context
  const templateKey =
    kind === "buyer"
      ? NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION
      : NOTIFICATION_TEMPLATE_KEYS.VOUCHER_HANDOFF_LINK
  const tag =
    kind === "buyer"
      ? "[voucher-purchase-delivery]"
      : "[voucher-purchase-delivery/handoff]"
  // Handoff przyjmuje WĘŻSZE wejście (bez pól specyficznych dla potwierdzenia),
  // więc jest przypisywalny do tej sygnatury i ignoruje nadmiarowe pola.
  const buildNotification: (
    input: PurchaseConfirmationIntentInput,
  ) => Record<string, unknown> =
    kind === "buyer"
      ? buildPurchaseConfirmationNotification
      : buildHandoffLinkNotification

  let recipientHash
  try {
    recipientHash = hashRecipientEmail(recipientEmail)
  } catch (error) {
    deps.logger?.warn?.(
      `${tag} pominięto: nie udało się wyznaczyć recipient_hash`,
      {
        entitlement_id: entitlementId,
        market_id: marketId,
        error_code:
          error instanceof RecipientHashError
            ? error.error_code
            : "VOUCHER_DELIVERY_RECIPIENT_HASH_INVALID",
      },
    )
    return result("skipped_missing_recipient", trigger, null, marketId, locale)
  }

  let reservation
  try {
    reservation = await deps.ledger.reserveDispatch({
      entitlement_id: entitlementId,
      template_key: templateKey,
      recipient_hash: recipientHash,
      market_id: marketId,
      flow_id: VOUCHER_PURCHASE_DELIVERY_FLOW_ID,
      locale,
    })
  } catch (error) {
    // Ledger niedostępny → NIE wysyłamy. Wysyłka bez rezerwacji łamie
    // idempotencję (NFR3) w najgorszym możliwym momencie: przy retry.
    const errorCode = readErrorCode(error, "VOUCHER_DELIVERY_LEDGER_UNAVAILABLE")
    deps.logger?.error?.(
      `${tag} rezerwacja w ledgerze nieudana — wysyłka wstrzymana`,
      { entitlement_id: entitlementId, market_id: marketId, error_code: errorCode },
    )
    return {
      outcome: "failed",
      entitlement_id: entitlementId,
      dispatch_id: null,
      market_id: marketId,
      locale,
      error_code: errorCode,
      handoff: null,
    }
  }

  if (reservation.outcome === "blocked") {
    // `sent`/`delivered` blokują BEZWARUNKOWO (AC5) — to jest miejsce, w którym
    // ACTIVE-po-ISSUED przestaje generować drugi mail.
    deps.logger?.info?.(`${tag} pominięto: wysyłka już zamknięta dla tego klucza`, {
      entitlement_id: entitlementId,
      market_id: marketId,
      to_state: trigger.to_state,
      dispatch_status: reservation.status,
    })
    return {
      outcome: "skipped_already_sent",
      entitlement_id: entitlementId,
      dispatch_id: reservation.dispatch_id,
      market_id: marketId,
      locale,
      error_code: null,
      handoff: null,
    }
  }

  if (reservation.outcome === "in_flight") {
    // R-2.3-L9: rezerwacja starsza niż próg to najpewniej wiersz PORZUCONY
    // (crash między INSERT-em a domknięciem), a nie wysyłka w locie. Bez sweepa
    // 2.5 nikt jej nie dogoni, więc utrata maila nie może być `info`.
    const stale = isStaleQueued(reservation.queued_at, deps.now?.() ?? new Date())
    const meta = {
      entitlement_id: entitlementId,
      market_id: marketId,
      to_state: trigger.to_state,
      dispatch_status: reservation.status,
      queued_at: reservation.queued_at,
      stale_queued: stale,
    }

    if (stale) {
      deps.logger?.warn?.(
        `${tag} pominięto: rezerwacja \`queued\` starsza niż próg — ` +
          "prawdopodobnie porzucona po awarii; dogonienie należy do sweepa (Story 2.5)",
        meta,
      )
    } else {
      deps.logger?.info?.(
        `${tag} pominięto: rezerwację trzyma inny konsument (queued)`,
        meta,
      )
    }
    return {
      outcome: "skipped_in_flight",
      entitlement_id: entitlementId,
      dispatch_id: reservation.dispatch_id,
      market_id: marketId,
      locale,
      error_code: null,
      handoff: null,
    }
  }

  const dispatchId = reservation.dispatch_id
  if (!dispatchId) {
    // Rezerwacja bez identyfikatora jest niedomykalna (nie da się przejść
    // queued→sent), więc traktujemy to jak awarię, nie jak sukces.
    deps.logger?.error?.(`${tag} rezerwacja bez dispatch_id — wysyłka wstrzymana`, {
      entitlement_id: entitlementId,
      market_id: marketId,
    })
    return {
      outcome: "failed",
      entitlement_id: entitlementId,
      dispatch_id: null,
      market_id: marketId,
      locale,
      error_code: "VOUCHER_DELIVERY_RESERVATION_INCOMPLETE",
      handoff: null,
    }
  }

  const provider = deps.provider ?? "brevo"

  try {
    // INFO#10 (code-review 2.4): `buildNotification` żyje W `try`, mimo że
    // dziś nie rzuca. Docstringi `runGiftHandoff`/handlera deklarują „NIGDY
    // nie rzuca: każdy błąd staje się wynikiem + logiem" — builder POZA `try`
    // złamałby ten kontrakt w chwili, gdy ktoś doda w nim walidację (np.
    // asercję na `claim_url`): wiersz `queued` zostałby bez domknięcia, a
    // wyjątek wyszedłby z subscribera. Koszt przesunięcia: zero.
    const notification = buildNotification({
      ...context.body,
      recipient_email: recipientEmail,
      recipient_hash: recipientHash,
      entitlement_id: entitlementId,
      voucher_code: voucherCode,
      market_id: marketId,
      locale,
      voucher_page_url: voucherPageUrl,
      dispatch_id: dispatchId,
    })
    const dispatchResult = await deps.dispatcher.dispatch(notification)
    const providerMessageId = extractNotificationId(dispatchResult)

    const transitioned = await deps.ledger.markSent({
      dispatch_id: dispatchId,
      provider,
      provider_message_id: providerMessageId,
    })

    if (!transitioned) {
      // Wiersz nie był już w `queued` — wysyłka poszła, ale stan zmienił ktoś
      // inny. Logujemy głośno: to jedyny sygnał rozjazdu single-writera.
      deps.logger?.warn?.(
        `${tag} mail wysłany, ale tranzycja queued→sent nie zaskoczyła ` +
          "(wiersz zmieniony współbieżnie)",
        { entitlement_id: entitlementId, market_id: marketId, dispatch_id: dispatchId },
      )
    }

    deps.logger?.info?.(`${tag} mail wysłany`, {
      entitlement_id: entitlementId,
      market_id: marketId,
      locale,
      dispatch_id: dispatchId,
      to_state: trigger.to_state,
      attempt_count: reservation.attempt_count,
      // Świadomie identyfikator providera, NIGDY adres (D-70).
      provider_message_id: providerMessageId,
    })

    return {
      outcome: "sent",
      entitlement_id: entitlementId,
      dispatch_id: dispatchId,
      market_id: marketId,
      locale,
      error_code: null,
      handoff: null,
    }
  } catch (error) {
    // Do ledgera i logu idzie KOD błędu oraz ZREDAGOWANA odpowiedź providera
    // (kod HTTP + komunikat po `sanitizeProviderDetail`) — nigdy surowa treść
    // odpowiedzi, która może nieść adres, fragment maila albo sekret.
    //
    // Przed tą zmianą zostawał sam `error_code`, i to zwykle GENERYCZNY: kod
    // podany przez Brevo (`unauthorized`) nie przechodził przez marker
    // `[gp_error_code=…]`, bo marker przyjmuje tylko `[A-Z0-9_]+`. Efekt na
    // żywym zakupie 2026-08-01: dwa wiersze `failed` z
    // `VOUCHER_DELIVERY_DISPATCH_FAILED` i zero informacji, że to autoryzacja
    // IP po stronie konta Brevo, a nie defekt kodu.
    const errorCode = readErrorCode(error, "VOUCHER_DELIVERY_DISPATCH_FAILED")
    const providerResponse = readProviderResponse(error)

    try {
      await deps.ledger.markFailed({
        dispatch_id: dispatchId,
        error_code: errorCode,
        provider,
        provider_status_code: providerResponse.status_code,
        provider_message: providerResponse.message,
      })
    } catch (ledgerError) {
      deps.logger?.error?.(`${tag} nie udało się zapisać stanu failed w ledgerze`, {
        entitlement_id: entitlementId,
        market_id: marketId,
        dispatch_id: dispatchId,
        error_class: errorClass(ledgerError),
      })
    }

    deps.logger?.warn?.(`${tag} wysyłka nieudana`, {
      entitlement_id: entitlementId,
      market_id: marketId,
      locale,
      dispatch_id: dispatchId,
      error_code: errorCode,
      // Zredagowane — te same wartości, które idą do ledgera. Log operatora
      // i ledger MUSZĄ mówić to samo, inaczej triage zaczyna się od pytania,
      // któremu źródłu wierzyć.
      provider_status_code: providerResponse.status_code,
      provider_message: providerResponse.message,
    })

    return {
      outcome: "failed",
      entitlement_id: entitlementId,
      dispatch_id: dispatchId,
      market_id: marketId,
      locale,
      error_code: errorCode,
      handoff: null,
    }
  }
}

export default async function voucherPurchaseDeliverySubscriber({
  event,
  container,
}: SubscriberArgs<unknown>) {
  const logger = resolveLogger(container)

  let deps: PurchaseDeliveryDeps
  try {
    const sql = container.resolve(
      ContainerRegistrationKeys.PG_CONNECTION,
    ) as DispatchLedgerSql & MarketLocalesSql
    const notificationModule = container.resolve(Modules.NOTIFICATION) as {
      createNotifications?: (data: unknown, ...rest: unknown[]) => Promise<unknown>
      send?: (data: unknown, ...rest: unknown[]) => Promise<unknown>
    }

    deps = {
      sourceReader: container.resolve(
        VOUCHER_MODULE,
      ) as PurchaseDeliverySourceReader,
      ledger: new PgDispatchLedger(sql),
      dispatcher: {
        async dispatch(payload) {
          return typeof notificationModule.createNotifications === "function"
            ? notificationModule.createNotifications(payload)
            : notificationModule.send?.(payload)
        },
      },
      marketLocales: createMarketLocalesReader(sql, logger),
      logger,
    }
  } catch (error) {
    // Brak zależności w kontenerze (np. moduł Notification niezarejestrowany)
    // nie może wywrócić konsumpcji eventu — inwariant AD-6.
    logger.error?.(
      "[voucher-purchase-delivery] nie udało się zbudować zależności — konsumpcja pominięta",
      error,
    )
    return
  }

  await handleVoucherPurchaseDelivery(event.data, deps)
}

export const config: SubscriberConfig = {
  event: ENTITLEMENT_STATE_CHANGED_EVENT,
}

/**
 * Story 5.7 fix-round (review, „Czego dowody NIE pokrywają" pkt 5) — WIERSZ
 * OGRANICZAJĄCY dla awarii konfiguracji wykrytej PRZED wysyłką.
 *
 * ── Kształt N-1, który to zamyka ────────────────────────────────────────────
 * Ścieżki `…_STOREFRONT_URL_*`, `…_MARKET_LOCALES_UNAVAILABLE` i
 * `…_MARKET_RUNTIME_CONFIG_*` kończyły się `failed` BEZ wiersza ledgera. Sweep
 * 2.5 klasyfikuje taki entitlement jako „brak wiersza" (kształt 1) — a ten
 * kształt nie ma licznika prób ani ścieżki do `dead_lettered`. Efekt: przy
 * niepoprawionej konfiguracji sweep ponawia tę samą robotę co 15 minut w
 * NIESKOŃCZONOŚĆ, dokładnie ta klasa defektu, którą fala naprawiała jako N-1
 * (odparkowanie co 15 min). Zielony test jednego przebiegu tego nie widzi.
 *
 * ── Dlaczego wiersz `failed`, a nie licznik obok ────────────────────────────
 * Licznik na tej ścieżce musiałby żyć w NOWYM magazynie stanu (subscriber jest
 * bezstanowy, a sweep nie pamięta poprzedniego przebiegu) — czyli druga,
 * rozjeżdżalna definicja „ile razy próbowaliśmy". Ledger tę semantykę już ma:
 * `attempt_count`, próg `SWEEP_MAX_ATTEMPT_COUNT`, parkowanie z wykluczeniem ze
 * skanu i licznikiem operatorskim, oraz JEDNO odwracalne odparkowanie po
 * naprawie konfiguracji (`SWEEP_MAX_CONFIGURATION_RECOVERIES`). Zapisujemy więc
 * to, co się realnie stało, w jedynym miejscu, które już to liczy.
 *
 * Wiersz kończy jako `failed` z kodem konfiguracji — NIE jako `queued`. Zakaz
 * „sierocego `queued` po błędzie konfiguracji" z 5.7 zostaje utrzymany: przez
 * `queued` przechodzimy wyłącznie tranzytem, w tej samej funkcji, bez wysyłki.
 *
 * Zapisujemy WYŁĄCZNIE wiersz `voucher_purchase_confirmation`: to jedyny klucz
 * w `SWEEP_EXPECTED_TEMPLATE_KEYS`, więc to on i tylko on decyduje, czy sweep
 * widzi „brak wiersza". Handoff ma własny wiersz zakładany dopiero przy realnej
 * próbie wysyłki i dokładanie mu tu wiersza `failed` nie zmieniłoby żadnej
 * granicy, a rozmnażałoby stany.
 *
 * NIGDY nie rzuca: awaria ledgera na tej ścieżce nie może zamienić błędu
 * konfiguracji w wyjątek wychodzący z subscribera (inwariant AD-6).
 */
async function recordPreflightConfigurationFailure(
  input: {
    entitlementId: string
    marketId: string
    locale: string
    errorCode: string
    recipientEmail: string | null
  },
  deps: PurchaseDeliveryDeps,
): Promise<string | null> {
  const tag = "[voucher-purchase-delivery]"
  if (!input.recipientEmail) {
    // Bez adresu kupującej nie ma tożsamości wiersza (`recipient_hash` jest
    // częścią klucza). Taki entitlement i tak nie jest domykalny przez automat
    // — sweep liczy go jako `unresolvable`, a nie ponawia w nieskończoność.
    return null
  }

  let recipientHash
  try {
    recipientHash = hashRecipientEmail(input.recipientEmail)
  } catch {
    return null
  }

  try {
    const reservation = await deps.ledger.reserveDispatch({
      entitlement_id: input.entitlementId,
      template_key: NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION,
      recipient_hash: recipientHash,
      market_id: input.marketId,
      flow_id: VOUCHER_PURCHASE_DELIVERY_FLOW_ID,
      locale: input.locale,
    })

    // `blocked` (mail już poszedł / `dead_lettered`) i `in_flight` (rezerwację
    // trzyma ktoś inny) NIE są nasze do domknięcia — nadpisanie ich na `failed`
    // złamałoby single-writera i mogłoby wskrzesić wysyłkę już zamkniętą.
    if (
      reservation.outcome !== "reserved" &&
      reservation.outcome !== "retry_reserved"
    ) {
      return reservation.dispatch_id
    }

    const dispatchId = reservation.dispatch_id
    if (!dispatchId) {
      return null
    }

    await deps.ledger.markFailed({
      dispatch_id: dispatchId,
      error_code: input.errorCode,
    })
    return dispatchId
  } catch (error) {
    deps.logger?.warn?.(
      `${tag} nie udało się zapisać wiersza ledgera dla awarii konfiguracji — ` +
        "dosyłka pozostaje nieograniczona do czasu naprawy konfiguracji",
      {
        entitlement_id: input.entitlementId,
        market_id: input.marketId,
        error_code: input.errorCode,
        error_class: errorClass(error),
      },
    )
    return null
  }
}

function result(
  outcome: PurchaseDeliveryOutcome,
  trigger: PurchaseDeliveryTrigger,
  dispatchId: string | null,
  marketId: string | null,
  locale: string | null,
): PurchaseDeliveryResult {
  return {
    outcome,
    entitlement_id: trigger.entitlement_id,
    dispatch_id: dispatchId,
    market_id: marketId ?? trigger.market_id,
    locale,
    error_code: null,
    handoff: null,
  }
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error
}

/**
 * Wyciąga KOD błędu (nigdy `message` providera — może zawierać adres albo
 * fragment treści).
 *
 * Kolejność źródeł jest podyktowana tym, co REALNIE przeżywa drogę do
 * subscribera (R-2.3-M3):
 *  1. `error_code` — obiekty `@gp/messaging` rzucone wprost (seam testowy).
 *  2. `code` — `MedusaError` z wrappera brevo, gdy nikt go po drodze nie
 *     przepakował.
 *  3. **marker w `message`** — ścieżka PRODUKCYJNA: moduł Notification Medusy
 *     przepakowuje wyjątek w `MedusaError` bez `code`, a `promiseAll
 *     ({ aggregateErrors: true })` opakowuje to w zwykły `Error`, więc pola 1–2
 *     nie istnieją. Czytamy WYŁĄCZNIE zawartość markera `[gp_error_code=…]`
 *     (`[A-Z0-9_]+`), nigdy reszty komunikatu — dzięki temu do ledgera i do logu
 *     nie może wyciec adres ani fragment treści maila (D-70).
 */
function readErrorCode(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback
  const record = error as Record<string, unknown>
  for (const key of ["error_code", "code"] as const) {
    const candidate = record[key]
    if (typeof candidate === "string" && /^[A-Z0-9_]+$/.test(candidate.trim())) {
      return candidate.trim()
    }
  }
  // Medusa 2.14.2 keeps the provider marker in the outer Error.message;
  // aggregateErrors does not create a nested cause/errors carrier here.
  return extractErrorCodeMarker(record.message) ?? fallback
}

/**
 * Odczytuje odpowiedź providera z (dowolnie opakowanego) błędu wysyłki.
 *
 * Dwa źródła, w tej kolejności:
 *   1. POLA błędu (`status_code` / `provider_detail`) — dostępne tylko wtedy,
 *      gdy wyjątek NIE przeszedł przez moduł Notification Medusy (testy, ścieżka
 *      bezpośrednia). Wtedy są najdokładniejsze.
 *   2. MARKERY w `message` (`[gp_provider_status=…]`, `[gp_provider_detail=…]`)
 *      — jedyny nośnik, który przeżywa `MedusaError` + `promiseAll(
 *      { aggregateErrors: true })`. To ścieżka PRODUKCYJNA.
 *
 * Wynik przechodzi jeszcze raz przez `sanitizeProviderDetail`: konsument nie
 * zakłada, że ktoś wyżej zredagował poprawnie. Redakcja jest idempotentna, więc
 * powtórzenie niczego nie psuje, a zamyka drogę treści, która weszła bokiem.
 */
function readProviderResponse(error: unknown): {
  status_code: number | null
  message: string | null
} {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {}

  const directStatus = record.status_code
  const statusCode =
    typeof directStatus === "number" && Number.isInteger(directStatus)
      ? directStatus
      : extractProviderStatusMarker(record.message)

  const directDetail =
    typeof record.provider_detail === "string" ? record.provider_detail : null
  const message =
    sanitizeProviderDetail(directDetail) ??
    extractProviderDetailMarker(record.message)

  return { status_code: statusCode ?? null, message }
}

/** `queued_at` starsze niż próg = rezerwacja porzucona (R-2.3-L9). */
function isStaleQueued(queuedAt: string | null, now: Date): boolean {
  if (!queuedAt) return false
  const queuedMs = Date.parse(queuedAt)
  if (Number.isNaN(queuedMs)) return false
  return now.getTime() - queuedMs > STALE_QUEUED_THRESHOLD_MS
}

/**
 * Identyfikator korelacyjny PROVIDERA (R-2.3-M4).
 *
 * `createNotifications` zwraca encje `Notification` Medusy: `id` to `noti_<ulid>`
 * GENEROWANY PRZEZ MEDUSĘ, a identyfikator zwrócony przez providera ląduje
 * w `external_id` (`notification-module-service`: `entry.data.external_id = res.id`).
 * ADR-162 definiuje `provider_message_id` jako „nieprzezroczysty identyfikator
 * korelacyjny **providera**", więc `external_id` ma PIERWSZEŃSTWO — zapis `id`
 * Medusy zrywał jedyną ścieżkę korelacji wiersza ledgera z wysyłką po stronie
 * Brevo (reklamacje „nie dostałam maila", sweep 2.5).
 *
 * `id` zostaje jako fallback dla seamów/atrapy, które zwracają wprost wynik
 * providera (`{ id: dispatch.provider_message_id ?? dispatch.dispatch_id }`).
 *
 * Uwaga: dla klucza już zdedupowanego przez Medusę (`status = SUCCESS`)
 * `createdNotifications` jest PUSTE — wtedy `provider_message_id` będzie `null`.
 * To poprawne: mail poszedł wcześniej, a korelacja żyje przy tamtym wierszu.
 */
function extractNotificationId(value: unknown): string | null {
  if (!value) return null

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractNotificationId(item)
      if (nested) return nested
    }
    return null
  }

  if (typeof value !== "object") return null

  const record = value as Record<string, unknown>
  if (typeof record.external_id === "string" && record.external_id.length > 0) {
    return record.external_id
  }
  if (typeof record.id === "string" && record.id.length > 0) {
    return record.id
  }

  for (const key of [
    "createdNotifications",
    "data",
    "notification",
    "notifications",
    "result",
    "results",
  ] as const) {
    const nested = extractNotificationId(record[key])
    if (nested) return nested
  }

  return null
}

function resolveLogger(
  container: SubscriberArgs<unknown>["container"],
): LoggerLike {
  try {
    return (container.resolve as unknown as (key: string) => LoggerLike)("logger")
  } catch {
    return console
  }
}
