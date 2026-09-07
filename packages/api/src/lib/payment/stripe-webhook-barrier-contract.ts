/**
 * stripe-webhook-barrier-contract.ts — Story 3.1 (v1.16.0, Epic 3; FR-9, AD-33,
 * AD-47, AD-23; ADR-166, ADR-174, ADR-190).
 *
 * KONTRAKT wspólnej bariery idempotencji dla dwóch tras webhooka Stripe oraz
 * kontrakt „ACK vs jednostki należne". Ten plik NICZEGO nie wpina w runtime:
 * jest czystą definicją (bez I/O), z której korzystają testy Story 3.1 oraz
 * gałąź ponowionej dostawy Path Y: route odczytuje rozliczone jednostki z
 * `event_processed`, ocenia je tym modułem i pozwala na `200 duplicate` tylko
 * przy `PASS`. Inwentaryzacja tras (owner, konsument, stan końcowy) jest w
 * `api/webhooks/stripe/__tests__/stripe-route-inventory.unit.test.ts` i w
 * artefakcie `evidence/3-1/stripe-routes-inventory.md` (super-repo).
 *
 * ── Dwa poziomy klucza (AD-47, ADR-137 DEC-5 po amendmencie ADR-166) ──────
 *
 *  POZIOM 1 — klucz DOSTAWY (transport): `(event_id, provider)`.
 *    `event_id` = Stripe `event.id` (NIE `payment_intent.id`, NIE `session_id`,
 *    NIE alias trasy). `provider` = przestrzeń nazw ścieżki:
 *      - natywna (`POST /hooks/payment/stripe` → `payment.captured`):
 *        literal `'stripe'` w `workflows/payment/stripe-payment-audit.ts`;
 *      - GP Path Y (`POST /webhooks/stripe/payment-intent`):
 *        `STRIPE_PATH_Y_WEBHOOK_PROVIDER` z `stripe-payment-intent-transport.ts`.
 *    Obie ścieżki piszą do TEJ SAMEJ tabeli `webhook_event_processed`, ale w
 *    ROZŁĄCZNYCH przestrzeniach `provider` — kompensacja ścieżki natywnej
 *    (`DELETE … WHERE provider = 'stripe'`) nie może dosięgnąć rezerwacji Path Y
 *    i odwrotnie. „Wspólna bariera" to wspólna TABELA i wspólny KSZTAŁT klucza,
 *    a nie jeden wiersz na obie trasy (patrz inwentaryzacja, fakt F-6).
 *
 *  POZIOM 2 — klucz JEDNOSTKI NALEŻNEJ (biznes): `payment_intent_id:order_id`
 *    (`event_processed.external_id`, ADR-166) — po JEDNEJ jednostce na KAŻDE
 *    zamówienie order-setu zapłaconego jednym PaymentIntentem (ADR-166/ADR-190,
 *    multi-seller ⇒ 1 PI → N zamówień → N jednostek). Korelacja zakupu idzie po
 *    kolumnie `purchase_key = payment_intent_id` (AD-16 / ADR-190), NIE przez
 *    parsowanie `external_id`. Poniżej poziomu 2 jest jeszcze per-entitlement
 *    `entitlement_dedupe_key` (`models/entitlement-dedupe.ts`), który NIE jest
 *    jednostką ACK: brak jednego entitlementu w linii to nadal brak JEDNOSTKI
 *    `payment_intent_id:order_id`, bo jednostka jest atomowa w DB-tx konsumenta.
 *
 * ── Kontrakt ACK (AC3) ──────────────────────────────────────────────────────
 *  `200` wolno odpowiedzieć WYŁĄCZNIE, gdy KAŻDA jednostka należna z poziomu 2
 *  jest rozliczona (`PASS`). Brak choć jednej (`FAIL`) albo niemożność odczytu
 *  stanu (`UNKNOWN`) ⇒ odpowiedź MUSI zachować ponowienie Stripe (nie-2xx).
 *  Gałąź `!reserved` route'u Path Y odczytuje rozliczone jednostki po
 *  `event_processed.purchase_key = payment_intent_id` i musi użyć tego werdyktu
 *  przed odpowiedzią `duplicate`; test
 *  `owed-unit-ack-contract.unit.test.ts` mierzy tę decyzję na realnej ścieżce.
 *
 * Granica: ten moduł NIE zmienia tabel ani kontraktów `specs/contracts`.
 * Zmiana kształtu klucza poziomu 1/2
 * wymaga ADR (ADR-166/ADR-190 są SSOT kształtu).
 */

import { STRIPE_PATH_Y_WEBHOOK_PROVIDER } from "./stripe-payment-intent-transport"
import { buildPaymentIntentOrderExternalId } from "../../workflows/entitlements/live-issue-from-payment-intent"

/**
 * Literal `provider` ścieżki natywnej. Ścieżka natywna wpisuje go do SQL-a
 * jako stałą (`workflows/payment/stripe-payment-audit.ts`, INSERT/DELETE po
 * `provider = 'stripe'`), więc nie ma tam eksportu do zaimportowania — ten
 * eksport JEST tym literałem, a test inwentaryzacji sprawdza, że źródło
 * ścieżki natywnej nadal go używa (kontrola dryfu).
 */
export const STRIPE_NATIVE_WEBHOOK_PROVIDER = "stripe" as const

export { STRIPE_PATH_Y_WEBHOOK_PROVIDER }

/** Nazwa tabeli bariery poziomu 1 (wspólna dla obu tras). */
export const WEBHOOK_DELIVERY_BARRIER_TABLE = "webhook_event_processed" as const

/** Klucz dostawy (poziom 1) — składniki kanoniczne i NIC więcej. */
export type TransportEventKey = {
  event_id: string
  provider: typeof STRIPE_NATIVE_WEBHOOK_PROVIDER | typeof STRIPE_PATH_Y_WEBHOOK_PROVIDER
}

export function buildTransportEventKey(input: {
  stripe_event_id: string
  provider: TransportEventKey["provider"]
}): TransportEventKey {
  const eventId = input.stripe_event_id?.trim()
  if (!eventId) {
    throw new Error("buildTransportEventKey: stripe event.id wymagany (niepusty)")
  }
  if (
    input.provider !== STRIPE_NATIVE_WEBHOOK_PROVIDER &&
    input.provider !== STRIPE_PATH_Y_WEBHOOK_PROVIDER
  ) {
    throw new Error(
      `buildTransportEventKey: provider spoza inwentarza tras: ${String(input.provider)}`
    )
  }
  return { event_id: eventId, provider: input.provider }
}

/**
 * Klucz jednostki należnej (poziom 2) — TEN SAM kształt co `external_id`
 * w `event_processed` (ADR-166). Delegacja do implementacji konsumenta jest
 * celowa: kontrakt i konsument nie mogą się rozjechać po cichu.
 */
export function buildOwedBusinessUnitKey(input: {
  payment_intent_id: string
  order_id: string
}): string {
  if (!input.payment_intent_id?.trim()) {
    throw new Error("buildOwedBusinessUnitKey: payment_intent_id wymagany (niepusty)")
  }
  if (!input.order_id?.trim()) {
    throw new Error("buildOwedBusinessUnitKey: order_id wymagany (niepusty)")
  }
  return buildPaymentIntentOrderExternalId(input.payment_intent_id, input.order_id)
}

/**
 * Zbiór jednostek należnych dla jednej dostawy: po jednej na KAŻDE zamówienie
 * rozwiązane z PaymentIntenta (ADR-166/ADR-190). Deterministycznie posortowany,
 * zdeduplikowany; pusta lista zamówień jest błędem programistycznym — dostawa
 * bez zamówień nie ma czego ACK-ować (route odrzuca ją wcześniej jako
 * `unresolved_link`).
 */
export function buildOwedBusinessUnits(input: {
  payment_intent_id: string
  order_ids: ReadonlyArray<string>
}): string[] {
  if (input.order_ids.length === 0) {
    throw new Error(
      `buildOwedBusinessUnits: brak zamówień dla ${input.payment_intent_id} — nie ma jednostek do ACK`
    )
  }
  const units = new Set(
    input.order_ids.map((order_id) =>
      buildOwedBusinessUnitKey({ payment_intent_id: input.payment_intent_id, order_id })
    )
  )
  return [...units].sort()
}

export type OwedUnitAckVerdict = "PASS" | "FAIL" | "UNKNOWN"

export type OwedUnitAckEvaluation = {
  verdict: OwedUnitAckVerdict
  owed_units: string[]
  settled_units: string[]
  /** Jednostki należne, których NIE ma wśród rozliczonych — powód `FAIL`. */
  missing_units: string[]
  /** Rozliczone, ale nienależne tej dostawie (np. obce zamówienie) — sygnał, nie werdykt. */
  unexpected_units: string[]
}

/**
 * Werdykt ACK dla jednej dostawy.
 *
 *  - `settled_units === null` ⇒ `UNKNOWN` (stanu nie dało się odczytać; ACK przy
 *    nieznanym stanie byłby decyzją nieodwracalną w imieniu klientki);
 *  - `owed_units === settled_units` ⇒ `PASS`;
 *  - w przeciwnym razie `FAIL` z listą braków i nadmiarów (JEDNOSTKI, nie
 *    licznik — dwa braki i dwa nadmiary dałyby równy licznik i fałszywe
 *    `PASS`).
 */
export function evaluateOwedUnitAck(input: {
  owed_units: ReadonlyArray<string>
  settled_units: ReadonlyArray<string> | null
}): OwedUnitAckEvaluation {
  const owed = [...new Set(input.owed_units)].sort()
  if (owed.length === 0) {
    throw new Error("evaluateOwedUnitAck: pusty zbiór jednostek należnych nie ma werdyktu")
  }
  if (input.settled_units === null) {
    return {
      verdict: "UNKNOWN",
      owed_units: owed,
      settled_units: [],
      missing_units: owed,
      unexpected_units: [],
    }
  }
  const settled = [...new Set(input.settled_units)].sort()
  const settledSet = new Set(settled)
  const owedSet = new Set(owed)
  const missing = owed.filter((unit) => !settledSet.has(unit))
  const unexpected = settled.filter((unit) => !owedSet.has(unit))
  return {
    // ACK sukcesu wymaga RÓWNOŚCI zbiorów, nie samego zawierania owed w
    // settled. Obca jednostka przy komplecie należnych jest naruszeniem
    // kontraktu dostawy i musi zachować retry tak samo jak brak.
    verdict: missing.length === 0 && unexpected.length === 0 ? "PASS" : "FAIL",
    owed_units: owed,
    settled_units: settled,
    missing_units: missing,
    unexpected_units: unexpected,
  }
}

/**
 * Mapowanie werdyktu na kod HTTP odpowiedzi webhooka. Tylko `PASS` wolno
 * zaACK-ować; `FAIL`/`UNKNOWN` MUSZĄ zachować ponowienie Stripe (5xx — Stripe
 * ponawia każdy nie-2xx; 500 jest już używane w route jako „zachowaj ponowienie").
 */
export const OWED_UNIT_ACK_HTTP_STATUS: Readonly<Record<OwedUnitAckVerdict, number>> =
  Object.freeze({
    PASS: 200,
    FAIL: 500,
    UNKNOWN: 500,
  })

export function ackStatusForVerdict(verdict: OwedUnitAckVerdict): number {
  return OWED_UNIT_ACK_HTTP_STATUS[verdict]
}

export function isAckAllowed(verdict: OwedUnitAckVerdict): boolean {
  return verdict === "PASS"
}
