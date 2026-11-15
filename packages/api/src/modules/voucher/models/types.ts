/**
 * voucher module — shared types.
 *
 * Story v160-cleanup-25: replaces in-memory voucher-fixture-store.ts with a
 * PG-backed Medusa 2 module.
 */

/**
 * Zbiór stanów kodu vouchera.
 *
 * v1.15.0 Story 5.8 (AD-17): dopisane `expired`. Do tej story unia była
 * WĘŻSZA niż CHECK obowiązujący w bazie
 * (`1778926100000_add_voucher_expired_status_and_recipient_columns.ts`) i niż
 * słownik `specs/contracts/redemption/voucher-state-vocabulary.v3.yaml` —
 * a to jest dokładnie rozjazd, przez który allow-lista wyrażona w TypeScripcie
 * mogłaby nie znać stanu, który baza zapisze. Nośnikiem zbioru jest CHECK
 * migracji; ta unia go LUSTRZE i walidator `validate_voucher_state_vocabulary`
 * porównuje obie strony.
 *
 * v1.15.0 Story 5.9 (FR-12, AD-17): dopisane `refunded`. Do tej story stan
 * uprawnienia `REFUNDED` nie miał ODPOWIEDNIKA po stronie kodu — zwrot zmieniał
 * uprawnienie, a kod zostawał `idle`/`consent_pending` i przechodził realizację.
 */
export type VoucherStatus =
  | "idle"
  | "consent_pending"
  | "claimed"
  | "withdrawn"
  | "expired"
  | "refunded"

export type VoucherEventType =
  | "created"
  | "sent"
  | "opened"
  | "claimed"
  | "withdrawn"
  | "ENTITLEMENT_BOOKING_CANCELLED"

export interface VoucherRow {
  code: string
  market_id: string | null
  seller_id: string
  seller_name: string
  seller_handle: string
  product_title: string
  value_minor: number
  currency_code: string
  status: VoucherStatus
  expires_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface VoucherEventRow {
  id: string
  voucher_code: string | null
  event_type: VoucherEventType
  payload?: Record<string, unknown> | null
  occurred_at: Date
  created_at: Date
}

export interface VoucherWithEvents extends VoucherRow {
  events: VoucherEventRow[]
}

export interface UpsertVoucherInput {
  code: string
  market_id?: string | null
  seller_id: string
  seller_name: string
  seller_handle: string
  product_title: string
  value_minor: number
  currency_code: string
  status: VoucherStatus
  expires_at?: Date | string | null
  events?: Array<{
    id: string
    event_type: VoucherEventType
    occurred_at: Date | string
  }>
}

export interface AppendEventInput {
  event_type: VoucherEventType
  occurred_at?: Date
}

export type ClaimResult =
  | { status: "claimed"; voucher: VoucherWithEvents }
  | { status: "already_claimed"; voucher: VoucherWithEvents }
  | { status: "expired"; voucher: VoucherWithEvents }
  /** v1.15.0 Story 5.8 (AD-17): stan spoza allow-listy wejściowej, np. `withdrawn`. */
  | { status: "not_redeemable"; voucher: VoucherWithEvents }
  | { status: "not_found"; voucher: null }

/**
 * Powód ODMOWY realizacji, rozróżnialny dla kosmetolożki (UX-DR9).
 *
 * `not_found` NIE jest tu wymieniony celowo: „nieznany kod" i „nie twój
 * voucher" mają być NIEODRÓŻNIALNE, więc oba wychodzą jedną gałęzią
 * `redeem_for_seller` → `not_found`, a nie powodem odmowy.
 */
export const REDEEM_REFUSALS = {
  already_redeemed: { api_code: "VOUCHER_ALREADY_REDEEMED", http_status: 409 },
  withdrawn: { api_code: "VOUCHER_WITHDRAWN", http_status: 409 },
  expired: { api_code: "VOUCHER_EXPIRED", http_status: 410 },
  refunded: { api_code: "VOUCHER_REFUNDED", http_status: 409 },
  not_redeemable: { api_code: "VOUCHER_NOT_REDEEMABLE", http_status: 409 },
} as const

export type RedeemRefusalReason = keyof typeof REDEEM_REFUSALS

/**
 * v1.16.0 Story 5.5 (AC3, ADR-219 §4 człon 3, ADR-243 `Proposed`): powód
 * odmowy wynikający ze STANU UPRAWNIENIA, gdy stan vouchera sam z siebie
 * realizację dopuszcza (np. prezent `ISSUED` przed aktywacją: voucher `idle`,
 * uprawnienie jeszcze nieaktywne).
 *
 * Osobna oś, a NIE pozycja `REDEEM_REFUSALS`: kod odpowiedzi zostaje
 * `REDEMPTION_REFUSED`/422 (wymóg AC3), a schemat słownika v3 dopuszcza w
 * `refusal_reasons[].api_code` wyłącznie `VOUCHER_*` — włączenie tej osi do
 * kontraktu wymaga majora v4 (DW-15-327).
 */
export const ENTITLEMENT_STATE_REFUSALS = {
  not_yet_active: { api_code: "REDEMPTION_REFUSED", http_status: 422 },
  /**
   * v1.16.0 Story 5.7 (DW-15-335): KAŻDY inny stan uprawnienia spoza
   * `REDEEMABLE_SOURCE_STATES` (np. `VOIDED`) — stały powód i stałe zdanie,
   * bez wewnętrznego identyfikatora w `message`. Ten sam kod 422 (oś ADR-243;
   * włączenie do słownika powodów v4 — DW-15-327).
   */
  entitlement_not_redeemable: { api_code: "REDEMPTION_REFUSED", http_status: 422 },
} as const

export type EntitlementStateRefusalReason =
  keyof typeof ENTITLEMENT_STATE_REFUSALS

/**
 * Stany uprawnienia, dla których odmowa ma powód z `ENTITLEMENT_STATE_REFUSALS`.
 * Pozostałe stany spoza `REDEEMABLE_SOURCE_STATES` tłumaczy stan vouchera
 * (`resolveRedeemRefusalReason`) albo zostają ogólnym `REDEMPTION_REFUSED`.
 */
export function resolveEntitlementStateRefusalReason(
  entitlementState: string | null | undefined,
): EntitlementStateRefusalReason | null {
  if (entitlementState === "ISSUED") return "not_yet_active"
  // v1.16.0 Story 5.7 (DW-15-335): gałąź stanowa jest wyczerpana — stan
  // nieznany/pusty to brak informacji (wołający zostaje przy odmowie ogólnej).
  if (typeof entitlementState === "string" && entitlementState.length > 0) {
    return "entitlement_not_redeemable"
  }
  return null
}

/**
 * v1.16.0 Story 5.7 (AC2, ADR-245 `Proposed` §4): odmowy KOREKTY realizacji.
 * Oś osobna od `REDEEM_REFUSALS` (słownik v3 dopuszcza tam tylko `VOUCHER_*`).
 */
export const CORRECTION_REFUSALS = {
  already_reversed: { api_code: "REDEMPTION_ALREADY_REVERSED", http_status: 409 },
  not_redeemed: { api_code: "VOUCHER_NOT_REDEEMED", http_status: 409 },
  not_correctable: { api_code: "REDEMPTION_NOT_CORRECTABLE", http_status: 422 },
} as const

export type CorrectionRefusalApiReason = keyof typeof CORRECTION_REFUSALS

/**
 * Wynik JEDNEJ operacji domenowej przyjmującej najemcę
 * (`VoucherService.redeemForSeller`, v1.15.0 Story 5.8, AD-20).
 *
 * `not_found` pokrywa DWA przypadki — kod nieznany i kod cudzy — bo
 * rozróżnienie ich byłoby wyciekiem istnienia cudzych danych (UX-DR9).
 */
export type RedeemForSellerResult =
  | { status: "redeemed"; prior_status: VoucherStatus; voucher: VoucherWithEvents }
  | { status: "refused"; reason: RedeemRefusalReason; voucher: VoucherWithEvents }
  | { status: "not_found"; voucher: null }

/**
 * Wynik WYDANIA kodu NASTĘPCY (retencja, odzysk zgubionego kodu) —
 * v1.15.0 Story 5.9 review-fix cyklu 2 (C2-MEDIUM-2).
 *
 * Do tego fixu nośnikiem był `boolean`, a `false` znaczyło DWIE różne rzeczy:
 * „stary kod nie ma wiersza `voucher`" (udokumentowane) oraz „kod następcy JUŻ
 * ISTNIEJE" (`ON CONFLICT (code) DO NOTHING` — nieudokumentowane). Wołający nie
 * potrafił ich rozróżnić i na OBU wpadał w ten sam fallback: snapshot następcy
 * dostawał STARY `voucher_code`, czyli kod, który ta sama transakcja kilka
 * linii wyżej przestawiła na `withdrawn`. To odtwarzało w całości defekt
 * MEDIUM-1 cyklu 1, tyle że za warunkiem.
 *
 * Reszta tej story konsekwentnie stosuje regułę „brak efektu = wynik NAZWANY
 * albo fail-closed, nigdy cichy no-op" (`already_invalidated_other`,
 * `no_voucher_code`, `MissingVoucherCodeInvalidatorError`). Ten typ dopisuje
 * ten sam kształt tutaj.
 */
export type SuccessorVoucherCodeOutcome =
  /** Wiersz `voucher` następcy powstał w TEJ transakcji. */
  | "issued"
  /**
   * Wiersz następcy JUŻ istniał (`ON CONFLICT DO NOTHING`) — deterministyczny
   * kod następcy trafił we WŁASNY wiersz z wcześniejszej próby. Most jest
   * ważny, więc snapshot następcy wskazuje NOWY kod, tak samo jak przy
   * `issued`.
   */
  | "already_issued"
  /**
   * Stary kod nie ma wiersza `voucher`. Dla uprawnienia niosącego
   * `voucher_code` w snapshotcie jest to ZŁAMANY MOST — a nie stan do
   * pominięcia: producent stanu kodu (`invalidateVoucherCode`) wołany kilka
   * linii wyżej rzuca na dokładnie tej samej przyczynie, więc ta wartość jest
   * na ścieżce produkcyjnej nieosiągalna i wołający traktuje ją fail-closed.
   */
  | "source_missing"
