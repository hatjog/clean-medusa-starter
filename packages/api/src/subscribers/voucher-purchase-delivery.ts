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
import {
  buildClaimUrl,
  buildPurchaseConfirmationNotification,
  resolveStorefrontBaseUrl,
  VOUCHER_PURCHASE_DELIVERY_FLOW_ID,
} from "../modules/voucher-delivery/purchase-confirmation-intent"
import {
  hashRecipientEmail,
  RecipientHashError,
} from "../modules/voucher-delivery/recipient-hash"
import {
  extractErrorCodeMarker,
  NOTIFICATION_TEMPLATE_KEYS,
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
  claimUrl: string
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
      dispatch_id: null,
      market_id: marketId,
      locale: null,
      error_code: MARKET_LOCALES_UNAVAILABLE_ERROR_CODE,
      handoff: null,
    }
  }

  // Link claim liczymy PRZED rezerwacją: brak base URL to błąd konfiguracji,
  // nie nieudana wysyłka — nie chcemy zostawiać po nim wiersza `queued`.
  let claimUrl: string
  try {
    claimUrl = buildClaimUrl({
      baseUrl: resolveStorefrontBaseUrl({ marketId, env: deps.env }),
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
      dispatch_id: null,
      market_id: marketId,
      locale,
      error_code: errorCode,
      handoff: null,
    }
  }

  // Wszystko poniżej jest WSPÓLNE dla obu wysyłek: ten sam rynek, to samo
  // locale (`purchase_locale` — locale KUPUJĄCEJ, AD-8) i ten sam link claim.
  const context: DispatchAttemptContext = {
    trigger,
    entitlementId,
    marketId,
    locale,
    voucherCode,
    claimUrl,
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
  const handoff = await runGiftHandoff(source, context, deps)

  return { ...buyerResult, handoff }
}

/**
 * Story 2.4 (AC1/AC2) — decyzja o handoffie + wysyłka tą samą sekwencją.
 *
 * NIGDY nie rzuca i NIGDY nie loguje adresu: powodem odmowy jest zawsze enum
 * `GiftHandoffSkipReason`. Rezerwacja w ledgerze powstaje DOPIERO po przejściu
 * predykatu — dzięki temu wariant „przekażę osobiście" i zastane `scheduled`
 * nie zostawiają sierocego wiersza `queued`.
 */
async function runGiftHandoff(
  source: PurchaseDeliverySource,
  context: DispatchAttemptContext,
  deps: PurchaseDeliveryDeps,
): Promise<GiftHandoffResult> {
  const decision = evaluateGiftHandoff(source)

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
    skip_reason: null,
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
  const { trigger, entitlementId, marketId, locale, voucherCode, claimUrl } =
    context
  const templateKey =
    kind === "buyer"
      ? NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION
      : NOTIFICATION_TEMPLATE_KEYS.VOUCHER_HANDOFF_LINK
  const tag =
    kind === "buyer"
      ? "[voucher-purchase-delivery]"
      : "[voucher-purchase-delivery/handoff]"
  const buildNotification =
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
  const notification = buildNotification({
    recipient_email: recipientEmail,
    recipient_hash: recipientHash,
    entitlement_id: entitlementId,
    voucher_code: voucherCode,
    market_id: marketId,
    locale,
    claim_url: claimUrl,
    dispatch_id: dispatchId,
  })

  try {
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
    // Do ledgera i logu idzie KOD błędu — nigdy treść odpowiedzi providera
    // (może nieść adres albo fragment treści maila).
    const errorCode = readErrorCode(error, "VOUCHER_DELIVERY_DISPATCH_FAILED")

    try {
      await deps.ledger.markFailed({
        dispatch_id: dispatchId,
        error_code: errorCode,
        provider,
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
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>
    for (const key of ["error_code", "code"] as const) {
      const value = record[key]
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim()
      }
    }

    const fromMarker = extractErrorCodeMarker(record.message)
    if (fromMarker) return fromMarker
  }

  if (typeof error === "string") {
    const fromMarker = extractErrorCodeMarker(error)
    if (fromMarker) return fromMarker
  }

  return fallback
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
