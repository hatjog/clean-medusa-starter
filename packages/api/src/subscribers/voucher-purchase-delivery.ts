/**
 * voucher-purchase-delivery.ts — subscriber pierwszej REALNEJ wysyłki produktowej
 * strumienia S3 (Story 2.3; FR-13, NFR3; AD-5 / AD-6 / AD-7).
 *
 * ── Matryca normatywna AD-7 (stan → szablon) ────────────────────────────────
 *   `to_state = ISSUED` → `voucher_purchase_confirmation` → buyer
 *   `to_state = ACTIVE` → **ŻADEN nowy szablon**; konsumowane WYŁĄCZNIE dla
 *                          idempotentnego dogonienia TEGO SAMEGO `template_key`
 *                          (gdy ISSUED przepadł — emit jest best-effort)
 *   każdy inny stan      → **no-op** (nie błąd)
 *
 * Gift/handoff (`voucher_handoff_link`) NIE jest tutaj implementowany — to 2.4,
 * nawet jeśli matryca AD-7 wymienia go w tym samym akapicie.
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
  buildClaimUrl,
  buildPurchaseConfirmationNotification,
  resolveStorefrontBaseUrl,
  VOUCHER_PURCHASE_DELIVERY_FLOW_ID,
} from "../modules/voucher-delivery/purchase-confirmation-intent"
import {
  hashRecipientEmail,
  RecipientHashError,
} from "../modules/voucher-delivery/recipient-hash"
import { NOTIFICATION_TEMPLATE_KEYS } from "@gp/messaging"

/** Ten sam literał, co `ENTITLEMENT_STATE_CHANGED_EVENT_TYPE` z 2.1 (AR-EVENTS). */
export const ENTITLEMENT_STATE_CHANGED_EVENT =
  "gp.entitlements.entitlement_state_changed.v1" as const

/**
 * Stany, dla których subscriber cokolwiek robi (AD-7). ACTIVE nie dodaje
 * szablonu — służy WYŁĄCZNIE dogonieniu tych samych kluczy.
 */
const DELIVERABLE_TO_STATES = new Set(["ISSUED", "ACTIVE"])

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
  | "sent"
  | "failed"

export type PurchaseDeliveryResult = {
  outcome: PurchaseDeliveryOutcome
  entitlement_id: string | null
  dispatch_id: string | null
  market_id: string | null
  locale: string | null
  error_code: string | null
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
  const templateKey = NOTIFICATION_TEMPLATE_KEYS.VOUCHER_PURCHASE_CONFIRMATION

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
    return result("skipped_missing_recipient", trigger, null, marketId, null)
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

  const marketLocaleConfig = await deps.marketLocales.read(marketId)
  const localeResolution = resolveMarketLocale({
    // AC3: locale ZAKUPU z `order.metadata.purchase_locale`; `buyer_locale`
    // (snapshot polityki) jest wtórnym nośnikiem tej samej intencji.
    requested: source.purchase_locale ?? source.buyer_locale ?? null,
    marketId,
    locales: marketLocaleConfig,
    callSite: "voucher-purchase-delivery",
    logger: deps.logger,
  })
  const locale = localeResolution.locale

  let recipientHash
  try {
    recipientHash = hashRecipientEmail(recipientEmail)
  } catch (error) {
    deps.logger?.warn?.(
      "[voucher-purchase-delivery] pominięto: nie udało się wyznaczyć recipient_hash",
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
    }
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
      "[voucher-purchase-delivery] rezerwacja w ledgerze nieudana — wysyłka wstrzymana",
      { entitlement_id: entitlementId, market_id: marketId, error_code: errorCode },
    )
    return {
      outcome: "failed",
      entitlement_id: entitlementId,
      dispatch_id: null,
      market_id: marketId,
      locale,
      error_code: errorCode,
    }
  }

  if (reservation.outcome === "blocked") {
    // `sent`/`delivered` blokują BEZWARUNKOWO (AC5) — to jest miejsce, w którym
    // ACTIVE-po-ISSUED przestaje generować drugi mail.
    deps.logger?.info?.(
      "[voucher-purchase-delivery] pominięto: wysyłka już zamknięta dla tego klucza",
      {
        entitlement_id: entitlementId,
        market_id: marketId,
        to_state: trigger.to_state,
        dispatch_status: reservation.status,
      },
    )
    return {
      outcome: "skipped_already_sent",
      entitlement_id: entitlementId,
      dispatch_id: reservation.dispatch_id,
      market_id: marketId,
      locale,
      error_code: null,
    }
  }

  if (reservation.outcome === "in_flight") {
    deps.logger?.info?.(
      "[voucher-purchase-delivery] pominięto: rezerwację trzyma inny konsument (queued)",
      {
        entitlement_id: entitlementId,
        market_id: marketId,
        to_state: trigger.to_state,
        dispatch_status: reservation.status,
      },
    )
    return {
      outcome: "skipped_in_flight",
      entitlement_id: entitlementId,
      dispatch_id: reservation.dispatch_id,
      market_id: marketId,
      locale,
      error_code: null,
    }
  }

  const dispatchId = reservation.dispatch_id
  if (!dispatchId) {
    // Rezerwacja bez identyfikatora jest niedomykalna (nie da się przejść
    // queued→sent), więc traktujemy to jak awarię, nie jak sukces.
    deps.logger?.error?.(
      "[voucher-purchase-delivery] rezerwacja bez dispatch_id — wysyłka wstrzymana",
      { entitlement_id: entitlementId, market_id: marketId },
    )
    return {
      outcome: "failed",
      entitlement_id: entitlementId,
      dispatch_id: null,
      market_id: marketId,
      locale,
      error_code: "VOUCHER_DELIVERY_RESERVATION_INCOMPLETE",
    }
  }

  const provider = deps.provider ?? "brevo"
  const notification = buildPurchaseConfirmationNotification({
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
        "[voucher-purchase-delivery] mail wysłany, ale tranzycja queued→sent nie zaskoczyła " +
          "(wiersz zmieniony współbieżnie)",
        { entitlement_id: entitlementId, market_id: marketId, dispatch_id: dispatchId },
      )
    }

    deps.logger?.info?.("[voucher-purchase-delivery] mail wysłany", {
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
      deps.logger?.error?.(
        "[voucher-purchase-delivery] nie udało się zapisać stanu failed w ledgerze",
        {
          entitlement_id: entitlementId,
          market_id: marketId,
          dispatch_id: dispatchId,
          error_class: errorClass(ledgerError),
        },
      )
    }

    deps.logger?.warn?.("[voucher-purchase-delivery] wysyłka nieudana", {
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
 * fragment treści). `MedusaError` z wrappera brevo niesie `code`
 * (np. `BREVO_TEMPLATE_NOT_CONFIGURED`), obiekty `@gp/messaging` — `error_code`.
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
  }
  return fallback
}

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
