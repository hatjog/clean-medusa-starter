/**
 * Klasyfikacja zdarzen dostawy — wielodzielna, rozlaczna, fail-closed.
 *
 * Story v1.15.0/4.3 (FR-9d, AD-19, AD-23, SM-3), decyzja: ADR-192.
 *
 * DWA SLOWNIKI, DWIE DZIEDZINY (AC3). Dostawca (Brevo) uzywa innych nazw przy
 * REJESTRACJI webhooka (`events[]` w API rejestracji: `hardBounce`, `softBounce`,
 * `invalid`, …) niz w PAYLOADZIE zdarzenia (`hard_bounce`, `soft_bounce`,
 * `invalid_email`, …). To nie sa warianty zapisu tej samej nazwy — to dwie rozne
 * dziedziny, ktore przypadkiem czesciowo sie pokrywaja. Sklejenie ich w jeden
 * zbior nazw daje ciche akceptowanie nazwy z niewlasciwej dziedziny.
 * Kanonicznym zapisem obu dziedzin jest kontrakt
 * `specs/contracts/notifications/delivery-event-classification.yaml`; parzystosc
 * zbiorow nazw kontrakt<->kod egzekwuje bramka
 * `validate_delivery_event_classification_parity` z `_grow/gate-registry.yaml`.
 *
 * AD-19 — wartosc spoza dziedziny jest BLEDEM, nie wartoscia domyslna. W tym
 * module NIE MA zadnej galezi `default` nadajacej klase: mapowania sa totalnymi
 * rekordami po wyliczonej dziedzinie, a kazdy `switch` domyka `assertNever`.
 * Nazwa nierozpoznana konczy sie rzuceniem `UnknownDeliveryEventError` i
 * przyrostem licznika — nigdy odwzorowaniem na klase znana.
 */

import type { NotificationDeliveryEventType } from "@gp/messaging"
import { NOTIFICATION_DELIVERY_EVENT_TYPES } from "@gp/messaging"

/** Kod bledu w logu i w kopercie audytowej dla nazwy spoza dziedziny (AD-19). */
export const UNRECOGNIZED_DELIVERY_EVENT_CODE = "DELIVERY_EVENT_UNRECOGNIZED"

/**
 * Licznik odmow. Odbiorca: operator przez log strukturalny subscribera oraz
 * `getUnrecognizedDeliveryEventMetrics()` — zdarzenie odrzucone po cichu jest
 * tym samym defektem co ciche `return null`, tylko pod inna nazwa (AC2).
 */
export const UNRECOGNIZED_DELIVERY_EVENT_METRIC =
  "notification_delivery_event_unrecognized_total"

/**
 * Ograniczenia licznika odmow. Klucz niesie SUROWA nazwe podana przez dostawce,
 * wiec bez sufitu strumien nazw nieznanych rosnie w pamieci procesu bez konca
 * (kazda nowa nazwa = nowy wpis, proces zyje tygodniami). Nadmiar nie jest
 * gubiony: wpada do jawnego kubla `UNRECOGNIZED_OVERFLOW_KEY`, wiec suma
 * pozostaje prawdziwa, a operator widzi, ze kardynalnosc zostala obcieta.
 */
const UNRECOGNIZED_RAW_VALUE_MAX_LENGTH = 64
const UNRECOGNIZED_DISTINCT_MAX = 256
export const UNRECOGNIZED_OVERFLOW_RAW_VALUE = "__overflow__"

const unrecognizedCounters = new Map<string, number>()

export class UnknownDeliveryEventError extends Error {
  readonly code = UNRECOGNIZED_DELIVERY_EVENT_CODE
  readonly dictionary: DeliveryEventDictionary
  readonly rawValue: string

  constructor(dictionary: DeliveryEventDictionary, rawValue: string) {
    super(
      `${UNRECOGNIZED_DELIVERY_EVENT_CODE}: nazwa "${rawValue}" jest spoza dziedziny "${dictionary}"`,
    )
    this.name = "UnknownDeliveryEventError"
    this.dictionary = dictionary
    this.rawValue = rawValue
  }
}

/** Ktora z dwoch dziedzin nazw jest zrodlem wartosci. */
export type DeliveryEventDictionary = "registration_api" | "event_payload"

/**
 * Slownik 1 — nazwy przyjmowane w API REJESTRACJI webhooka Brevo (`events[]`).
 * Do v1.15.0 ten slownik nie istnial w repo w ogole; byl wiedza milczaca.
 * Mapowanie jest CALKOWITE — kazda nazwa ma klase albo jawny wpis `null`
 * ("nieobslugiwane, reakcja: odmowa"), nigdy luke.
 */
export const REGISTRATION_API_NAMES: Readonly<
  Record<string, NotificationDeliveryEventType | null>
> = Object.freeze({
  delivered: "delivered",
  opened: "opened",
  click: "clicked",
  unsubscribed: "unsubscribed",
  hardBounce: "bounced_permanent",
  softBounce: "bounced_transient",
  blocked: "blocked",
  invalid: "invalid_address",
  deferred: "deferred",
  spam: "complaint",
  error: "failed",
  // Nieobslugiwane jawnie: nazwy rejestracyjne, ktore nie niosa rozroznienia
  // wymaganego przez FR-9d albo nie dotycza stanu dostawy.
  request: null,
  listAddition: null,
  contactUpdated: null,
  contactDeleted: null,
})

/**
 * Slownik 2 — nazwy pojawiajace sie w PAYLOADZIE zdarzenia.
 *
 * `bounced` jest tu wpisem JAWNIE NIEOBSLUGIWANYM (`null`), a nie klasa. Do
 * v1.15.0 byla to wartosc docelowa zwiniecia pieciu odpowiedzi; sama w sobie jest
 * niejednoznaczna (nie da sie z niej odczytac, czy odbicie jest trwale, chwilowe,
 * czy w ogole jest odbiciem), wiec zgodnie z AD-19 konczy sie odmowa, a nie
 * odwzorowaniem na "jakies" odbicie.
 */
export const EVENT_PAYLOAD_NAMES: Readonly<
  Record<string, NotificationDeliveryEventType | null>
> = Object.freeze({
  delivered: "delivered",
  opened: "opened",
  unique_opened: "opened",
  click: "clicked",
  clicked: "clicked",
  unsubscribed: "unsubscribed",
  hard_bounce: "bounced_permanent",
  soft_bounce: "bounced_transient",
  blocked: "blocked",
  invalid_email: "invalid_address",
  deferred: "deferred",
  spam: "complaint",
  complaint: "complaint",
  error: "failed",
  failed: "failed",
  // Nieobslugiwane jawnie — reakcja: odmowa.
  bounced: null,
  request: null,
  proxy_open: null,
  listadd: null,
})

function dictionaryFor(
  dictionary: DeliveryEventDictionary,
): Readonly<Record<string, NotificationDeliveryEventType | null>> {
  switch (dictionary) {
    case "registration_api":
      return REGISTRATION_API_NAMES
    case "event_payload":
      return EVENT_PAYLOAD_NAMES
    default:
      return assertNever(dictionary, "dictionaryFor")
  }
}

/**
 * Klasyfikuje nazwe z JEDNEJ, wskazanej dziedziny.
 *
 * Rzuca `UnknownDeliveryEventError` dla nazwy nieznanej ORAZ dla nazwy jawnie
 * nieobslugiwanej. Nie zwraca `null`, nie zwraca klasy zastepczej — wywolujacy
 * nie ma jak przypadkiem potraktowac odmowy jako wyniku (AD-19).
 *
 * UWAGA: dopasowanie jest DOSLOWNE (case-sensitive, bez trymowania semantyki
 * poza obcieciem bialych znakow). `"HARD_BOUNCE"` w zlej wielkosci liter to
 * nazwa spoza dziedziny, a nie `hard_bounce` — dostawca nie zmienia wielkosci
 * liter, wiec taka wartosc oznacza inne zrodlo albo uszkodzony payload.
 */
export function classifyDeliveryEventName(
  dictionary: DeliveryEventDictionary,
  rawValue: string | undefined,
): NotificationDeliveryEventType {
  const value = typeof rawValue === "string" ? rawValue.trim() : ""
  const table = dictionaryFor(dictionary)
  const mapped = Object.prototype.hasOwnProperty.call(table, value)
    ? table[value]
    : undefined

  if (mapped === undefined || mapped === null) {
    recordUnrecognizedDeliveryEvent(dictionary, value)
    throw new UnknownDeliveryEventError(dictionary, value)
  }

  return mapped
}

export function recordUnrecognizedDeliveryEvent(
  dictionary: DeliveryEventDictionary,
  rawValue: string,
): void {
  const truncated =
    rawValue.length > UNRECOGNIZED_RAW_VALUE_MAX_LENGTH
      ? rawValue.slice(0, UNRECOGNIZED_RAW_VALUE_MAX_LENGTH)
      : rawValue
  const key = `${dictionary}:${truncated}`

  if (
    !unrecognizedCounters.has(key) &&
    unrecognizedCounters.size >= UNRECOGNIZED_DISTINCT_MAX
  ) {
    // Sufit kardynalnosci osiagniety — liczymy dalej, ale w jednym kuble.
    // Suma zostaje prawdziwa; gubienie zdarzen byloby cichym odrzuceniem.
    const overflowKey = `${dictionary}:${UNRECOGNIZED_OVERFLOW_RAW_VALUE}`
    unrecognizedCounters.set(
      overflowKey,
      (unrecognizedCounters.get(overflowKey) ?? 0) + 1,
    )
    return
  }

  unrecognizedCounters.set(key, (unrecognizedCounters.get(key) ?? 0) + 1)
}

export function getUnrecognizedDeliveryEventMetrics(): Array<{
  metric: string
  dictionary: string
  raw_value: string
  count: number
}> {
  return [...unrecognizedCounters.entries()].map(([key, count]) => {
    const separator = key.indexOf(":")
    return {
      metric: UNRECOGNIZED_DELIVERY_EVENT_METRIC,
      dictionary: key.slice(0, separator),
      raw_value: key.slice(separator + 1),
      count,
    }
  })
}

export function getUnrecognizedDeliveryEventTotal(): number {
  let total = 0
  for (const count of unrecognizedCounters.values()) {
    total += count
  }
  return total
}

export function _resetUnrecognizedDeliveryEventMetrics(): void {
  unrecognizedCounters.clear()
}

/* -------------------------------------------------------------------------- */
/* Reakcja per klasa (AC4)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Obserwowalny skutek klasyfikacji. KAZDE dwie klasy musza dawac ROZNA krotke —
 * to jest kontrola na "wielodzielnosc w nazwie, jedna reakcja w praktyce".
 * Sprawdzane testem, nie zalozeniem.
 */
export type DeliveryEventReaction = {
  /** Stan koncowy wiersza dostawy — dalsze ponowienia sa odrzucane. */
  terminal: boolean
  /** Czy zdarzenie eskaluje do operatora. */
  escalate: boolean
  /** Czy przysluguje ponowienie (4.4 rozstrzyga jednostke, 4.3 samo prawo). */
  retryable: boolean
  /** Nazwa polityki backoffu; `null` gdy ponowienie nie przysluguje. */
  retry_policy: "transient_backoff" | "blocked_backoff" | "provider_backoff" | null
  /**
   * Czy zdarzenie konsumuje budzet prob ODBIORCY (granica wobec FR-9g/4.7).
   * `failed` (blad dostawcy) NIE konsumuje — to usterka po stronie dostawcy,
   * nie sygnal o adresie odbiorcy; obciazenie nia budzetu odbiorcy kasowaloby
   * vouchery za awarie cudzej infrastruktury (ADR-192).
   */
  consumes_recipient_attempt: boolean
  /** Czy odbiorca zostaje wyciszony/oznaczony (zgloszenie spamu). */
  suppress_recipient: boolean
  /** Kod bledu — rozlaczny miedzy klasami; `null` gdy zdarzenie nie jest bledem. */
  error_code: string | null
  /** Czy klasa nalezy do rodziny odbic. `deferred` -> false (FR-9d). */
  bounce_family: boolean
}

const REACTIONS: Readonly<
  Record<NotificationDeliveryEventType, DeliveryEventReaction>
> = Object.freeze({
  delivered: {
    terminal: true,
    escalate: false,
    retryable: false,
    retry_policy: null,
    consumes_recipient_attempt: false,
    suppress_recipient: false,
    error_code: null,
    bounce_family: false,
  },
  opened: {
    terminal: false,
    escalate: false,
    retryable: false,
    retry_policy: null,
    consumes_recipient_attempt: false,
    suppress_recipient: false,
    error_code: null,
    bounce_family: false,
  },
  clicked: {
    terminal: false,
    escalate: false,
    retryable: false,
    retry_policy: null,
    consumes_recipient_attempt: false,
    suppress_recipient: false,
    error_code: null,
    bounce_family: false,
  },
  unsubscribed: {
    terminal: true,
    escalate: false,
    retryable: false,
    retry_policy: null,
    consumes_recipient_attempt: false,
    suppress_recipient: true,
    error_code: "UNSUBSCRIBED",
    bounce_family: false,
  },
  // Trwale odbicie -> stan terminalny I eskalacja (FR-9d).
  bounced_permanent: {
    terminal: true,
    escalate: true,
    retryable: false,
    retry_policy: null,
    consumes_recipient_attempt: true,
    suppress_recipient: false,
    error_code: "HARD_BOUNCE",
    bounce_family: true,
  },
  // Chwilowe odbicie -> ponowienie z backoffem, bez stanu terminalnego.
  bounced_transient: {
    terminal: false,
    escalate: false,
    retryable: true,
    retry_policy: "transient_backoff",
    consumes_recipient_attempt: true,
    suppress_recipient: false,
    error_code: "SOFT_BOUNCE",
    bounce_family: true,
  },
  // Zablokowane -> ponowienie z backoffem, ale WLASNA polityka i wlasny kod:
  // blokada listy dostawcy nie ustepuje w tym samym rytmie co przepelniona
  // skrzynka, wiec dzielenie polityki z `bounced_transient` byloby zwinieciem.
  blocked: {
    terminal: false,
    escalate: false,
    retryable: true,
    retry_policy: "blocked_backoff",
    consumes_recipient_attempt: true,
    suppress_recipient: false,
    error_code: "BLOCKED",
    bounce_family: true,
  },
  // Niepoprawny adres -> reakcja wlasna, ROZLACZNA z odbiciem trwalym: konczy
  // dostawe, ale nie eskaluje (to blad danych, nie awaria wymagajaca operatora).
  invalid_address: {
    terminal: true,
    escalate: false,
    retryable: false,
    retry_policy: null,
    consumes_recipient_attempt: true,
    suppress_recipient: false,
    error_code: "INVALID_ADDRESS",
    bounce_family: true,
  },
  // Zgloszenie spamu -> wyciszenie odbiorcy, NIE ponowienie.
  complaint: {
    terminal: true,
    escalate: false,
    retryable: false,
    retry_policy: null,
    consumes_recipient_attempt: false,
    suppress_recipient: true,
    error_code: "SPAM_COMPLAINT",
    bounce_family: false,
  },
  // Blad dostawcy -> ponowienie + eskalacja, ale BEZ obciazania budzetu odbiorcy.
  failed: {
    terminal: false,
    escalate: true,
    retryable: true,
    retry_policy: "provider_backoff",
    consumes_recipient_attempt: false,
    suppress_recipient: false,
    error_code: "PROVIDER_ERROR",
    bounce_family: false,
  },
  // Opoznienie -> ANI stanu terminalnego, ANI eskalacji, ANI zuzycia proby.
  // NIE jest odbiciem i nie dostaje kodu z rodziny `*BOUNCE*` (FR-9d).
  deferred: {
    terminal: false,
    escalate: false,
    retryable: false,
    retry_policy: null,
    consumes_recipient_attempt: false,
    suppress_recipient: false,
    error_code: null,
    bounce_family: false,
  },
})

export function reactionFor(
  eventType: NotificationDeliveryEventType,
): DeliveryEventReaction {
  const reaction = REACTIONS[eventType]
  if (!reaction) {
    return assertNever(eventType as never, "reactionFor")
  }
  return reaction
}

/** Czy klasa nalezy do rodziny odbic — jedyny autorytatywny test rodziny. */
export function isBounceFamily(
  eventType: NotificationDeliveryEventType,
): boolean {
  return reactionFor(eventType).bounce_family
}

/**
 * Numer kolejnej proby nadaje POLITYKA, nie wywolujacy (AD-23).
 *
 * Argumentem jest wylacznie liczba prob juz ZAREJESTROWANYCH po stronie systemu.
 * Zadna wartosc z ladunku zdarzenia (`attempt`, `retry_count`, …) nie jest tu
 * przyjmowana ani czytana — dostawca nie ma wplywu na numeracje prob.
 */
export function nextAttemptNumber(
  eventType: NotificationDeliveryEventType,
  recordedAttempts: number,
): number | null {
  const reaction = reactionFor(eventType)
  if (!reaction.retryable) {
    return null
  }
  const base = Number.isFinite(recordedAttempts) && recordedAttempts > 0
    ? Math.floor(recordedAttempts)
    : 0
  return base + 1
}

/**
 * Sufit backoffu — 24 h.
 *
 * Bez niego `2 ** (attempt - 1)` rosnie bez ograniczen: przy kilkudziesieciu
 * probach `blocked_backoff` przekracza czas zycia systemu, a dalej traci
 * precyzje liczby zmiennoprzecinkowej. „Ponowienie za 10^9 lat" jest w praktyce
 * stanem terminalnym udajacym ponawialny — czyli tym samym zwinieciem, ktore
 * FR-9d kaze usunac, tylko w wymiarze czasu.
 */
export const MAX_BACKOFF_DELAY_MS = 24 * 60 * 60 * 1000

/** Opoznienie backoffu w ms — wylacznie z polityki klasy i numeru proby. */
export function backoffDelayMs(
  eventType: NotificationDeliveryEventType,
  recordedAttempts: number,
): number | null {
  const reaction = reactionFor(eventType)
  const attempt = nextAttemptNumber(eventType, recordedAttempts)
  if (attempt === null || reaction.retry_policy === null) {
    return null
  }

  const base = baseBackoffMs(reaction.retry_policy)
  // Wykladnik obciety osobno: bez tego `2 ** 1024` daje `Infinity`, a `Infinity`
  // przycieta sufitem nadal ukrywa fakt, ze mnozenie sie przepelnilo.
  const exponent = Math.min(attempt - 1, 32)
  return Math.min(base * 2 ** exponent, MAX_BACKOFF_DELAY_MS)
}

function baseBackoffMs(
  policy: NonNullable<DeliveryEventReaction["retry_policy"]>,
): number {
  switch (policy) {
    case "transient_backoff":
      return 60_000
    case "blocked_backoff":
      return 900_000
    case "provider_backoff":
      return 30_000
    default:
      return assertNever(policy, "baseBackoffMs")
  }
}

/**
 * Kod bledu dla klasy. Zastepuje dawny `resolveErrorCode`, ktory konczyl sie
 * `return "BOUNCE"` — catch-allem w przebraniu, w ktory wpadaly `invalid_email`
 * i `blocked`. Kody sa teraz rozlaczne i pochodza z tabeli reakcji.
 */
export function errorCodeFor(
  eventType: NotificationDeliveryEventType,
): string | null {
  return reactionFor(eventType).error_code
}

/** Nazwy klas w kolejnosci dziedziny — nosnik wyczerpalnosci dla bramek i testow. */
export const CLASSIFICATION_DOMAIN = NOTIFICATION_DELIVERY_EVENT_TYPES

function assertNever(value: never, where: string): never {
  throw new Error(`${where}: nieobsluzona wartosc dziedziny: ${String(value)}`)
}
