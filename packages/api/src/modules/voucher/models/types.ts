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
 * słownik `specs/contracts/redemption/voucher-state-vocabulary.v1.yaml` —
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
export type RedeemRefusalReason =
  | "already_redeemed"
  | "withdrawn"
  | "expired"
  /**
   * v1.15.0 Story 5.9 (FR-12, SM-7): voucher ZWRÓCONY. Rozłączny z
   * „zrealizowany" i „wygasły" — pieniądze wróciły do klientki, więc salon
   * nie ma za co wykonać zabiegu, a kosmetolożka ma prawo wiedzieć, dlaczego
   * odmowa nie jest tym samym co „już zrealizowany".
   */
  | "refunded"
  /**
   * Stan spoza allow-listy, który NIE jest żadnym z trzech nazwanych — czyli
   * stan dopisany do CHECK-a bazy bez dopisania go do allow-listy. Nazwanie go
   * „wycofany" byłoby kłamstwem wobec kosmetolożki, a przepuszczenie —
   * dziurą; ta gałąź jest fail-closed z uczciwą etykietą.
   */
  | "not_redeemable"

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
