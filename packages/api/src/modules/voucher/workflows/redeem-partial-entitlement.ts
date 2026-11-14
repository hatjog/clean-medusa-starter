/**
 * redeem-partial-entitlement.ts — Story 4.1 (v1.11.0 Epic 4 / Wave 4 — lifecycle).
 *
 * Operacja redeem (PEŁNY i PARTIAL) idempotentna na voucherze KWOTOWYM z
 * derecognition liability, otwierająca Epik 4 (lifecycle voucherów). Realizuje:
 *
 *   AC1 — partial obniża `remaining` na TYM SAMYM `entitlement_id` (NIGDY ponad
 *         `remaining`, NIE reissue); tranzycja routuje przez `wireEntitlement
 *         TransitionPersisted` (3.4); posting robi DERECOGNITION proporcjonalną
 *         (`generateVoucherPosting()` REDEEMED z 2.3 → `ledger-writer` 2.6).
 *   AC2 — idempotencja DWUWARSTWOWA: warstwa domeny (`idempotency_key`+
 *         `entitlement_id`, fail-closed, wiążąca) + warstwa ledgera (deterministyczny
 *         `transaction_id` writera; replay ⇒ no-op, ADR-139 D3).
 *   AC3 — withdrawal (art. 38 pkt 1) gaśnie WYŁĄCZNIE przy `REDEEMED_FULL` — NIE
 *         przy booking / `REDEEMED_PARTIAL` (saldo dostępne).
 *
 * GRANICA (D-5 / ADR-139 D5) — HOOK ≠ AKTYWACJA POSTINGU:
 *   Posting derecognition jest PODPIĘTY i WOŁANY przez okablowanie 3.4, ale
 *   `runtime_enabled` zostaje `false` ⇒ posting hook jest **audit-only / no-op**
 *   (NIE pisze do `voucher_ledger_*`). Obniżenie `remaining` (stan domeny) + audit
 *   + dedupe domenowy działają NIEZALEŻNIE od flagi postingu. Operacja NIE flipuje
 *   `runtime_enabled`, NIE deklaruje finance sign-off, NIE zmienia statusu ADR.
 *   Aktywacja = osobny P6 finance gate (E6/P6 + per-market signoff D-59).
 *
 * GRANICE ZAKRESU (E4): operacja KONSUMUJE istniejące okablowanie (3.4), writer
 * (2.6) i generator (2.3). NIE reimplementuje posting/VAT logiki (MPV suspense→
 * output liczy generator 2.3, VER-H1 kumulatywnie). NIE zmienia taksonomii stanów
 * (`REDEEMED_PARTIAL`/`REDEEMED_FULL` istnieją; operacja dodaje WYŁĄCZNIE nowego
 * callera okablowania). NIE reissue prawa. NIE rusza hard-gate'ów MPV/SUBSCRIPTION.
 *
 * Podstawa normatywna (NFR4 — referencja, NIE autorstwo): ADR-139 (D3 posting hook
 * = wołanie writera, D5 governed activation dwuwarstwowa) + ADR-133 (separacja
 * entitlement↔money, derecognition liability jako event lifecycle redeem).
 */

import { createHash } from "node:crypto"
import { Modules } from "@medusajs/framework/utils"

import {
  canTransition,
  EntitlementInstanceState,
  EntitlementType,
  snapshotPolicy,
  type EntitlementPolicySnapshot,
} from "../models/entitlement"
import {
  assertTransferabilityAllowed,
  type RedeemContext,
} from "../entitlement-boundary"
import type { VatClassification } from "../vat-resolver"
import {
  wireEntitlementTransitionPersisted,
  emitTransitionEventAfterCommit,
  type TransitionScope,
  type TransitionActor,
  type TransitionAuditEnvelope,
  type TransitionEventEnvelope,
  type TransitionPostingResult,
  type TransitionLedgerWriter,
  type PostingActivationGate,
} from "../entitlement-transition-wiring"
import { deriveLedgerTransactionId } from "../ledger-writer"
// v1.15.0 Story 5.9 review-fix cyklu 2 (C2-HIGH-2): odwrócenie PEŁNE realizacji
// prowadzi do `REFUNDED`, czyli stanu UNIEWAŻNIAJĄCEGO — okablowanie wymaga
// wtedy producenta stanu kodu (fail-closed `MissingVoucherCodeInvalidatorError`),
// a `wiringDeps` tej ścieżki go nie niosły.
import {
  decideVoucherCodeInvalidation,
  invalidateVoucherCode,
  type VoucherCodeInvalidationResult,
} from "../voucher-code-state"
import type { VoucherStatus } from "../models/types"

// ──────────────────────────────────────────────────────────────────────────
// Stany redeemowalne (źródło tranzycji) — voucher kwotowy z saldem
// ──────────────────────────────────────────────────────────────────────────

/**
 * Stany, z których redeem może wystartować: `ACTIVE` (pierwszy redeem) oraz
 * `REDEEMED_PARTIAL` (kolejna rata multi-installment — saldo wciąż dostępne).
 * Graf (3.4) prowadzi OBA przez `REDEMPTION_REQUESTED` → `REDEEMED_PARTIAL`/
 * `REDEEMED_FULL` (krawędzie istnieją; NIE zmieniamy taksonomii, D-5).
 */
export const REDEEMABLE_SOURCE_STATES: ReadonlySet<EntitlementInstanceState> = new Set([
  EntitlementInstanceState.ACTIVE,
  EntitlementInstanceState.REDEEMED_PARTIAL,
])

const AMOUNT_REDEEMABLE_TYPES: ReadonlySet<EntitlementType> = new Set([
  EntitlementType.VOUCHER_AMOUNT,
  EntitlementType.CREDIT_PACK,
])

const BUNDLE_REDEEMABLE_TYPE = EntitlementType.BUNDLE

/**
 * Typ realizowany JEDNOSTKOWO, nie kwotowo (v1.15.0 Story 6.3, review-fix
 * cyklu 1, F-0).
 *
 * ZMIERZONE na `gp_mercur` 2026-08-12: KAŻDY produkt katalogu BonBeauty
 * wystawia `VOUCHER_SERVICE` (`select count(*) … entitlement_type='VOUCHER_AMOUNT'`
 * → `0`), a `remaining_amount` i `reference_price_minor` są dla tych uprawnień
 * `NULL` — i to jest zgodne z projektem: `computeReferencePriceMinor`
 * (`live-issue-from-payment-intent.ts`) liczy je WYŁĄCZNIE dla CREDIT_PACK
 * i BUNDLE. Skutek: trasa panelu (`vendor/vouchers/[code]/redeem`) odmawiała
 * `422 REDEMPTION_REFUSED` realizacji CAŁEGO asortymentu — ekran w salonie nie
 * mógł zrealizować żadnego vouchera, który ten sklep sprzedaje.
 *
 * Gałąź kwotowa NIE jest tu właściwą drogą (nie ma salda do obniżania).
 * Voucher serwisowy jest NIEPODZIELNY: jedna realizacja konsumuje całą
 * jednostkę usługi, więc stanem wyjściowym jest zawsze `REDEEMED_FULL`.
 * Podstawą prowizji i derecognition jest CAŁE brutto emisji — to ta sama
 * wartość, którą `resolveIssuedNetVat` czyta z `policy_snapshot.amount_minor`,
 * więc reguła bilansu ADR-178 §2.3 (`Σ ≤ issued_gross_minor`) trzyma bez
 * zmiany licznika.
 *
 * Wszystko poza rozpoznaniem WYDATKU zostaje wspólne z gałęzią kwotową:
 * `wireEntitlementTransitionPersisted` (oba kroki), posting `REDEEMED`
 * (profil `VOUCHER_SERVICE` istnieje — `posting-profile.ts:151`), zdarzenie
 * odwracające (5.7 — `reverseRedemption` jest agnostyczne typowo, bo operuje
 * na wierszu kanonicznym), idempotencja po `idempotency-key`, allow-lista
 * stanów kodu (5.8) i granica najemcy pod TĄ SAMĄ blokadą wiersza.
 */
const UNIT_REDEEMABLE_TYPE = EntitlementType.VOUCHER_SERVICE

/** Wynik dyskryminacji redeemu: pełny (`remaining`→0) vs partial (saldo > 0). */
export type RedeemOutcome =
  | EntitlementInstanceState.REDEEMED_PARTIAL
  | EntitlementInstanceState.REDEEMED_FULL

// ──────────────────────────────────────────────────────────────────────────
// Withdrawal (art. 38 pkt 1) — gaśnie WYŁĄCZNIE przy REDEEMED_FULL (AC3)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Prawo odstąpienia (art. 38 pkt 1 u.p.k.) gaśnie WYŁĄCZNIE przy `REDEEMED_FULL`
 * (usługa wykonana w całości). Czysta funkcja stanu — NIE wiąże wygaśnięcia z
 * bookingiem, potwierdzeniem terminu ani `REDEEMED_PARTIAL` (saldo dostępne,
 * usługa niewykonana w całości). FR13 korekta 2026-05-31 / UX-DR-V1110-09:
 * wygaśnięcie wymaga kumulatywnie uprzedniej wyraźnej zgody + oświadczenia o
 * utracie prawa — copy NIGDY nie sugeruje wygaśnięcia przy samym booking.
 */
export function isWithdrawalRightExtinguished(
  state: EntitlementInstanceState
): boolean {
  return state === EntitlementInstanceState.REDEEMED_FULL
}

// ──────────────────────────────────────────────────────────────────────────
// redemption_id deterministyczny (per (entitlement_id, idempotency_key))
// ──────────────────────────────────────────────────────────────────────────

/**
 * Rodzaj wpisu kanonicznej (ADR-178 §2.3) — ALLOW-LISTA, nie negacja (AD-17).
 * Odwrócenie jest OSOBNYM RODZAJEM WPISU, nigdy kasowaniem ani `UPDATE`-em
 * obniżającym kwotę: ledger jest append-only.
 */
export type RedemptionKind = "REDEMPTION" | "REVERSAL"

export const REDEMPTION_KIND_REDEMPTION: RedemptionKind = "REDEMPTION"
export const REDEMPTION_KIND_REVERSAL: RedemptionKind = "REVERSAL"

/**
 * Deterministyczny `redemption_id` z TRÓJKI (`entitlement_id`, `idempotency_key`,
 * `kind`) — preimage zamrożony w ADR-178 §2.3.
 *
 * Trzeci człon nie jest ozdobnikiem. `REVERSAL` niesie DOKŁADNIE TEN SAM
 * `idempotency_key` co odwracana realizacja (rozróżnia je `kind`), więc przy
 * dwuczłonowym preimage oba wiersze miałyby identyczny `redemption_id`:
 * `reverses_redemption_id` pasowałoby wtedy do dwóch wierszy, a dyskryminator,
 * którego `ledger-writer` wymaga fail-closed, przestawałby dyskryminować.
 *
 * Stabilny przy replay (ta sama trójka ⇒ ten sam id) i unikalny per rata
 * (różny `idempotency_key` ⇒ różny id ⇒ N postingów dla N rat multi-installment).
 */
export function buildRedemptionId(
  entitlementId: string,
  idempotencyKey: string,
  kind: RedemptionKind
): string {
  const digest = createHash("sha256")
    .update(`${entitlementId}‖${idempotencyKey}‖${kind}`)
    .digest("hex")
    .toUpperCase()
  return `RDM-${digest.slice(0, 12)}`
}

/**
 * Klucz idempotencji realizacji PANELOWEJ, wiązany SERWEROWO z uprawnieniem
 * (ADR-178 §2.2 M4 pkt 3).
 *
 * Serwer nie ufa nagłówkowi `Idempotency-Key` — waliduje go i wiąże z
 * `entitlement_id`, dzięki czemu ten sam nagłówek użyty przeciw INNEMU
 * uprawnieniu nie koliduje. Nagłówka nie wolno zastąpić wartością serwerową
 * przy jego braku: klucz zmyślony przez serwer jest losowy per żądanie, a to
 * jest dokładnie usuwany defekt (`vva_${randomUUID()}` w trasie).
 */
export function buildPanelIdempotencyKey(
  entitlementId: string,
  headerKey: string
): string {
  const digest = createHash("sha256")
    .update(`${entitlementId}‖${headerKey}`)
    .digest("hex")
    .toUpperCase()
  return `PANEL-${digest.slice(0, 32)}`
}

/**
 * `audit_log_id` jest POCHODNĄ klucza idempotencji, nie jego źródłem
 * (ADR-178 §2.2 M4 pkt 4). Odwrócenie kolejności (klucz → koperta, zamiast
 * koperta → klucz) sprawia, że retry produkuje TĘ SAMĄ kopertę audytową,
 * a nie drugą kopertę opisującą to samo zdarzenie.
 */
export function buildAuditLogIdFromIdempotencyKey(
  idempotencyKey: string
): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex")
  return `vva_${digest.slice(0, 32)}`
}

/**
 * Zapytanie licznika podstawy prowizji — SKOPIOWANE DOSŁOWNIE z ADR-178 §2.3.
 * 5.7 nie pisze własnego: rozjazd w tym zapytaniu jest rozjazdem w pieniądzu.
 */
export const COMMISSION_BASE_QUERY = `
  SELECT
    COALESCE(SUM(CASE WHEN kind = 'REDEMPTION' THEN amount_minor ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN kind = 'REVERSAL' THEN amount_minor ELSE 0 END), 0)
      AS commission_base_minor
  FROM voucher_redemption
  WHERE entitlement_id = $1
` as const

/**
 * Rozbicie licznika na DWA składniki, których `COMMISSION_BASE_QUERY` nie
 * rozróżnia, bo je odejmuje. Posting odwracający potrzebuje obu osobno:
 * `reversed_minor` jako `reversed_gross_to_date_minor` (kumulatywno-marginalne
 * rozpoznanie VAT, symetryczne do realizacji), `redeemed_minor` jako sufit
 * odwrócenia (Σ odwróceń ≤ Σ realizacji). Różnica tych dwóch liczb to ten sam
 * licznik — dlatego to jest rozbicie, a nie drugie źródło prawdy.
 */
export const REDEMPTION_GROSS_TOTALS_QUERY = `
  SELECT
    COALESCE(SUM(CASE WHEN kind = 'REDEMPTION' THEN amount_minor ELSE 0 END), 0)
      AS redeemed_minor,
    COALESCE(SUM(CASE WHEN kind = 'REVERSAL' THEN amount_minor ELSE 0 END), 0)
      AS reversed_minor
  FROM voucher_redemption
  WHERE entitlement_id = $1
` as const

/** Σ realizacji i Σ odwróceń dla uprawnienia, w minor units. */
export type RedemptionGrossTotals = {
  redeemed_minor: number
  reversed_minor: number
}

// ──────────────────────────────────────────────────────────────────────────
// Błędy fail-closed
// ──────────────────────────────────────────────────────────────────────────

export class RedeemEntitlementNotFoundError extends Error {
  constructor(id: string) {
    super(`entitlement_instance ${id} was not found`)
    this.name = "RedeemEntitlementNotFoundError"
  }
}

/**
 * Rzucany gdy kwota redeemu narusza inwariant zakresu: nie jest dodatnią liczbą
 * całkowitą minor-units LUB przekracza `remaining` (over-redeem). Fail-closed —
 * BRAK częściowego skutku, BRAK ujemnego salda (cała tranzycja wycofana).
 */
export class RedeemAmountError extends Error {
  readonly amount: number
  readonly remaining: number
  constructor(message: string, amount: number, remaining: number) {
    super(message)
    this.name = "RedeemAmountError"
    this.amount = amount
    this.remaining = remaining
  }
}

/** Rzucany gdy entitlement nie jest w stanie/typie redeemowalnym (fail-closed). */
export class RedeemNotRedeemableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RedeemNotRedeemableError"
  }
}

/**
 * Odmowa warstwy uprawnienia wynikająca WYŁĄCZNIE ze STANU uprawnienia
 * (`REDEEMABLE_SOURCE_STATES`) — v1.15.0 Story 5.8, review-fix cyklu 1 (LOW).
 *
 * Po co osobny podtyp: trasa `/vendor/vouchers/:code/redeem` tłumaczy odmowę
 * warstwy uprawnienia na ROZRÓŻNIALNY powód stanu vouchera (UX-DR9). Łapanie
 * całej klasy `RedeemNotRedeemableError` przypinało tę etykietę także odmowom,
 * które ze stanem nie mają nic wspólnego — nieobsługiwany `entitlement_type`,
 * `remaining <= 0`, podanie obu identyfikatorów naraz albo żadnego. Skutek:
 * odmowa poprawna (fail-closed), ale powód ZMYŚLONY („voucher wycofany”, gdy
 * realną przyczyną był typ uprawnienia).
 *
 * Podtyp, a nie nowa klasa: wszystkie istniejące `catch (RedeemNotRedeemableError)`
 * (i mapowanie na `422 REDEMPTION_REFUSED`) działają dalej bez zmian.
 */
export class RedeemEntitlementStateError extends RedeemNotRedeemableError {
  constructor(message: string) {
    super(message)
    this.name = "RedeemEntitlementStateError"
  }
}

export class RedeemChoiceSetItemError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RedeemChoiceSetItemError"
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Most kod vouchera → uprawnienie (ADR-178 §2.2 M1–M4) — WYŁĄCZNIE fail-closed
// ──────────────────────────────────────────────────────────────────────────

/**
 * M2 — kod bez uprawnienia. Realizacja NIE jest wykonywana: trasa nie tworzy
 * uprawnienia w locie i NIE degraduje do zapisu `voucher_event`-only. Cichy
 * fallback do trasy bez kwoty jest odtworzeniem defektu, który ADR-178 usuwa.
 */
export class RedemptionEntitlementNotFoundError extends Error {
  readonly error_code = "ENTITLEMENT_NOT_FOUND"
  constructor(readonly voucherCode: string) {
    super(
      `realizacja: kod '${voucherCode}' nie ma powiązanego uprawnienia — ` +
        "odmowa fail-closed (ADR-178 §2.2 M2)"
    )
    this.name = "RedemptionEntitlementNotFoundError"
  }
}

/**
 * M3 — wiele uprawnień na jeden kod. Wybór „pierwszego lepszego" obciążyłby
 * saldo losowego bytu, dlatego `LIMIT 1` jest tu ZAKAZANY (to jest różnica
 * względem `VoucherService.findBuyerClaimSource`, która czyta, a nie realizuje).
 */
export class RedemptionEntitlementAmbiguousError extends Error {
  readonly error_code = "ENTITLEMENT_AMBIGUOUS"
  constructor(readonly voucherCode: string, readonly entitlementIds: string[]) {
    super(
      `realizacja: kod '${voucherCode}' wskazuje ${entitlementIds.length} uprawnień ` +
        `(${entitlementIds.join(", ")}) — odmowa fail-closed (ADR-178 §2.2 M3)`
    )
    this.name = "RedemptionEntitlementAmbiguousError"
  }
}

/** M4 pkt 2 — brak nagłówka `Idempotency-Key` jest ODMOWĄ, nie kluczem serwerowym. */
export class RedemptionIdempotencyKeyRequiredError extends Error {
  readonly error_code = "IDEMPOTENCY_KEY_REQUIRED"
  constructor(message: string) {
    super(message)
    this.name = "RedemptionIdempotencyKeyRequiredError"
  }
}

/** Odwrócenie wskazujące wiersz, którego nie ma (ADR-178 §2.3). */
export class ReversalTargetNotFoundError extends Error {
  readonly error_code = "REVERSAL_TARGET_NOT_FOUND"
  constructor(readonly redemptionId: string) {
    super(
      `odwrócenie: brak wiersza realizacji o redemption_id='${redemptionId}' — ` +
        "odwrócenie musi wskazywać DOKŁADNIE jeden istniejący wpis"
    )
    this.name = "ReversalTargetNotFoundError"
  }
}

/**
 * Odwrócenie odwrócenia jest ZAKAZANE (ADR-178 §2.3). Cofnięcie zwrotu to NOWA
 * realizacja (`REDEMPTION`), nie podwójna negacja — inaczej łańcuch odwróceń
 * staje się nieczytelny dla licznika prowizji.
 */
export class ReversalOfReversalError extends Error {
  readonly error_code = "REVERSAL_OF_REVERSAL_FORBIDDEN"
  constructor(readonly redemptionId: string) {
    super(
      `odwrócenie: wiersz '${redemptionId}' ma kind='REVERSAL' — odwrócenie ` +
        "odwrócenia jest zakazane (ADR-178 §2.3)"
    )
    this.name = "ReversalOfReversalError"
  }
}

/**
 * Reguła bilansu (ADR-178 §2.3), egzekwowana FAIL-CLOSED PRZED `INSERT`-em:
 * `Σ(REDEMPTION) − Σ(REVERSAL)` nigdy < 0 i nigdy > `issued_gross_minor`.
 * CHECK tabelowy nie widzi agregatu, więc predykat MUSI być w operacji.
 */
export class RedemptionBalanceError extends Error {
  readonly error_code = "REDEMPTION_BALANCE_VIOLATION"
  constructor(message: string) {
    super(message)
    this.name = "RedemptionBalanceError"
  }
}

/**
 * Odwrócenie ze stanu, z którego uprawnienie nie może wejść w ścieżkę zwrotu
 * (ADR-198). Predykat NIE jest drugą kopią grafu: pyta wprost
 * `canTransition(state, REFUND_REQUESTED)`, więc rozjazd z `models/entitlement.ts`
 * jest strukturalnie niemożliwy. Istnieje dla DIAGNOSTYKI — bez niego odmowa
 * przychodziła z okablowania jako `EntitlementTransitionError`, czyli komunikatem
 * o krawędzi grafu tam, gdzie faktem domenowym jest „to uprawnienie jest już
 * zwrócone / nie było realizowane".
 */
export class RedemptionReversalStateError extends Error {
  readonly error_code = "REVERSAL_SOURCE_STATE_FORBIDDEN"
  constructor(readonly entitlementId: string, readonly state: string) {
    super(
      `odwrócenie: uprawnienie ${entitlementId} jest w stanie '${state}', z którego ` +
        "graf nie prowadzi do REFUND_REQUESTED — odwrócenie wymaga uprawnienia " +
        "mogącego wejść w ścieżkę zwrotu (odmowa fail-closed, ADR-198)"
    )
    this.name = "RedemptionReversalStateError"
  }
}

/** Rynek jest wymagany na ścieżce pieniądza (AD-22) — brak rynku = odmowa zapisu. */
export class RedemptionMarketRequiredError extends Error {
  readonly error_code = "REDEMPTION_MARKET_REQUIRED"
  constructor(message: string) {
    super(message)
    this.name = "RedemptionMarketRequiredError"
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Kontrakty wejścia / wyjścia
// ──────────────────────────────────────────────────────────────────────────

export type RedeemPartialInput = {
  /**
   * Uprawnienie wskazane WPROST (ścieżka workflowów). Trasa panelowa go NIE ZNA
   * — podaje `voucher_code`, a most M1 rozwiązuje go do uprawnienia wewnątrz tej
   * samej transakcji co `SELECT … FOR UPDATE`.
   */
  entitlement_id?: string
  /**
   * Kod vouchera (ścieżka panelowa `POST /vendor/vouchers/:code/redeem`).
   * Rozłączny z `entitlement_id`: podanie obu naraz jest odmową, bo dwa źródła
   * prawdy o tym, co jest realizowane, to dwie prawdy o jednym zdarzeniu.
   */
  voucher_code?: string
  /**
   * Zrealizowane brutto w tym evencie (minor units). Dla VOUCHER_AMOUNT/CREDIT_PACK:
   * 1 ≤ amount ≤ remaining. Dla BUNDLE może być pominięte — wtedy kwota pochodzi z
   * konsumowanej pozycji choice_set; jeśli podane, musi równać się jej remaining.
   */
  amount_minor?: number
  /**
   * Realizacja CAŁEGO pozostałego salda (ścieżka panelowa). Dzisiejsza akcja
   * panelu jest realizacją całości (`claim`), a nie kwotą — realizacja częściowa
   * z kwotą wpisaną przez sprzedawcę należy do Story 5.8. Flaga jest JAWNA,
   * a nie dorozumiana z obecności `voucher_code`: „brak kwoty znaczy wszystko"
   * jest dokładnie tym rodzajem domyślności, przez który saldo schodzi za dużo.
   */
  redeem_full?: boolean
  /** BUNDLE: identyfikator wiersza `entitlement_choice_set_item` do konsumpcji. */
  choice_set_item_id?: string
  /** Klucz idempotencji operacji domeny (z `entitlement_id` = klucz dedupe AC2). */
  idempotency_key?: string
  /**
   * Surowa wartość nagłówka `Idempotency-Key` z trasy panelowej (ADR-178 M4).
   * Serwer jej NIE UFA: waliduje i wiąże z uprawnieniem
   * ({@link buildPanelIdempotencyKey}), więc ten sam nagłówek użyty przeciw
   * innemu uprawnieniu nie koliduje. Rozłączny z `idempotency_key`.
   */
  idempotency_key_header?: string
  /**
   * Rynek REALIZACJI (AD-22) — rynek sesji panelu. Gdy brak, przyjmowany jest
   * rynek zakupu; osobnym polem jest, bo bywa inny.
   */
  redemption_market_id?: string | null
  /** Waluta payloadu postingu + currency consistency guard writera. Domyślnie PLN. */
  currency?: string
  /**
   * Klasyfikacja VAT vouchera (SPV/MPV) — KONSUMOWANA z resolvera 2.2 / snapshotu
   * entitlementu, NIE reklasyfikowana tutaj. MPV ⇒ derecognition VAT-at-redeem;
   * SPV ⇒ brak nowego VAT (udokumentowany no-op generatora). Gdy brak, czytany ze
   * snapshotu (`policy_snapshot`/kolumna) przez store; jawny override ma priorytet.
   */
  vat_classification?: VatClassification
  /**
   * Netto (ex-VAT) CAŁEGO vouchera przy emisji, minor units (payload generatora
   * 2.3 — proporcja liczy się od `net+vat`). Operacja routuje payload, NIE liczy
   * VAT (zakres generatora 2.3 / resolvera 2.2).
   *
   * v1.15.0 Story 5.7: OPCJONALNE dla ścieżki panelowej. `policy_snapshot`
   * uprawnienia niesie dziś WYŁĄCZNIE `amount_minor` (brutto emisji) — rozbicia
   * net/VAT tam NIE MA (zmierzone w `live-issue-from-payment-intent.ts`).
   * Gdy caller go nie poda, brutto emisji trafia w całości do `net`, a VAT jest
   * zerem. Konsekwencja jest NAZWANA, nie przemilczana: dla MPV derecognition
   * VAT policzy wtedy 0. Termin i nośnik wzbogacenia snapshotu o net/VAT leżą
   * w rejestrze zaległości (patrz `deferred-work.md`, wpis Story 5.7).
   */
  voucher_net_minor?: number
  /** VAT CAŁEGO vouchera przy emisji, minor units (payload generatora 2.3). */
  voucher_vat_minor?: number
  /** Ontologia scope (FK 3.2). `market_id` wymagany; reszta opcjonalna. */
  market_id?: string | null
  sales_channel_id?: string | null
  vendor_id?: string | null
  location_id?: string | null
  /** Aktor tranzycji (envelope.v1). Domyślnie `vendor` (Vendor/Salon realizuje). */
  actor?: TransitionActor
  actor_hint?: string
  /** Tożsamość realizującego (transferability `personalized`/`hybrid`). */
  redeeming_customer_id?: string | null
  now?: Date
}

/** Wejście operacji ODWRACAJĄCEJ realizację (ADR-178 §2.3). */
export type ReverseRedemptionInput = {
  /**
   * `redemption_id` wiersza REALIZACJI, który jest odwracany. Wskazuje
   * DOKŁADNIE jeden wiersz dzięki `UNIQUE (redemption_id)` i preimage objętemu
   * `kind` — bez tych dwóch rzeczy pasowałby do dwóch wierszy naraz.
   */
  reverses_redemption_id: string
  /**
   * Rozbicie brutto emisji na net/VAT — to samo, którym liczony był posting
   * REALIZACJI. Gdy brak, źródłem jest `policy_snapshot.amount_minor`, a VAT
   * jest zerem; wtedy generator zwraca UDOKUMENTOWANY no-op zamiast legu VAT
   * (patrz {@link RedeemPartialInput.voucher_net_minor} — snapshot nie niesie
   * dziś rozbicia). Odwrócenie musi dostać TĘ SAMĄ podstawę co realizacja,
   * inaczej cofnęłoby inną kwotę VAT niż rozpoznano.
   */
  voucher_net_minor?: number
  voucher_vat_minor?: number
  currency?: string
  vat_classification?: VatClassification
  actor?: TransitionActor
  actor_hint?: string
  now?: Date
}

export type ReverseRedemptionResult = {
  entitlement_id: string
  /** `redemption_id` wiersza ODWRACAJĄCEGO (inny niż odwracanej realizacji). */
  redemption_id: string
  reverses_redemption_id: string | null
  amount_minor: number
  /** Podstawa prowizji PRZED odwróceniem — zmierzona zapytaniem ADR-178 §2.3. */
  commission_base_before_minor?: number
  /** Podstawa prowizji PO odwróceniu. Musi być NIŻSZA — to jest cały dowód AC3. */
  commission_base_after_minor?: number
  /**
   * Stan uprawnienia PO odwróceniu (ADR-198). `REFUNDED` (terminalny) TYLKO gdy
   * odwrócenie było pełne (`Σ REVERSAL == Σ REDEMPTION`); przy odwróceniu
   * częściowym `REDEEMED_PARTIAL`, żeby pozostałe raty dały się odwrócić.
   * Pole istnieje, bo bez niego rozróżnienie było niewidoczne dla callera —
   * a od niego zależy, czy odwrócenie kolejnej raty jest jeszcze możliwe.
   */
  entitlement_state_after?: EntitlementInstanceState
  /** `true` gdy to odwrócenie domknęło uprawnienie (Σ REVERSAL == Σ REDEMPTION). */
  fully_reversed?: boolean
  code_invalidation_outcome?: VoucherCodeInvalidationResult["outcome"]
  idempotent: boolean
  posting: TransitionPostingResult
  emit_failed: boolean
}

export type RedeemPartialResult = {
  entitlement_id: string
  redemption_id: string
  outcome: RedeemOutcome
  new_state: RedeemOutcome
  amount_minor: number
  remaining_before_minor: number
  remaining_after_minor: number
  /** BUNDLE: pozycja choice_set skonsumowana w tym redeemie. */
  choice_set_item_id?: string
  /** BUNDLE: niezrealizowane pozycje po redeemie, do pokazania jako dostępne. */
  available_choice_set_item_ids?: string[]
  /** AC3: prawo odstąpienia (art. 38 pkt 1) — gaśnie WYŁĄCZNIE przy REDEEMED_FULL. */
  withdrawal_right_extinguished: boolean
  /** Wynik posting hooka (derecognition). Bramkowany: audit-only/no-op gdy off. */
  posting: TransitionPostingResult
  /** true ⇒ replay (domena/ledger) — `remaining` NIE obniżony ponownie. */
  idempotent: boolean
  /** true ⇒ 2× emit eventu zawiódł (best-effort; reconciliation 2.6). */
  emit_failed: boolean
}

/** Persisted record dedupe domeny (1:1 z `voucher_redemption`). */
export type RedemptionRecord = {
  entitlement_id: string
  idempotency_key: string
  redemption_id: string
  amount_minor: number
  choice_set_item_id?: string | null
  resulting_state: RedeemOutcome
  remaining_after_minor: number
  /**
   * Rodzaj wpisu (ADR-178 §2.3). `REVERSAL` niesie TEN SAM `idempotency_key`
   * co odwracana realizacja — rozróżnia je właśnie to pole, dlatego weszło
   * do PK i do preimage `redemption_id`.
   */
  kind: RedemptionKind
  /**
   * `NOT NULL` wtedy i tylko wtedy, gdy `kind = 'REVERSAL'` — egzekwowane
   * CHECK-iem `voucher_redemption_reversal_link_check`, nie konwencją.
   */
  reverses_redemption_id?: string | null
  /**
   * Rynek WŁAŚCICIELSKI wiersza — po nim idzie izolacja RLS i raportowanie.
   * DENORMALIZACJA `purchase_market_id`, nie trzeci niezależny rynek
   * (CHECK `market_id IN (purchase_market_id, redemption_market_id)`).
   */
  market_id: string
  /** Rynek ZAKUPU — skąd wzięło się uprawnienie (AD-22). */
  purchase_market_id: string
  /** Rynek REALIZACJI — gdzie voucher zrealizowano; bywa inny niż zakupu (AD-22). */
  redemption_market_id: string
  /**
   * Brutto całego vouchera przy emisji (net+vat, minor units). Źródło prawdy
   * dla walidacji spójności net/vat między ratami (L3, VER-H1 fail-closed).
   * Przechowywane przy pierwszym redeem; kolejne raty muszą mieć ten sam totalGross.
   */
  issued_gross_minor: number
  created_at: number
}

/** Wiersz entitlementu potrzebny redeemowi (podzbiór `entitlement_instance`). */
export type RedeemableAmountEntitlement = {
  id: string
  entitlement_type: EntitlementType
  state: EntitlementInstanceState
  remaining_amount: number | null
  policy_snapshot: EntitlementPolicySnapshot
  vat_classification: VatClassification | null
  /**
   * Waluta emisji vouchera — źródło prawdy dla currency consistency guard writera (L2).
   * Czytana z `policy_snapshot.currency_code` lub kolumny emisji. Gdy null:
   * guard cofa się do waluty inputu (PLN-only bonbeauty — latent).
   */
  issued_amount_currency?: string | null
  market_id: string | null
  sales_channel_id: string | null
  vendor_id?: string | null
  location_id?: string | null
  recipient_customer_id?: string | null
}

export type RedeemableChoiceSetItem = {
  id: string
  instance_id: string
  market_id: string
  reference_amount_minor: number
  remaining_minor: number
  status: "ACTIVE" | "REDEEMED"
  redemption_id: string | null
}

// ──────────────────────────────────────────────────────────────────────────
// Store / tx — granica persystencji (wzorzec InMemory*/Postgres* z workflows/)
// ──────────────────────────────────────────────────────────────────────────

export interface RedeemPartialTx {
  getEntitlementForUpdate(
    id: string
  ): Promise<RedeemableAmountEntitlement | null>
  /**
   * MOST kod vouchera → uprawnienie (ADR-178 §2.2 M1), wykonany POD ROW-LOCKIEM
   * i w TEJ SAMEJ transakcji co reszta realizacji — rezolucja poza transakcją
   * byłaby TOCTOU.
   *
   * Zwraca WSZYSTKIE trafienia, nigdy „pierwsze lepsze": rozstrzygnięcie
   * jednoznaczności należy do operacji (M3 wymaga ODMOWY przy wielu trafieniach,
   * a `LIMIT 1` uniemożliwiłby jej wykrycie).
   */
  resolveEntitlementsByVoucherCodeForUpdate(
    voucherCode: string
  ): Promise<RedeemableAmountEntitlement[]>
  /** Warstwa domeny idempotencji: zwraca istniejący record (replay) lub null. */
  findRedemption(
    entitlementId: string,
    idempotencyKey: string,
    kind: RedemptionKind
  ): Promise<RedemptionRecord | null>
  /** Wiersz kanonicznej po `redemption_id` (`UNIQUE`) — cel odwrócenia. */
  findRedemptionByRedemptionId(
    redemptionId: string
  ): Promise<RedemptionRecord | null>
  /**
   * Licznik podstawy prowizji dla uprawnienia — WYKONANIE zapytania
   * {@link COMMISSION_BASE_QUERY} (ADR-178 §2.3), nie własna wersja.
   */
  getCommissionBaseMinor(entitlementId: string): Promise<number>
  /**
   * Σ realizacji i Σ odwróceń OSOBNO ({@link REDEMPTION_GROSS_TOTALS_QUERY}).
   * Wołane PRZED wstawieniem wiersza odwracającego, więc zwraca stan „prior".
   */
  getRedemptionGrossTotals(entitlementId: string): Promise<RedemptionGrossTotals>
  /**
   * Zwraca DOWOLNY istniejący record dla danego entitlementu (pierwsza rata
   * multi-installment). Używany do walidacji spójności net/vat (L3, VER-H1).
   * Wywołanie TYLKO gdy `findRedemption` zwróciło null (poza ścieżką replay).
   */
  findAnyRedemptionByEntitlementId(
    entitlementId: string
  ): Promise<RedemptionRecord | null>
  getChoiceSetItemsForUpdate(
    entitlementId: string
  ): Promise<RedeemableChoiceSetItem[]>
  /**
   * Idempotentny zapis record dedupe (ON CONFLICT (entitlement_id,
   * idempotency_key) DO NOTHING). `inserted:false` ⇒ równoległy replay przegrał
   * wyścig — caller czyta zwycięski record i zwraca jego wynik (fail-closed).
   */
  insertRedemption(record: RedemptionRecord): Promise<{ inserted: boolean }>
  /** Zmiana stanu (bez salda) — krok pośredni → REDEMPTION_REQUESTED. */
  updateEntitlementState(
    id: string,
    fromState: EntitlementInstanceState,
    toState: EntitlementInstanceState,
    now: Date
  ): Promise<void>
  /** Zmiana stanu + obniżenie salda — krok finalny → REDEEMED_PARTIAL/FULL. */
  updateEntitlementRemainingAndState(
    id: string,
    fromState: EntitlementInstanceState,
    toState: RedeemOutcome,
    remainingAfter: number,
    now: Date
  ): Promise<void>
  consumeChoiceSetItem(
    id: string,
    redemptionId: string,
    now: Date
  ): Promise<void>
  /** Append-only audit (w obrębie tej tx — atomowy ze zmianą stanu). */
  appendAudit(audit: TransitionAuditEnvelope): Promise<void>
  /**
   * Unieważnienie stanu kodu vouchera — W TEJ SAMEJ transakcji co zmiana stanu
   * uprawnienia (v1.15.0 Story 5.9, AD-17; dołożone w review-fixie cyklu 2,
   * C2-HIGH-2).
   *
   * Ta ścieżka POTRZEBUJE producenta, choć na pierwszy rzut oka nie unieważnia
   * niczego: odwrócenie realizacji domyka uprawnienie do `REFUNDED`, gdy po nim
   * `Σ REVERSAL == Σ REDEMPTION` (ADR-198). Cel jest liczony dynamicznie
   * (`reversalTargetState`), więc ani bramka statyczna, ani lektura pliku po
   * nazwie stanu tego nie pokazywały — dopiero wykonanie.
   */
  invalidateVoucherCode(input: {
    entitlement_id: string
    to_state: EntitlementInstanceState
    now: Date
  }): Promise<VoucherCodeInvalidationResult>
  /**
   * Klient TEJ transakcji, wystawiony dla PROJEKCJI o jednym producencie
   * (ADR-178 §2.2 M6: `voucher_event` + `voucher.status` pisane W TEJ SAMEJ
   * transakcji, PO wierszu kanonicznym i TYLKO gdy on powstał).
   *
   * Zwraca `null` dla store'a in-memory: atrapa nie ma transakcji SQL, więc
   * projekcja jest tam pomijana, a nie udawana.
   */
  projectionClient(): ProjectionQueryable | null
}

/**
 * Minimalny kształt klienta, jakiego wymaga projekcja (`VoucherService.claim`
 * przyjmuje `opts.client` dokładnie tego kształtu). Celowo NIE jest to `PgClient`
 * — projekcja nie ma prawa zwolnić cudzego połączenia.
 */
export type ProjectionQueryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

export interface RedeemPartialStore {
  withTransaction<T>(fn: (tx: RedeemPartialTx) => Promise<T>): Promise<T>
}

export type RedeemPartialEventEmitter = {
  emit: (event: TransitionEventEnvelope) => Promise<void>
}

export type RedeemPartialDeps = {
  store: RedeemPartialStore
  events: RedeemPartialEventEmitter
  /** Idempotentny writer ledgera (2.6). Wołany tylko gdy bramka aktywuje posting. */
  ledgerWriter?: TransitionLedgerWriter
  /**
   * Bramka aktywacji postingu (ADR-139 D5). Domyślnie `defaultPostingActivation
   * Gate()` = czyta REALNĄ `runtime_enabled` (false). Test może WSTRZYKNĄĆ bramkę
   * "on" (seam) bez flipowania produkcyjnej flagi.
   */
  postingActivation?: PostingActivationGate
  /**
   * PROJEKCJA `voucher_event` + `voucher.status` (ADR-178 §2.2 M6). Wołana
   * W TEJ SAMEJ TRANSAKCJI, PO wstawieniu wiersza kanonicznego i TYLKO wtedy,
   * gdy on powstał — kolejność jest częścią decyzji: projekcja nigdy nie może
   * istnieć bez faktu, który projektuje.
   *
   * Rzucenie z tego callbacku wycofuje CAŁĄ transakcję, łącznie z wierszem
   * kanonicznym. To jest zamierzone: rozjazd fakt↔projekcja byłby gorszy niż
   * odmowa realizacji.
   */
  writeProjection?: (
    client: ProjectionQueryable,
    context: { voucher_code: string; entitlement_id: string; now: Date }
  ) => Promise<void>
  clock?: () => Date
}

type ResolvedRedeemSpend = {
  amount: number
  remainingBefore: number
  remainingAfter: number
  outcome: RedeemOutcome
  priorRedeemedGross: number
  choiceSetItemId?: string
  availableChoiceSetItemIds?: string[]
}

function assertPositiveIntegerAmount(
  amount: number | undefined,
  remaining: number
): number {
  if (!Number.isInteger(amount) || amount == null || amount < 1) {
    throw new RedeemAmountError(
      `redeem: amount_minor musi być dodatnią liczbą całkowitą (otrzymano ${amount})`,
      amount ?? 0,
      remaining
    )
  }
  return amount
}

async function resolveRedeemSpend(
  tx: RedeemPartialTx,
  ent: RedeemableAmountEntitlement,
  input: RedeemPartialInput,
  totalGross: number
): Promise<ResolvedRedeemSpend> {
  if (AMOUNT_REDEEMABLE_TYPES.has(ent.entitlement_type)) {
    const remainingBefore = ent.remaining_amount
    if (remainingBefore == null || remainingBefore <= 0) {
      throw new RedeemNotRedeemableError(
        `redeem: entitlement ${ent.id} ma remaining=${remainingBefore} ` +
          `(brak salda do realizacji)`
      )
    }

    // v1.15.0 Story 5.7: ścieżka panelowa realizuje CAŁE pozostałe saldo i mówi
    // to wprost (`redeem_full`). Kwota nadal przechodzi przez ten sam walidator,
    // więc allow-lista „1 ≤ amount ≤ remaining" obowiązuje tak samo.
    const requestedAmount =
      input.amount_minor ?? (input.redeem_full ? remainingBefore : undefined)
    const amount = assertPositiveIntegerAmount(requestedAmount, remainingBefore)
    if (amount > remainingBefore) {
      throw new RedeemAmountError(
        `redeem: amount_minor (${amount}) > remaining (${remainingBefore}) — ` +
          `over-redeem odrzucony fail-closed (brak częściowego skutku, NIE reissue)`,
        amount,
        remainingBefore
      )
    }

    const remainingAfter = remainingBefore - amount
    const priorRedeemedGross = totalGross - remainingBefore
    if (priorRedeemedGross < 0) {
      throw new RedeemAmountError(
        `redeem: niespójne wejście — remaining (${remainingBefore}) > brutto ` +
          `vouchera (${totalGross}); payload net/vat nie zgadza się z saldem`,
        amount,
        remainingBefore
      )
    }

    return {
      amount,
      remainingBefore,
      remainingAfter,
      priorRedeemedGross,
      outcome:
        remainingAfter === 0
          ? EntitlementInstanceState.REDEEMED_FULL
          : EntitlementInstanceState.REDEEMED_PARTIAL,
    }
  }

  if (ent.entitlement_type === UNIT_REDEEMABLE_TYPE) {
    // Voucher serwisowy nie ma salda — ma JEDNĄ jednostkę usługi. `totalGross`
    // jest tu notionalną „resztą": przed realizacją cała, po realizacji zero.
    // Dzięki temu wiersz kanoniczny, licznik prowizji i posting mówią o tej
    // samej podstawie co emisja, a `priorRedeemedGross` wychodzi 0 — czyli
    // prawda, bo pierwsza realizacja jest zarazem ostatnią.
    if (totalGross <= 0) {
      throw new RedeemNotRedeemableError(
        `redeem: entitlement ${ent.id} (${UNIT_REDEEMABLE_TYPE}) nie niesie ` +
          `brutto emisji (${totalGross}) — nie ma czego zrealizować`
      )
    }

    // Realizacja CZĘŚCIOWA jednostki usługi nie istnieje. Kwota inna niż całe
    // brutto to nie „mniej usługi", tylko sprzeczne żądanie — odmawiamy
    // fail-closed zamiast po cichu realizować całość.
    if (input.amount_minor != null && input.amount_minor !== totalGross) {
      throw new RedeemAmountError(
        `redeem: entitlement ${ent.id} (${UNIT_REDEEMABLE_TYPE}) jest ` +
          `NIEPODZIELNY — realizacja obejmuje całą jednostkę usługi ` +
          `(brutto ${totalGross}), a zażądano ${input.amount_minor}`,
        input.amount_minor,
        totalGross
      )
    }
    if (input.amount_minor == null && !input.redeem_full) {
      throw new RedeemAmountError(
        `redeem: entitlement ${ent.id} (${UNIT_REDEEMABLE_TYPE}) wymaga ` +
          "jawnego redeem_full — jednostki usługi nie da się realizować częściowo",
        0,
        totalGross
      )
    }

    return {
      amount: totalGross,
      remainingBefore: totalGross,
      remainingAfter: 0,
      priorRedeemedGross: 0,
      outcome: EntitlementInstanceState.REDEEMED_FULL,
    }
  }

  if (ent.entitlement_type === BUNDLE_REDEEMABLE_TYPE) {
    const choiceSetItemId = input.choice_set_item_id
    if (!choiceSetItemId) {
      throw new RedeemChoiceSetItemError(
        "redeem: BUNDLE wymaga choice_set_item_id (identyfikator pozycji choice_set)"
      )
    }

    const items = await tx.getChoiceSetItemsForUpdate(ent.id)
    const item = items.find((i) => i.id === choiceSetItemId)
    if (!item) {
      throw new RedeemChoiceSetItemError(
        `redeem: choice_set_item_id=${choiceSetItemId} nie należy do entitlement ${ent.id}`
      )
    }
    if (item.status !== "ACTIVE" || item.remaining_minor <= 0) {
      throw new RedeemChoiceSetItemError(
        `redeem: choice_set_item_id=${choiceSetItemId} jest już skonsumowany ` +
          `(status=${item.status}, remaining=${item.remaining_minor})`
      )
    }
    // INFO-3 (defensive assertion): walidacja zgodności market_id pozycji z
    // entitlementem. Ochrona przed cross-market access do czasu aktywacji
    // pełnej polityki RLS na entitlement_choice_set_item (Epic 1, ADR-141).
    // FK instance_id zapewnia powiązanie, ale market_id jest dodatkową warstwą.
    if (ent.market_id && item.market_id && item.market_id !== ent.market_id) {
      throw new RedeemChoiceSetItemError(
        `redeem: choice_set_item_id=${choiceSetItemId} należy do market=${item.market_id}, ` +
          `ale entitlement ${ent.id} jest w market=${ent.market_id} (cross-market odrzucony)`
      )
    }

    const remainingBefore = items.reduce(
      (sum, i) => sum + Math.max(0, i.remaining_minor),
      0
    )
    const amount = item.remaining_minor
    if (input.amount_minor != null && input.amount_minor !== amount) {
      throw new RedeemAmountError(
        `redeem: BUNDLE amount_minor (${input.amount_minor}) musi równać się ` +
          `remaining_minor pozycji choice_set (${amount})`,
        input.amount_minor,
        remainingBefore
      )
    }

    const remainingAfter = remainingBefore - amount
    const priorRedeemedGross = totalGross - remainingBefore
    if (priorRedeemedGross < 0) {
      throw new RedeemAmountError(
        `redeem: niespójne wejście — remaining choice_set (${remainingBefore}) > ` +
          `brutto vouchera (${totalGross}); payload net/vat nie zgadza się z setem`,
        amount,
        remainingBefore
      )
    }
    // LOW-1 (latent pre-flip invariant): payload postingu przekazuje net/vat CAŁEGO
    // vouchera przy emisji (pochodna totalGross), a redeemed_gross_minor = wartość
    // jednej pozycji choice_set. Proporcjonalna derecognition VAT dla BUNDLE liczy się
    // per pozycja (redeemed_gross_minor / totalGross * vat). Wymagany niezmiennik:
    // Σ remaining_minor wszystkich pozycji choice_set == voucher_net_minor + voucher_vat_minor.
    // Posting jest INERT (runtime_enabled:false, HG-4 DEFERRED v2.0.0+), więc brak
    // skutku finansowego. Zwalidować/zakontraktować w posting-profile BUNDLE (3.3)
    // PRZED aktywacją finance-flip (hard-gate Story 3.9/E6/P6).

    const availableChoiceSetItemIds = items
      .filter(
        (i) =>
          i.id !== item.id && i.status === "ACTIVE" && i.remaining_minor > 0
      )
      .map((i) => i.id)

    return {
      amount,
      remainingBefore,
      remainingAfter,
      priorRedeemedGross,
      choiceSetItemId,
      availableChoiceSetItemIds,
      outcome:
        remainingAfter === 0
          ? EntitlementInstanceState.REDEEMED_FULL
          : EntitlementInstanceState.REDEEMED_PARTIAL,
    }
  }

  throw new RedeemNotRedeemableError(
    `redeem: entitlement ${ent.id} ma typ ${ent.entitlement_type}; redeem ` +
      `dozwolony tylko dla VOUCHER_AMOUNT, CREDIT_PACK, BUNDLE ` +
      `i VOUCHER_SERVICE`
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Most, klucz idempotencji, rynki, reguła bilansu (ADR-178 §2.2–§2.3)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Rozwiązanie CELU realizacji: albo wskazane uprawnienie, albo kod vouchera
 * przez most M1 — zawsze pod row-lockiem i w tej samej transakcji.
 *
 * Kształt odmów jest zamrożony w ADR-178: `ENTITLEMENT_NOT_FOUND` (M2) i
 * `ENTITLEMENT_AMBIGUOUS` (M3). Ani jednego cichego wyboru „pierwszego lepszego".
 */
async function resolveRedeemTarget(
  tx: RedeemPartialTx,
  input: RedeemPartialInput
): Promise<RedeemableAmountEntitlement> {
  const byId = input.entitlement_id
  const byCode = input.voucher_code

  if (byId && byCode) {
    throw new RedeemNotRedeemableError(
      "redeem: podano jednocześnie entitlement_id i voucher_code — dwa źródła " +
        "prawdy o tym, co jest realizowane, to dwie prawdy o jednym zdarzeniu"
    )
  }

  if (byId) {
    const ent = await tx.getEntitlementForUpdate(byId)
    if (!ent) throw new RedeemEntitlementNotFoundError(byId)
    return ent
  }

  if (!byCode) {
    throw new RedeemNotRedeemableError(
      "redeem: wymagany entitlement_id albo voucher_code (ADR-178 §2.2 M1)"
    )
  }

  const found = await tx.resolveEntitlementsByVoucherCodeForUpdate(byCode)
  if (found.length === 0) {
    throw new RedemptionEntitlementNotFoundError(byCode)
  }
  if (found.length > 1) {
    throw new RedemptionEntitlementAmbiguousError(
      byCode,
      found.map((e) => e.id)
    )
  }
  return found[0]
}

/**
 * Klucz idempotencji: albo klucz domenowy podany wprost (workflowy), albo
 * nagłówek `Idempotency-Key` ZWIĄZANY SERWEROWO z uprawnieniem (panel, M4).
 *
 * Brak obu jest ODMOWĄ. Podstawienie klucza serwerowego „na wszelki wypadek"
 * jest zakazane: klucz losowy per żądanie sprawia, że `ON CONFLICT DO NOTHING`
 * nigdy nie konfliktuje, powstaje drugi wiersz kanoniczny i saldo schodzi drugi
 * raz — dokładnie ten defekt, któremu PK ma zapobiec.
 */
function resolveIdempotencyKey(
  entitlementId: string,
  input: RedeemPartialInput
): string {
  const direct = input.idempotency_key
  const header = input.idempotency_key_header

  if (direct && header) {
    throw new RedemptionIdempotencyKeyRequiredError(
      "redeem: podano jednocześnie idempotency_key i idempotency_key_header — " +
        "dwie bariery idempotencji na jednej trasie to dwie prawdy o tym samym " +
        "zdarzeniu (ADR-178 §2.2 M5)"
    )
  }
  if (direct) return direct
  if (typeof header === "string" && header.trim().length > 0) {
    return buildPanelIdempotencyKey(entitlementId, header.trim())
  }
  throw new RedemptionIdempotencyKeyRequiredError(
    "redeem: wymagany nagłówek Idempotency-Key (jeden identyfikator na akcję " +
      "użytkownika, NIEZMIENIANY przy ponowieniu). Serwer NIE podstawia klucza " +
      "za klienta — klucz losowy per żądanie tworzy drugi wiersz kanoniczny " +
      "i obniża saldo drugi raz (ADR-178 §2.2 M4)"
  )
}

/**
 * Brutto emisji rozbite na net/VAT. Gdy caller nie poda rozbicia (trasa
 * panelowa — patrz {@link RedeemPartialInput}), źródłem jest
 * `policy_snapshot.amount_minor`, a VAT jest zerem. To NIE jest wyliczenie
 * podatku — to jawne stwierdzenie, że rozbicia w snapshocie NIE MA.
 */
function resolveIssuedNetVat(
  ent: RedeemableAmountEntitlement,
  input: RedeemPartialInput
): { netMinor: number; vatMinor: number } {
  if (input.voucher_net_minor != null || input.voucher_vat_minor != null) {
    return {
      netMinor: input.voucher_net_minor ?? 0,
      vatMinor: input.voucher_vat_minor ?? 0,
    }
  }
  const snapshotAmount = (ent.policy_snapshot as Record<string, unknown>)
    .amount_minor
  const gross = Number(snapshotAmount)
  if (!Number.isInteger(gross) || gross <= 0) {
    throw new RedeemAmountError(
      `redeem: entitlement ${ent.id} nie niesie brutto emisji ` +
        `(policy_snapshot.amount_minor=${String(snapshotAmount)}), a caller nie ` +
        "podał voucher_net_minor/voucher_vat_minor — odmowa fail-closed",
      0,
      ent.remaining_amount ?? 0
    )
  }
  return { netMinor: gross, vatMinor: 0 }
}

/**
 * Trzy pola rynku wiersza kanonicznego (ADR-178 §2.4). `market_id` NIE MA
 * własnego źródła i mieć go nie może: jest kopią `purchase_market_id`.
 */
function resolveRedemptionMarkets(
  ent: RedeemableAmountEntitlement,
  input: RedeemPartialInput
): {
  market_id: string
  purchase_market_id: string
  redemption_market_id: string
} {
  const snapshotMarket = (ent.policy_snapshot as Record<string, unknown>)
    .market_id
  const purchase =
    firstNonEmpty(input.market_id, ent.market_id) ??
    (typeof snapshotMarket === "string" ? firstNonEmpty(snapshotMarket) : null)

  if (!purchase) {
    throw new RedemptionMarketRequiredError(
      `redeem: entitlement ${ent.id} nie niesie rynku zakupu ` +
        "(entitlement_instance.market_id ani policy_snapshot->>'market_id') — " +
        "wiersz bez rynku na ścieżce pieniądza wygląda na dane, więc zapis " +
        "jest odmawiany (AD-22, ADR-178 §2.4)"
    )
  }

  const redemption = firstNonEmpty(input.redemption_market_id) ?? purchase
  return {
    market_id: purchase,
    purchase_market_id: purchase,
    redemption_market_id: redemption,
  }
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value
  }
  return null
}

/**
 * Reguła bilansu z ADR-178 §2.3: `Σ(REDEMPTION) − Σ(REVERSAL)` NIGDY < 0
 * i NIGDY > `issued_gross_minor`. Sprawdzana PRZED `INSERT`-em, bo CHECK
 * tabelowy nie widzi agregatu.
 */
function assertCommissionBaseWithinBounds(
  entitlementId: string,
  baseAfter: number,
  issuedGrossMinor: number
): void {
  if (baseAfter < 0) {
    throw new RedemptionBalanceError(
      `reguła bilansu: podstawa prowizji uprawnienia ${entitlementId} zeszłaby ` +
        `do ${baseAfter} (< 0) — odmowa fail-closed (ADR-178 §2.3)`
    )
  }
  if (baseAfter > issuedGrossMinor) {
    throw new RedemptionBalanceError(
      `reguła bilansu: podstawa prowizji uprawnienia ${entitlementId} wyszłaby ` +
        `na ${baseAfter} > brutto emisji (${issuedGrossMinor}) — odmowa ` +
        "fail-closed (ADR-178 §2.3)"
    )
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Operacja redeem (partial + full) idempotentna
// ──────────────────────────────────────────────────────────────────────────

export class RedeemPartialEntitlementOperation {
  constructor(private readonly deps: RedeemPartialDeps) {}

  async redeem(input: RedeemPartialInput): Promise<RedeemPartialResult> {
    const now = input.now ?? this.deps.clock?.() ?? new Date()
    const currency = input.currency ?? "PLN"

    const txOut = await this.deps.store.withTransaction(async (tx) => {
      // ── MOST kod → uprawnienie (M1) + row-lock, W JEDNEJ TRANSAKCJI ────────
      // Rezolucja poza transakcją byłaby TOCTOU: między „ten kod wskazuje to
      // uprawnienie" a `FOR UPDATE` mogłoby powstać drugie uprawnienie.
      const ent = await resolveRedeemTarget(tx, input)

      // ── Klucz idempotencji wiązany SERWEROWO z uprawnieniem (M4) ──────────
      // `entitlement_id` jest znane DOPIERO TERAZ — dlatego klucz nie mógł
      // powstać przed transakcją.
      const idempotencyKey = resolveIdempotencyKey(ent.id, input)
      const redemptionId = buildRedemptionId(
        ent.id,
        idempotencyKey,
        REDEMPTION_KIND_REDEMPTION
      )

      // ── Warstwa DOMENY idempotencji (AC2, wiążąca / fail-closed) ───────────
      // Replay tej samej TRÓJKI (entitlement+key+kind) ⇒ NIE obniża salda
      // ponownie; zwraca skutek pierwszego redeemu deterministycznie.
      const prior = await tx.findRedemption(
        ent.id,
        idempotencyKey,
        REDEMPTION_KIND_REDEMPTION
      )
      if (prior) {
        // L6: wykryj dryf parametrów — reużyty idempotency_key z innym amount_minor
        // to sygnał błędu po stronie callera (fail-loud, NIE cichy pierwszy-skutek).
        if (
          input.amount_minor != null &&
          prior.amount_minor !== input.amount_minor
        ) {
          throw new RedeemAmountError(
            `redeem: param drift — idempotency_key=${idempotencyKey} już użyty z ` +
              `amount_minor=${prior.amount_minor}, teraz podano ${input.amount_minor} ` +
              `(dryf parametrów; fail-closed, AC2)`,
            input.amount_minor,
            prior.remaining_after_minor + prior.amount_minor
          )
        }

        // L7: BUNDLE replay — wykryj dryf choice_set_item_id przez odczyt pozycji
        // choice_set (bez zmiany schematu voucher_redemption). Pozycja skonsumowana
        // przez prior.redemption_id jest trwałym śladem w entitlement_choice_set_item.
        // Jeśli caller podaje inny choice_set_item_id ⇒ fail-loud (asymetria kontraktu
        // eliminowana; test/prod behaviour ujednolicone przez odczyt z DB, nie z rekordu).
        let replayAvailableChoiceSetItemIds: string[] | undefined
        if (ent.entitlement_type === BUNDLE_REDEEMABLE_TYPE) {
          const replayItems = await tx.getChoiceSetItemsForUpdate(ent.id)
          const redeemedItem = replayItems.find(
            (i) => i.redemption_id === prior.redemption_id
          )
          if (input.choice_set_item_id && redeemedItem && redeemedItem.id !== input.choice_set_item_id) {
            throw new RedeemChoiceSetItemError(
              `redeem: param drift (BUNDLE) — idempotency_key=${idempotencyKey} już użyty dla ` +
                `choice_set_item_id=${redeemedItem.id}, teraz podano ${input.choice_set_item_id} ` +
                `(dryf pozycji choice_set; fail-closed, AC2)`
            )
          }
          // Zwróć aktualną listę dostępnych pozycji (nie skonsumowanych) dla replay BUNDLE
          // aby zachować spójny kształt wyniku z ścieżką "applied" (AC2 „pozostałe pokazane").
          replayAvailableChoiceSetItemIds = replayItems
            .filter((i) => i.status === "ACTIVE" && i.remaining_minor > 0)
            .map((i) => i.id)
        }

        return {
          kind: "replay" as const,
          record: prior,
          replayAvailableChoiceSetItemIds,
        }
      }

      // ── Inwarianty redeemowalności (fail-closed) ──────────────────────────
      if (!REDEEMABLE_SOURCE_STATES.has(ent.state)) {
        throw new RedeemEntitlementStateError(
          `redeem: entitlement ${ent.id} w stanie ${ent.state} nie jest ` +
            `redeemowalny (dozwolone: ACTIVE / REDEEMED_PARTIAL)`
        )
      }

      // ── Transferability (regulamin § 12 — snapshot, NIE live profile) ──────
      const redeemCtx: RedeemContext = {
        customer_id: input.redeeming_customer_id ?? null,
        recipient_customer_id: ent.recipient_customer_id ?? null,
      }
      assertTransferabilityAllowed(ent.policy_snapshot, redeemCtx)

      // Redeemed-to-date PRZED tym eventem (VER-H1, kumulatywny VAT). Saldo brutto
      // śledzi zrealizowane brutto: prior = totalGross − remainingBefore.
      const { netMinor, vatMinor } = resolveIssuedNetVat(ent, input)
      const totalGross = netMinor + vatMinor

      const spend = await resolveRedeemSpend(
        tx,
        ent,
        input,
        totalGross
      )
      const {
        amount,
        remainingBefore,
        remainingAfter,
        priorRedeemedGross,
        outcome,
      } = spend

      // L3: walidacja spójności net/vat między ratami multi-installment (VER-H1).
      // Sprawdź czy issued_gross_minor z poprzedniej raty zgadza się z totalGross.
      // Niespójność (caller zmienił net/vat między ratami) ⇒ fail-closed.
      const anyPriorRedemption = await tx.findAnyRedemptionByEntitlementId(
        ent.id
      )
      if (
        anyPriorRedemption !== null &&
        anyPriorRedemption.issued_gross_minor !== totalGross
      ) {
        throw new RedeemAmountError(
          `redeem: niespójne wejście — totalGross (${totalGross}) różni się od ` +
            `wartości emisji z poprzedniej raty (${anyPriorRedemption.issued_gross_minor}); ` +
            `voucher_net_minor/voucher_vat_minor muszą być spójne we wszystkich ` +
            `ratach (VER-H1 fail-closed)`,
          amount,
          remainingBefore
        )
      }

      // Rynek jest FAKTEM ŚCIEŻKI PIENIĄDZA (AD-22), nie polem opcjonalnym:
      // brak rynku zakupu to ODMOWA zapisu, nie `'unknown'`. Rezolucja stoi
      // PRZED budową scope'u postingu, żeby ta sama wartość niosła oba użycia —
      // wcześniej scope domykał brak rynku literałem `"unknown"`, czyli
      // dokładnie wartością, którą migracja i producent nazywają zakazaną.
      // Kolejność jest tu częścią mechanizmu: odmowa zapada PRZED jakąkolwiek
      // mutacją stanu, a nie po niej.
      const markets = resolveRedemptionMarkets(ent, input)

      // L4: scope postingu dziedziczy vendor_id/location_id z entitlement_instance
      // (nie tylko z inputu callera). Zapis entitlementu jest źródłem prawdy.
      const scope: TransitionScope = {
        instance_id: ent.id,
        market_id: markets.market_id,
        sales_channel_id: input.sales_channel_id ?? ent.sales_channel_id ?? null,
        vendor_id: input.vendor_id ?? ent.vendor_id ?? null,
        location_id: input.location_id ?? ent.location_id ?? null,
      }
      const actor: TransitionActor = input.actor ?? "vendor"
      const actorHint = input.actor_hint ?? "vendor:redeem"
      const occurredAt = now.toISOString()
      const vatClassification =
        input.vat_classification ?? ent.vat_classification ?? "MPV"

      const wiringDeps = {
        appendAudit: tx.appendAudit.bind(tx),
        ...(this.deps.ledgerWriter
          ? { ledgerWriter: this.deps.ledgerWriter }
          : {}),
        ...(this.deps.postingActivation
          ? { postingActivation: this.deps.postingActivation }
          : {}),
        clock: () => now,
      }

      // ── Krok 1: <source> → REDEMPTION_REQUESTED (niefinansowy, audit-only) ──
      // Reużycie JEDNEGO punktu okablowania (3.4) — redeem to nowy CALLER, NIE
      // nowy ad-hoc wiring (anti-dispersja R1). Bez payloadu postingu.
      const step1 = await wireEntitlementTransitionPersisted(wiringDeps, {
        from: ent.state,
        to: EntitlementInstanceState.REDEMPTION_REQUESTED,
        entitlement_id: ent.id,
        scope,
        actor,
        actor_hint: actorHint,
        occurred_at: occurredAt,
        transition_seq: `${redemptionId}:request`,
      })
      await tx.updateEntitlementState(
        ent.id,
        ent.state,
        EntitlementInstanceState.REDEMPTION_REQUESTED,
        now
      )

      // ── L1: dedupe-first (ADR-139 D2/D3) — INSERT record PRZED postingiem ──
      // insertRedemption i updateRemaining POPRZEDZAJĄ posting hook (krok 2).
      // Zapobiega rozjazdowi state↔ledger po aktywacji: jeśli INSERT rzuci
      // (anomalia serializacji), rollback cofa mutacje stanu, a posting NIE nastąpił.

      // ── Reguła bilansu (ADR-178 §2.3) — FAIL-CLOSED PRZED INSERT-em ────────
      // CHECK tabelowy nie widzi agregatu, więc predykat musi być tutaj.
      const baseBefore = await tx.getCommissionBaseMinor(ent.id)
      assertCommissionBaseWithinBounds(
        ent.id,
        baseBefore + amount,
        totalGross
      )

      const record: RedemptionRecord = {
        entitlement_id: ent.id,
        idempotency_key: idempotencyKey,
        redemption_id: redemptionId,
        amount_minor: amount,
        choice_set_item_id: spend.choiceSetItemId ?? null,
        resulting_state: outcome,
        remaining_after_minor: remainingAfter,
        issued_gross_minor: totalGross,
        created_at: now.getTime(),
        kind: REDEMPTION_KIND_REDEMPTION,
        reverses_redemption_id: null,
        ...markets,
      }
      const ins = await tx.insertRedemption(record)
      if (!ins.inserted) {
        // Backstop: row-lock FOR UPDATE serializuje redeemy — ten konflikt = anomalia
        // serializacji. Fail-closed: RZUĆ (rollback. Retry trafi w replay).
        throw new RedeemAmountError(
          `redeem: konflikt dedupe (entitlement_id=${ent.id}, idempotency_key=` +
            `${idempotencyKey}) przed postingiem — rollback fail-closed`,
          amount,
          remainingBefore
        )
      }
      if (spend.choiceSetItemId) {
        await tx.consumeChoiceSetItem(spend.choiceSetItemId, redemptionId, now)
      }
      await tx.updateEntitlementRemainingAndState(
        ent.id,
        EntitlementInstanceState.REDEMPTION_REQUESTED,
        outcome,
        remainingAfter,
        now
      )

      // ── M6: PROJEKCJA po fakcie, w tej samej transakcji ───────────────────
      // Dopiero tutaj — wiersz kanoniczny już istnieje. Odwrotna kolejność
      // (dzisiejsza trasa: `voucher_event` bez kwoty i bez `redemption_id`)
      // pozwalała projekcji istnieć bez faktu, który projektuje.
      const projectionClient = tx.projectionClient()
      if (this.deps.writeProjection && projectionClient && input.voucher_code) {
        await this.deps.writeProjection(projectionClient, {
          voucher_code: input.voucher_code,
          entitlement_id: ent.id,
          now,
        })
      }

      // ── Krok 2: REDEMPTION_REQUESTED → REDEEMED_* (FINANSOWY: derecognition) ─
      // OSTATNIA operacja w tx (L1 fix): dedupe i saldo utrwalone PRZED postingiem.
      // Posting hook woła generateVoucherPosting() REDEEMED (2.3) → ledger-writer
      // (2.6). Derecognition PROPORCJONALNA (redeemed_gross_minor / to-date).
      // Bramkowany: runtime_enabled=false ⇒ audit-only/no-op (ZERO zapisu ledger).
      //
      // L2: expected_currency = waluta emisji z entitlementu (NIE tautologia).
      // Gdy issued_amount_currency=null (snapshot bez waluty): cofa się do currency
      // inputu (PLN-only bonbeauty — latent do czasu wzbogacenia snapshotu).
      const step2 = await wireEntitlementTransitionPersisted(wiringDeps, {
        from: EntitlementInstanceState.REDEMPTION_REQUESTED,
        to: outcome,
        entitlement_id: ent.id,
        scope,
        actor,
        actor_hint: actorHint,
        occurred_at: occurredAt,
        transition_seq: `${redemptionId}:redeem`,
        posting: {
          entitlement_type: ent.entitlement_type,
          lifecycle_event: "REDEEMED",
          vat_classification: vatClassification,
          net_minor: netMinor,
          vat_minor: vatMinor,
          redeemed_gross_minor: amount,
          redeemed_gross_to_date_minor: priorRedeemedGross,
          redemption_id: redemptionId,
          currency,
          expected_currency: ent.issued_amount_currency ?? currency,
        },
      })

      return {
        kind: "applied" as const,
        record,
        remainingBefore,
        availableChoiceSetItemIds: spend.availableChoiceSetItemIds,
        posting: step2.posting,
        events: [step1.event, step2.event],
      }
    })

    if (txOut.kind === "replay") {
      // Replay domeny: skutek pierwszego redeemu, ZERO ponownego obniżenia salda,
      // ZERO ponownego eventu/postingu (jeden derecognition posting, NIE podwaja).
      const rec = txOut.record
      const txId = deriveLedgerTransactionId({
        entitlement_id: rec.entitlement_id,
        lifecycle_event: "REDEEMED",
        redemption_id: rec.redemption_id,
      })
      return {
        entitlement_id: rec.entitlement_id,
        redemption_id: rec.redemption_id,
        outcome: rec.resulting_state,
        new_state: rec.resulting_state,
        amount_minor: rec.amount_minor,
        remaining_before_minor: rec.remaining_after_minor + rec.amount_minor,
        remaining_after_minor: rec.remaining_after_minor,
        ...(rec.choice_set_item_id
          ? { choice_set_item_id: rec.choice_set_item_id }
          : {}),
        // L7: BUNDLE replay zwraca aktualną listę dostępnych pozycji (pobrana w tx),
        // ujednolicając kształt wyniku ze ścieżką "applied" (AC2 „pozostałe pokazane").
        ...(txOut.replayAvailableChoiceSetItemIds !== undefined
          ? { available_choice_set_item_ids: txOut.replayAvailableChoiceSetItemIds }
          : {}),
        withdrawal_right_extinguished: isWithdrawalRightExtinguished(
          rec.resulting_state
        ),
        posting: {
          attempted: false,
          activated: false,
          persisted: false,
          deduped: true,
          transaction_id: txId,
          reason:
            "domain replay — redeem już zaksięgowany (idempotency_key+entitlement_id); jeden derecognition posting (NIE podwaja, AC2)",
        },
        idempotent: true,
        emit_failed: false,
      }
    }

    // Applied: emit eventów best-effort PO COMMIT (reconciliation-inwariant 2.6).
    let emitFailed = false
    for (const event of txOut.events) {
      const failed = await emitTransitionEventAfterCommit(
        this.deps.events.emit,
        event
      )
      emitFailed = emitFailed || failed
    }

    const rec = txOut.record
    return {
      entitlement_id: rec.entitlement_id,
      redemption_id: rec.redemption_id,
      outcome: rec.resulting_state,
      new_state: rec.resulting_state,
      amount_minor: rec.amount_minor,
      remaining_before_minor: txOut.remainingBefore,
      remaining_after_minor: rec.remaining_after_minor,
      ...(rec.choice_set_item_id
        ? { choice_set_item_id: rec.choice_set_item_id }
        : {}),
      ...(txOut.availableChoiceSetItemIds
        ? { available_choice_set_item_ids: txOut.availableChoiceSetItemIds }
        : {}),
      withdrawal_right_extinguished: isWithdrawalRightExtinguished(
        rec.resulting_state
      ),
      posting: txOut.posting,
      idempotent: false,
      emit_failed: emitFailed,
    }
  }

  /**
   * ZDARZENIE ODWRACAJĄCE realizację (ADR-178 §2.3) — nowy wiersz
   * `kind = 'REVERSAL'`, nigdy `DELETE`, nigdy `UPDATE` obniżający kwotę,
   * nigdy miękkie `deleted_at`. Ledger jest append-only, a posting już
   * zaksięgowany nie zniknie.
   *
   * Kontrakt, w całości pochodzący z ADR-178:
   *   - `idempotency_key` jest TEN SAM co odwracanej realizacji; rozróżnia je
   *     `kind` (dlatego `kind` jest w PK i w preimage `redemption_id`),
   *   - `amount_minor` jest DODATNIA — znak niesie `kind`, nie liczba (A7),
   *   - odwrócenie odwrócenia jest ODRZUCANE; cofnięcie zwrotu to nowa
   *     realizacja, nie podwójna negacja,
   *   - reguła bilansu jest sprawdzana FAIL-CLOSED PRZED `INSERT`-em,
   *   - `lifecycle_event` postingu to `REFUNDED`, a dyskryminatorem jest
   *     `redemption_id` WIERSZA ODWRACAJĄCEGO — inny niż realizacji, więc
   *     `ledger_posting_applied` nie wchłonie go jako replay.
   *
   * STAN UPRAWNIENIA PO ODWRÓCENIU (ADR-198). Odwrócenie prowadzi do
   * terminalnego `REFUNDED` **wyłącznie wtedy**, gdy domyka realizację:
   * `Σ REVERSAL == Σ REDEMPTION`. Przy odwróceniu CZĘŚCIOWYM (jedna rata z wielu)
   * uprawnienie wraca do `REDEEMED_PARTIAL`, bo pozostała realizacja stoi.
   * Wejście w `REFUNDED` po pierwszej racie zamykałoby uprawnienie na zawsze
   * (`ALLOWED[REFUNDED] = []`) i czyniło odwrócenie kolejnych rat strukturalnie
   * niewykonalnym — licznik prowizji nie miałby ścieżki zejścia do zera.
   *
   * Saldo NIE jest przywracane w ŻADNYM z tych przypadków (ADR-197 §2.5 / A4):
   * zwrot nie jest odblokowaniem, więc `REDEEMED_PARTIAL` nie nadaje tu nowej
   * realizowalności — przy `remaining = 0` redeem odmawia na saldzie.
   *
   * STAN KODU (v1.15.0 Story 5.9, review-fix cyklu 2 / C2-HIGH-2): odwrócenie
   * PEŁNE domyka uprawnienie do `REFUNDED`, więc kod vouchera schodzi na
   * `refunded` W TEJ SAMEJ transakcji, przez `tx.invalidateVoucherCode`.
   * Odwrócenie CZĘŚCIOWE zostawia `REDEEMED_PARTIAL` i kodu nie dotyka —
   * uprawnienie nadal żyje. Poprzednia treść tego akapitu („granica: należy do
   * Story 5.9") była prawdziwa do czasu, gdy 5.9 dołożyła fail-closed
   * w okablowaniu — od tamtej chwili ta ścieżka nie miała granicy, tylko
   * wyjątek na starcie.
   */
  async reverse(input: ReverseRedemptionInput): Promise<ReverseRedemptionResult> {
    const now = input.now ?? this.deps.clock?.() ?? new Date()
    const currency = input.currency ?? "PLN"

    const txOut = await this.deps.store.withTransaction(async (tx) => {
      const target = await tx.findRedemptionByRedemptionId(
        input.reverses_redemption_id
      )
      if (!target) {
        throw new ReversalTargetNotFoundError(input.reverses_redemption_id)
      }
      if (target.kind === REDEMPTION_KIND_REVERSAL) {
        throw new ReversalOfReversalError(input.reverses_redemption_id)
      }

      const ent = await tx.getEntitlementForUpdate(target.entitlement_id)
      if (!ent) throw new RedeemEntitlementNotFoundError(target.entitlement_id)

      // Odwrócenie cofa DOKŁADNIE tę podstawę VAT, którą rozpoznała realizacja.
      const reversalNetVat = resolveIssuedNetVat(ent, {
        voucher_net_minor: input.voucher_net_minor,
        voucher_vat_minor: input.voucher_vat_minor,
      })

      const reversalId = buildRedemptionId(
        target.entitlement_id,
        target.idempotency_key,
        REDEMPTION_KIND_REVERSAL
      )

      // Replay odwrócenia: TA SAMA trójka ⇒ no-op, nie drugi wiersz.
      const prior = await tx.findRedemption(
        target.entitlement_id,
        target.idempotency_key,
        REDEMPTION_KIND_REVERSAL
      )
      if (prior) {
        return { kind: "replay" as const, record: prior }
      }

      // Odmowa PRZED policzeniem totals i przed jakimkolwiek efektem ubocznym:
      // stan źródłowy musi mieć krawędź do REFUND_REQUESTED. Replay jest wyżej
      // celowo — powtórzone odwrócenie zamkniętego uprawnienia ma być no-opem,
      // nie odmową.
      if (
        !canTransition(ent.state, EntitlementInstanceState.REFUND_REQUESTED)
      ) {
        throw new RedemptionReversalStateError(ent.id, ent.state)
      }

      // ── Reguła bilansu PRZED INSERT-em ────────────────────────────────────
      const baseBefore = await tx.getCommissionBaseMinor(target.entitlement_id)
      assertCommissionBaseWithinBounds(
        target.entitlement_id,
        baseBefore - target.amount_minor,
        target.issued_gross_minor
      )

      // Σ realizacji / Σ odwróceń PRZED tym odwróceniem — posting odwracający
      // liczy VAT kumulatywnie-marginalnie i potrzebuje obu członów osobno.
      const priorTotals = await tx.getRedemptionGrossTotals(
        target.entitlement_id
      )

      // ── Stan docelowy odwrócenia (ADR-198) ────────────────────────────────
      // `REFUNDED` jest TERMINALNY (`ALLOWED[REFUNDED] = []`), więc wejście w
      // niego po odwróceniu PIERWSZEJ z wielu rat zamykało uprawnienie na
      // zawsze i czyniło odwrócenie drugiej raty strukturalnie niewykonalnym —
      // licznik prowizji nie miał ścieżki zejścia do zera. Odwrócenie domyka
      // uprawnienie WYŁĄCZNIE wtedy, gdy po nim `Σ REVERSAL == Σ REDEMPTION`.
      // Dopóki zostaje niezwrócona realizacja, uprawnienie wraca do
      // `REDEEMED_PARTIAL`: pozostała realizacja stoi, a saldo NIE jest
      // przywracane (ADR-197 §2.5 / A4), więc nie powstaje nowa realizowalność.
      const reversedAfter = priorTotals.reversed_minor + target.amount_minor
      const fullyReversed = reversedAfter >= priorTotals.redeemed_minor
      const reversalTargetState = fullyReversed
        ? EntitlementInstanceState.REFUNDED
        : EntitlementInstanceState.REDEEMED_PARTIAL

      // Symetria z guardem L3 realizacji: ta sama klasa wejścia, ta sama klasa
      // odmowy. Bez tego zawyżone rozbicie net/VAT od callera (np. 50000+11500
      // dla wiersza o brutto 12300) przechodziło i odwracało VAT policzony na
      // ZŁEJ PODSTAWIE — jedynym guardem było `reversedGross > totalGross`
      // w generatorze, czyli porównanie z brutto vouchera, nie z odwracanym
      // wierszem.
      const reversalGross = reversalNetVat.netMinor + reversalNetVat.vatMinor
      if (reversalGross !== target.issued_gross_minor) {
        throw new RedemptionBalanceError(
          `odwrócenie: niespójne wejście — rozbicie net/VAT (${reversalNetVat.netMinor}+` +
            `${reversalNetVat.vatMinor}=${reversalGross}) różni się od brutto emisji ` +
            `odwracanego wiersza (${target.issued_gross_minor}); odwrócenie cofa ` +
            "DOKŁADNIE tę podstawę, którą rozpoznała realizacja (fail-closed)"
        )
      }

      const scope: TransitionScope = {
        instance_id: ent.id,
        market_id: target.market_id,
        sales_channel_id: ent.sales_channel_id ?? null,
        vendor_id: ent.vendor_id ?? null,
        location_id: ent.location_id ?? null,
      }
      const actor: TransitionActor = input.actor ?? "system"
      const actorHint = input.actor_hint ?? "system:redemption-reversal"
      const occurredAt = now.toISOString()
      const vatClassification =
        input.vat_classification ?? ent.vat_classification ?? "MPV"

      const wiringDeps = {
        appendAudit: tx.appendAudit.bind(tx),
        // v1.15.0 Story 5.9 review-fix cyklu 2 (C2-HIGH-2): producent stanu
        // kodu MUSI tu być. `reversalTargetState` bywa `REFUNDED`, a
        // okablowanie fail-closuje PRZED jakimkolwiek efektem, gdy tranzycja
        // unieważniająca nie ma czym zejść na stan kodu. Bez tej linii
        // odwrócenie OSTATNIEJ niezwróconej raty — produkt Story 5.7 /
        // ADR-198, jedyna ścieżka zejścia licznika prowizji do zera —
        // wywracało się w całości.
        invalidateVoucherCode: tx.invalidateVoucherCode.bind(tx),
        ...(this.deps.ledgerWriter
          ? { ledgerWriter: this.deps.ledgerWriter }
          : {}),
        ...(this.deps.postingActivation
          ? { postingActivation: this.deps.postingActivation }
          : {}),
        clock: () => now,
      }

      // ── Krok 1: REDEEMED_* → REFUND_REQUESTED (niefinansowy) ──────────────
      const step1 = await wireEntitlementTransitionPersisted(wiringDeps, {
        from: ent.state,
        to: EntitlementInstanceState.REFUND_REQUESTED,
        entitlement_id: ent.id,
        scope,
        actor,
        actor_hint: actorHint,
        occurred_at: occurredAt,
        transition_seq: `${reversalId}:refund-request`,
      })
      await tx.updateEntitlementState(
        ent.id,
        ent.state,
        EntitlementInstanceState.REFUND_REQUESTED,
        now
      )

      // ── Wiersz ODWRACAJĄCY — dedupe-first, PRZED postingiem ───────────────
      // `resulting_state` niesie stan wynikowy ODWRACANEJ realizacji: CHECK
      // `voucher_redemption_resulting_state_check` (allow-lista
      // REDEEMED_PARTIAL/REDEEMED_FULL) jest zamrożony migracją 1778929000000,
      // a ADR-178 nie zmienia go dla odwrócenia. Kolumna odpowiada więc na
      // pytanie „co jest odwracane", a nie „w jakim stanie jest uprawnienie".
      const record: RedemptionRecord = {
        entitlement_id: target.entitlement_id,
        idempotency_key: target.idempotency_key,
        redemption_id: reversalId,
        amount_minor: target.amount_minor,
        resulting_state: target.resulting_state,
        // Zwrot NIE oddaje salda do ponownej realizacji — saldo uprawnienia
        // pozostaje takie, jakie jest po realizacji.
        remaining_after_minor: target.remaining_after_minor,
        issued_gross_minor: target.issued_gross_minor,
        created_at: now.getTime(),
        kind: REDEMPTION_KIND_REVERSAL,
        reverses_redemption_id: target.redemption_id,
        market_id: target.market_id,
        purchase_market_id: target.purchase_market_id,
        redemption_market_id: target.redemption_market_id,
      }
      const ins = await tx.insertRedemption(record)
      if (!ins.inserted) {
        throw new RedemptionBalanceError(
          `odwrócenie: konflikt dedupe (entitlement_id=${target.entitlement_id}, ` +
            `idempotency_key=${target.idempotency_key}, kind=REVERSAL) przed ` +
            "postingiem — rollback fail-closed"
        )
      }

      await tx.updateEntitlementState(
        ent.id,
        EntitlementInstanceState.REFUND_REQUESTED,
        reversalTargetState,
        now
      )

      // ── Krok 2: REFUND_REQUESTED → REFUNDED|REDEEMED_PARTIAL (FINANSOWY) ──
      // `lifecycle_event` postingu zostaje `REFUNDED` NIEZALEŻNIE od stanu
      // docelowego: klasa zdarzenia księgowego to „odwrócenie realizacji", a nie
      // „uprawnienie się domknęło". Okablowanie nie sprzęga `to` z
      // `lifecycle_event` (dyskryminatorem dedupe jest `redemption_id` wiersza
      // odwracającego), więc rozróżnienie zostaje w jednym miejscu.
      const step2 = await wireEntitlementTransitionPersisted(wiringDeps, {
        from: EntitlementInstanceState.REFUND_REQUESTED,
        to: reversalTargetState,
        entitlement_id: ent.id,
        scope,
        actor,
        actor_hint: actorHint,
        occurred_at: occurredAt,
        transition_seq: `${reversalId}:reversal`,
        posting: {
          entitlement_type: ent.entitlement_type,
          lifecycle_event: "REFUNDED",
          vat_classification: vatClassification,
          net_minor: reversalNetVat.netMinor,
          vat_minor: reversalNetVat.vatMinor,
          reversed_gross_minor: target.amount_minor,
          reversed_gross_to_date_minor: priorTotals.reversed_minor,
          redeemed_gross_total_minor: priorTotals.redeemed_minor,
          // Dyskryminator = redemption_id WIERSZA ODWRACAJĄCEGO (ADR-178 §2.3).
          redemption_id: reversalId,
          currency,
          expected_currency: ent.issued_amount_currency ?? currency,
        },
      })

      const baseAfter = await tx.getCommissionBaseMinor(target.entitlement_id)

      return {
        kind: "applied" as const,
        record,
        reversed: target,
        commissionBaseBefore: baseBefore,
        commissionBaseAfter: baseAfter,
        entitlementStateAfter: reversalTargetState,
        fullyReversed,
        codeInvalidationOutcome: step2.invalidation?.outcome,
        posting: step2.posting,
        events: [step1.event, step2.event],
      }
    })

    if (txOut.kind === "replay") {
      return {
        entitlement_id: txOut.record.entitlement_id,
        redemption_id: txOut.record.redemption_id,
        reverses_redemption_id: txOut.record.reverses_redemption_id ?? null,
        amount_minor: txOut.record.amount_minor,
        idempotent: true,
        posting: {
          attempted: false,
          activated: false,
          persisted: false,
          deduped: true,
          transaction_id: deriveLedgerTransactionId({
            entitlement_id: txOut.record.entitlement_id,
            lifecycle_event: "REFUNDED",
            redemption_id: txOut.record.redemption_id,
          }),
          reason:
            "domain replay — odwrócenie już zaksięgowane (entitlement+key+REVERSAL)",
        },
        emit_failed: false,
      }
    }

    let emitFailed = false
    for (const event of txOut.events) {
      const failed = await emitTransitionEventAfterCommit(
        this.deps.events.emit,
        event
      )
      emitFailed = emitFailed || failed
    }

    return {
      entitlement_id: txOut.record.entitlement_id,
      redemption_id: txOut.record.redemption_id,
      reverses_redemption_id: txOut.record.reverses_redemption_id ?? null,
      amount_minor: txOut.record.amount_minor,
      commission_base_before_minor: txOut.commissionBaseBefore,
      commission_base_after_minor: txOut.commissionBaseAfter,
      entitlement_state_after: txOut.entitlementStateAfter,
      fully_reversed: txOut.fullyReversed,
      ...(txOut.codeInvalidationOutcome
        ? { code_invalidation_outcome: txOut.codeInvalidationOutcome }
        : {}),
      idempotent: false,
      posting: txOut.posting,
      emit_failed: emitFailed,
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Postgres store (production wiring)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Kolumny kanonicznej czytane przez producenta. Jedna lista dla wszystkich
 * odczytów — rozjazd między `findRedemption` a `findRedemptionByRedemptionId`
 * byłby cichym brakiem `kind` w replayu.
 */
const REDEMPTION_COLUMNS = `entitlement_id, idempotency_key, redemption_id, amount_minor,
              resulting_state, remaining_after_minor, issued_gross_minor, created_at,
              kind, reverses_redemption_id, market_id, purchase_market_id,
              redemption_market_id`

/**
 * `Number(...)` na kolumnach `bigint` NIE jest ozdobnikiem: w repo NIE MA
 * `setTypeParser`, więc `int8` wraca z `node-pg` jako STRING. Każda asercja
 * porównująca surowy `row.amount_minor` z liczbą przeszłaby na atrapie puli
 * (JS-owe liczby) i pękła na realnej bazie — to jest ten sam mechanizm, który
 * w ADR-166 dał zielony test przy błędnym typie kolumny.
 */
/**
 * Wiersz `entitlement_instance` → kontrakt operacji. Wydzielone z
 * `getEntitlementForUpdate`, bo most kod → uprawnienie (M1) czyta TE SAME
 * kolumny; druga kopia mapowania rozjechałaby się przy pierwszej zmianie.
 */
function mapEntitlementRow(
  row: Record<string, unknown>
): RedeemableAmountEntitlement {
  const rawSnapshot = row.policy_snapshot
  if (
    rawSnapshot === null ||
    rawSnapshot === undefined ||
    typeof rawSnapshot !== "object" ||
    Array.isArray(rawSnapshot)
  ) {
    throw new Error(
      `entitlement_instance ${row.id as string}: policy_snapshot nie jest obiektem`
    )
  }
  const snap = rawSnapshot as Record<string, unknown>
  return {
    id: row.id as string,
    entitlement_type: row.entitlement_type as EntitlementType,
    state: row.state as EntitlementInstanceState,
    remaining_amount:
      row.remaining_amount != null ? Number(row.remaining_amount) : null,
    policy_snapshot: snapshotPolicy(snap),
    vat_classification:
      (row.vat_classification ?? null) as VatClassification | null,
    // L2: waluta emisji z policy_snapshot (źródło prawdy dla currency guard writera).
    issued_amount_currency:
      typeof snap.currency_code === "string" ? snap.currency_code : null,
    market_id: (row.market_id ?? null) as string | null,
    sales_channel_id: (row.sales_channel_id ?? null) as string | null,
    vendor_id: (row.vendor_id ?? null) as string | null,
    location_id: (row.location_id ?? null) as string | null,
    recipient_customer_id: (row.recipient_customer_id ?? null) as string | null,
  }
}

function mapRedemptionRow(row: Record<string, unknown>): RedemptionRecord {
  return {
    entitlement_id: row.entitlement_id as string,
    idempotency_key: row.idempotency_key as string,
    redemption_id: row.redemption_id as string,
    amount_minor: Number(row.amount_minor),
    resulting_state: row.resulting_state as RedeemOutcome,
    remaining_after_minor: Number(row.remaining_after_minor),
    issued_gross_minor: Number(row.issued_gross_minor),
    created_at: Number(row.created_at),
    kind: row.kind as RedemptionKind,
    reverses_redemption_id: (row.reverses_redemption_id ?? null) as string | null,
    market_id: row.market_id as string,
    purchase_market_id: row.purchase_market_id as string,
    redemption_market_id: row.redemption_market_id as string,
  }
}

type QueryResult<T> = Promise<{ rows: T[]; rowCount?: number | null }>
/**
 * v1.15.0 Story 5.7: kształt klienta jest tu ROZLUŹNIONY do wspólnego mianownika
 * `pg.PoolClient` i `RlsPoolClient` (`lib/rls-connection-source.ts`, Story 2.6).
 * Producent kanonicznej MUSI dać się zbudować nad nośnikiem połączeń modułu —
 * własna pula byłaby drugim nośnikiem kontekstu rynku (AD-21 §4) i pod
 * `FORCE RLS` nie zobaczyłaby ani jednego wiersza. `release(err?)` jest
 * opcjonalnym argumentem, bo w `pg` znaczy „zniszcz to połączenie".
 */
type PgClient = {
  query: <T extends Record<string, any> = Record<string, any>>(
    text: string,
    values?: any[]
  ) => QueryResult<T>
  release: (err?: unknown) => void
}
type PgPool = { connect: () => Promise<PgClient> }

type BorrowedPgClient = Pick<PgClient, "query">

export const VOUCHER_REDEMPTION_TABLE = "voucher_redemption" as const

export class PostgresRedeemPartialStore implements RedeemPartialStore {
  constructor(private readonly pool: PgPool) {}

  async withTransaction<T>(
    fn: (tx: RedeemPartialTx) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const result = await fn(new PostgresRedeemPartialTx(client))
      await client.query("COMMIT")
      return result
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  }
}

class PostgresRedeemPartialTx implements RedeemPartialTx {
  constructor(private readonly client: BorrowedPgClient) {}

  async getEntitlementForUpdate(
    id: string
  ): Promise<RedeemableAmountEntitlement | null> {
    // L4: SELECT zawiera vendor_id/location_id (dziedziczone do scope postingu).
    const res = await this.client.query<Record<string, unknown>>(
      // v1.15.0 Story 5.7 — ZMIERZONE, nie założone: `entitlement_instance` NIE MA
      // kolumn `vendor_id` ani `location_id` (żadna migracja modułu ich nie dodaje;
      // niosą je dopiero tabele ledgera z `1778927000000`). Ten SELECT wywracał się
      // na `column "vendor_id" does not exist` na realnym Postgresie — i nikt tego
      // nie widział, bo producent był MARTWY, a testy jechały na store'ze in-memory.
      // To jest bezpośredni dowód dowodu (a) z ADR-178. Scope postingu bierze więc
      // `vendor_id`/`location_id` z INPUTU wołającego (trasa zna sprzedawcę).
      // Zawężenie analogicznych SELECT-ów w `refund-entitlement.ts` i
      // `expire-entitlement.ts` (ten sam defekt, te same martwe ścieżki) jest poza
      // zakresem 5.7 — patrz rejestr zaległości.
      `SELECT id, entitlement_type, state, remaining_amount, policy_snapshot,
              vat_classification, market_id, sales_channel_id,
              recipient_customer_id
         FROM entitlement_instance
        WHERE id = $1
        FOR UPDATE`,
      [id]
    )
    const row = res.rows[0]
    if (!row) return null
    return mapEntitlementRow(row)
  }

  /**
   * MOST kod → uprawnienie (ADR-178 §2.2 M1), rozwiązany POD `FOR UPDATE`
   * w tej samej transakcji co reszta realizacji.
   *
   * Wiązanie w danych jest jedno: `entitlement_instance.policy_snapshot->>
   * 'voucher_code'` (zapisywane przy emisji przez
   * `workflows/entitlements/live-issue-from-payment-intent.ts`). Drugim
   * kandydatem był `voucher_event(voucher_code, entitlement_id)`, ale ADR-178
   * jawnie nie chce LOGU jako kanonicznego źródła rezolucji.
   *
   * ZERO `LIMIT` i zero `ORDER BY … LIMIT 1`: to jest różnica względem
   * `VoucherService.findBuyerClaimSource`, która CZYTA (i tam „pierwszy
   * najnowszy" jest dopuszczalny), podczas gdy tutaj obciążane jest saldo.
   */
  async resolveEntitlementsByVoucherCodeForUpdate(
    voucherCode: string
  ): Promise<RedeemableAmountEntitlement[]> {
    const res = await this.client.query<Record<string, unknown>>(
      // v1.15.0 Story 5.7 — ZMIERZONE, nie założone: `entitlement_instance` NIE MA
      // kolumn `vendor_id` ani `location_id` (żadna migracja modułu ich nie dodaje;
      // niosą je dopiero tabele ledgera z `1778927000000`). Ten SELECT wywracał się
      // na `column "vendor_id" does not exist` na realnym Postgresie — i nikt tego
      // nie widział, bo producent był MARTWY, a testy jechały na store'ze in-memory.
      // To jest bezpośredni dowód dowodu (a) z ADR-178. Scope postingu bierze więc
      // `vendor_id`/`location_id` z INPUTU wołającego (trasa zna sprzedawcę).
      // Zawężenie analogicznych SELECT-ów w `refund-entitlement.ts` i
      // `expire-entitlement.ts` (ten sam defekt, te same martwe ścieżki) jest poza
      // zakresem 5.7 — patrz rejestr zaległości.
      `SELECT id, entitlement_type, state, remaining_amount, policy_snapshot,
              vat_classification, market_id, sales_channel_id,
              recipient_customer_id
         FROM entitlement_instance
        WHERE policy_snapshot->>'voucher_code' = $1
        ORDER BY id
        FOR UPDATE`,
      [voucherCode]
    )
    return res.rows.map((row) => mapEntitlementRow(row))
  }

  async findRedemption(
    entitlementId: string,
    idempotencyKey: string,
    kind: RedemptionKind
  ): Promise<RedemptionRecord | null> {
    const res = await this.client.query<Record<string, unknown>>(
      `SELECT ${REDEMPTION_COLUMNS}
         FROM ${VOUCHER_REDEMPTION_TABLE}
        WHERE entitlement_id = $1 AND idempotency_key = $2 AND kind = $3`,
      [entitlementId, idempotencyKey, kind]
    )
    const row = res.rows[0]
    if (!row) return null
    return mapRedemptionRow(row)
  }

  async findRedemptionByRedemptionId(
    redemptionId: string
  ): Promise<RedemptionRecord | null> {
    const res = await this.client.query<Record<string, unknown>>(
      `SELECT ${REDEMPTION_COLUMNS}
         FROM ${VOUCHER_REDEMPTION_TABLE}
        WHERE redemption_id = $1`,
      [redemptionId]
    )
    const row = res.rows[0]
    if (!row) return null
    return mapRedemptionRow(row)
  }

  /** WYKONANIE zapytania licznika z ADR-178 §2.3 — nie własnej wersji. */
  async getCommissionBaseMinor(entitlementId: string): Promise<number> {
    const res = await this.client.query<Record<string, unknown>>(
      COMMISSION_BASE_QUERY,
      [entitlementId]
    )
    return Number(res.rows[0]?.commission_base_minor ?? 0)
  }

  async getRedemptionGrossTotals(
    entitlementId: string
  ): Promise<RedemptionGrossTotals> {
    const res = await this.client.query<Record<string, unknown>>(
      REDEMPTION_GROSS_TOTALS_QUERY,
      [entitlementId]
    )
    // `bigint` wraca z node-pg STRINGiem (ADR-166) — `Number` jest tu jawny.
    return {
      redeemed_minor: Number(res.rows[0]?.redeemed_minor ?? 0),
      reversed_minor: Number(res.rows[0]?.reversed_minor ?? 0),
    }
  }

  async findAnyRedemptionByEntitlementId(
    entitlementId: string
  ): Promise<RedemptionRecord | null> {
    const res = await this.client.query<Record<string, unknown>>(
      `SELECT ${REDEMPTION_COLUMNS}
         FROM ${VOUCHER_REDEMPTION_TABLE}
        WHERE entitlement_id = $1
        LIMIT 1`,
      [entitlementId]
    )
    const row = res.rows[0]
    if (!row) return null
    return mapRedemptionRow(row)
  }

  async getChoiceSetItemsForUpdate(
    entitlementId: string
  ): Promise<RedeemableChoiceSetItem[]> {
    const res = await this.client.query<Record<string, unknown>>(
      `SELECT id, instance_id, market_id, reference_amount_minor,
              remaining_minor, status, redemption_id
         FROM entitlement_choice_set_item
        WHERE instance_id = $1
        ORDER BY id
        FOR UPDATE`,
      [entitlementId]
    )
    return res.rows.map((row) => ({
      id: row.id as string,
      instance_id: row.instance_id as string,
      market_id: row.market_id as string,
      reference_amount_minor: Number(row.reference_amount_minor),
      remaining_minor: Number(row.remaining_minor),
      status: row.status as "ACTIVE" | "REDEEMED",
      redemption_id: (row.redemption_id ?? null) as string | null,
    }))
  }

  async insertRedemption(
    record: RedemptionRecord
  ): Promise<{ inserted: boolean }> {
    // JEDYNY writer kanonicznej (ADR-178 §2.2 / A2). `ON CONFLICT` celuje
    // w PK ROZSZERZONY O `kind` (migracja 1779004000000): bez tego członu
    // odwrócenie o tym samym `idempotency_key` co realizacja zostałoby
    // wchłonięte jako replay i licznik prowizji NIGDY BY NIE ZSZEDŁ.
    const res = await this.client.query(
      `INSERT INTO ${VOUCHER_REDEMPTION_TABLE}
         (entitlement_id, idempotency_key, redemption_id, amount_minor,
          resulting_state, remaining_after_minor, issued_gross_minor, created_at,
          kind, reverses_redemption_id, market_id, purchase_market_id,
          redemption_market_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (entitlement_id, idempotency_key, kind) DO NOTHING`,
      [
        record.entitlement_id,
        record.idempotency_key,
        record.redemption_id,
        record.amount_minor,
        record.resulting_state,
        record.remaining_after_minor,
        record.issued_gross_minor,
        record.created_at,
        record.kind,
        record.reverses_redemption_id ?? null,
        record.market_id,
        record.purchase_market_id,
        record.redemption_market_id,
      ]
    )
    return { inserted: (res.rowCount ?? 0) === 1 }
  }

  async updateEntitlementState(
    id: string,
    fromState: EntitlementInstanceState,
    toState: EntitlementInstanceState,
    now: Date
  ): Promise<void> {
    const res = await this.client.query(
      `UPDATE entitlement_instance
          SET state = $3, updated_at = $4
        WHERE id = $1 AND state = $2`,
      [id, fromState, toState, now]
    )
    if ((res.rowCount ?? 0) !== 1) {
      throw new Error(
        `updateEntitlementState ${id}: ${fromState}→${toState} affected ` +
          `${res.rowCount ?? 0} rows (expected 1)`
      )
    }
  }

  async updateEntitlementRemainingAndState(
    id: string,
    fromState: EntitlementInstanceState,
    toState: RedeemOutcome,
    remainingAfter: number,
    now: Date
  ): Promise<void> {
    const res = await this.client.query(
      `UPDATE entitlement_instance
          SET state = $3, remaining_amount = $4, updated_at = $5
        WHERE id = $1 AND state = $2`,
      [id, fromState, toState, remainingAfter, now]
    )
    if ((res.rowCount ?? 0) !== 1) {
      throw new Error(
        `updateEntitlementRemainingAndState ${id}: ${fromState}→${toState} ` +
          `affected ${res.rowCount ?? 0} rows (expected 1)`
      )
    }
  }

  async consumeChoiceSetItem(
    id: string,
    redemptionId: string,
    now: Date
  ): Promise<void> {
    const res = await this.client.query(
      `UPDATE entitlement_choice_set_item
          SET remaining_minor = 0,
              status = 'REDEEMED',
              redemption_id = $2,
              updated_at = $3
        WHERE id = $1
          AND status = 'ACTIVE'
          AND remaining_minor > 0`,
      [id, redemptionId, now]
    )
    if ((res.rowCount ?? 0) !== 1) {
      throw new RedeemChoiceSetItemError(
        `consumeChoiceSetItem ${id}: affected ${res.rowCount ?? 0} rows (expected 1)`
      )
    }
  }

  /** Klient TEJ transakcji — projekcja M6 idzie tą samą drogą co fakt. */
  projectionClient(): ProjectionQueryable {
    return this.client
  }

  async appendAudit(audit: TransitionAuditEnvelope): Promise<void> {
    // Append-only audit envelope (niemutowalny ślad) do voucher_event, spójnie z
    // istniejącymi emiterami service.ts (id, voucher_code NULL, entitlement_id,
    // event_type, payload jsonb). Atomowy ze zmianą stanu (ta sama tx).
    // L5: occurred_at z envelope (czas zdarzenia, nie zegar DB). created_at = NOW()
    // (czas zapisu do DB — może różnić się od occurred_at przy retry/replay).
    await this.client.query(
      `INSERT INTO voucher_event (id, voucher_code, entitlement_id, event_type, payload, occurred_at, created_at)
       VALUES ($1, NULL, $2, $3, $4::jsonb, $5, NOW())`,
      [
        audit.idempotency_key,
        audit.entitlement_id,
        audit.event_type,
        JSON.stringify(audit),
        audit.occurred_at,
      ]
    )
  }

  /**
   * v1.15.0 Story 5.9 (AC2/AC3): delegacja do JEDYNEGO producenta stanu kodu
   * na `this.client` — bez własnego `connect()`, `BEGIN` i `COMMIT`.
   */
  async invalidateVoucherCode(input: {
    entitlement_id: string
    to_state: EntitlementInstanceState
    now: Date
  }): Promise<VoucherCodeInvalidationResult> {
    return invalidateVoucherCode(this.client, input)
  }
}

class BorrowedTransactionRedeemPartialStore implements RedeemPartialStore {
  constructor(private readonly client: BorrowedPgClient) {}

  async withTransaction<T>(
    fn: (tx: RedeemPartialTx) => Promise<T>
  ): Promise<T> {
    return fn(new PostgresRedeemPartialTx(this.client))
  }
}

// ──────────────────────────────────────────────────────────────────────────
// In-memory store (testing) — mirror semantyki PG (ON CONFLICT DO NOTHING)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Klucz atrapy MUSI odwzorowywać PK Z MIGRACJI — trójkę z `kind`. Dwuczłonowy
 * klucz w atrapie dawałby zieloną idempotencję na scenariuszu, który na realnej
 * bazie tworzy DRUGI wiersz (albo odwrotnie) — czyli dokładnie tę klasę
 * fałszywej zieleni, którą AI-2.2 dyskwalifikuje.
 */
function inMemoryRedemptionKey(
  entitlementId: string,
  idempotencyKey: string,
  kind: RedemptionKind
): string {
  return JSON.stringify([entitlementId, idempotencyKey, kind])
}

export class InMemoryRedeemPartialStore implements RedeemPartialStore {
  private rows: Map<string, RedeemableAmountEntitlement>
  private redemptions: Map<string, RedemptionRecord>
  private choiceSetItems: Map<string, RedeemableChoiceSetItem>
  private audits: TransitionAuditEnvelope[]
  private codes: Map<string, VoucherStatus>

  constructor(
    rows: RedeemableAmountEntitlement[] = [],
    choiceSetItems: RedeemableChoiceSetItem[] = [],
    /** v1.15.0 Story 5.9 review-fix cyklu 2: stany kodów — `kod → status`. */
    codes: Record<string, VoucherStatus> = {}
  ) {
    this.rows = new Map(rows.map((r) => [r.id, { ...r }]))
    this.redemptions = new Map()
    this.choiceSetItems = new Map(choiceSetItems.map((i) => [i.id, { ...i }]))
    this.audits = []
    this.codes = new Map(Object.entries(codes))
    // Kody z fixture'ów rejestrowane jako `idle`, chyba że wołający poda inny
    // stan — dokładnie jak w `InMemoryExpireEntitlementStore`. Bez tego każdy
    // zastany test z voucherem KWOTOWYM przewracałby się na
    // `VoucherCodeBridgeMissingError`, czyli na twierdzeniu o braku mostu,
    // a nie o zachowaniu, które test bada.
    for (const row of this.rows.values()) {
      const snap = (row.policy_snapshot ?? {}) as Record<string, unknown>
      const code = typeof snap.voucher_code === "string" ? snap.voucher_code : null
      if (code && !this.codes.has(code)) {
        this.codes.set(code, "idle")
      }
    }
  }

  get(id: string): RedeemableAmountEntitlement | undefined {
    return this.rows.get(id)
  }

  /** Stan kodu po operacji — do asercji AC3 (oba wiersze, nie tylko jeden). */
  getVoucherStatus(code: string): VoucherStatus | undefined {
    return this.codes.get(code)
  }

  listRedemptions(): RedemptionRecord[] {
    return [...this.redemptions.values()]
  }

  listChoiceSetItems(): RedeemableChoiceSetItem[] {
    return [...this.choiceSetItems.values()]
  }

  /** Append-only audyty utrwalone (po COMMIT) — do asercji AC1/AC2 w testach. */
  listAudits(): TransitionAuditEnvelope[] {
    return [...this.audits]
  }

  async withTransaction<T>(
    fn: (tx: RedeemPartialTx) => Promise<T>
  ): Promise<T> {
    const rowsSnapshot = new Map(
      [...this.rows.entries()].map(([id, r]) => [id, { ...r }])
    )
    const redemptionsSnapshot = new Map(
      [...this.redemptions.entries()].map(([k, r]) => [k, { ...r }])
    )
    const choiceSetSnapshot = new Map(
      [...this.choiceSetItems.entries()].map(([k, r]) => [k, { ...r }])
    )
    const auditsLen = this.audits.length
    // v1.15.0 Story 5.9: stany kodów WCHODZĄ do migawki rollbacku.
    const codesSnapshot = new Map(this.codes)
    try {
      return await fn(
        new InMemoryRedeemPartialTx(
          this.rows,
          this.redemptions,
          this.choiceSetItems,
          this.audits,
          this.codes
        )
      )
    } catch (err) {
      // Rollback: przywróć migawki + odetnij audyty tej tx (fail-closed — ZERO
      // efektów ubocznych na odrzuconej ścieżce, AC2).
      this.rows = rowsSnapshot
      this.redemptions = redemptionsSnapshot
      this.choiceSetItems = choiceSetSnapshot
      this.audits.length = auditsLen
      this.codes = codesSnapshot
      throw err
    }
  }
}

class InMemoryRedeemPartialTx implements RedeemPartialTx {
  constructor(
    private readonly rows: Map<string, RedeemableAmountEntitlement>,
    private readonly redemptions: Map<string, RedemptionRecord>,
    private readonly choiceSetItems: Map<string, RedeemableChoiceSetItem>,
    private readonly audits: TransitionAuditEnvelope[],
    private readonly codes: Map<string, VoucherStatus> = new Map()
  ) {}

  /**
   * v1.15.0 Story 5.9 review-fix cyklu 2: mirror semantyki producenta — ta sama
   * REGUŁA (`decideVoucherCodeInvalidation`), nie druga jej kopia. Mirror pisany
   * drugi raz rozjeżdża się cicho, a wtedy zielony test jednostkowy przestaje
   * mówić cokolwiek o zachowaniu produkcyjnym.
   */
  async invalidateVoucherCode(input: {
    entitlement_id: string
    to_state: EntitlementInstanceState
    now: Date
  }): Promise<VoucherCodeInvalidationResult> {
    const row = this.rows.get(input.entitlement_id)
    const snapshot = (row?.policy_snapshot ?? {}) as Record<string, unknown>
    const code =
      typeof snapshot.voucher_code === "string" ? snapshot.voucher_code : null
    const decision = decideVoucherCodeInvalidation({
      entitlement_id: input.entitlement_id,
      entitlement_type: row?.entitlement_type ?? null,
      voucher_code: code,
      current_status: code ? this.codes.get(code) ?? null : null,
      to_state: input.to_state,
    })
    if (decision.outcome === "invalidated" && decision.voucher_code) {
      this.codes.set(decision.voucher_code, decision.target_status)
    }
    return decision
  }

  async getEntitlementForUpdate(
    id: string
  ): Promise<RedeemableAmountEntitlement | null> {
    const row = this.rows.get(id)
    if (!row) return null
    // L2: derywuj issued_amount_currency z policy_snapshot.currency_code jeśli brak
    // explicite ustawionego pola (testy mogą override przez makeEntitlement).
    const snap = row.policy_snapshot as Record<string, unknown>
    const derivedCurrency =
      typeof snap.currency_code === "string" ? snap.currency_code : null
    return {
      ...row,
      issued_amount_currency:
        row.issued_amount_currency !== undefined
          ? row.issued_amount_currency
          : derivedCurrency,
    }
  }

  async resolveEntitlementsByVoucherCodeForUpdate(
    voucherCode: string
  ): Promise<RedeemableAmountEntitlement[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          (row.policy_snapshot as Record<string, unknown>)?.voucher_code ===
          voucherCode
      )
      .map((row) => ({ ...row }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  async findRedemption(
    entitlementId: string,
    idempotencyKey: string,
    kind: RedemptionKind
  ): Promise<RedemptionRecord | null> {
    const r = this.redemptions.get(
      inMemoryRedemptionKey(entitlementId, idempotencyKey, kind)
    )
    return r ? { ...r } : null
  }

  async findRedemptionByRedemptionId(
    redemptionId: string
  ): Promise<RedemptionRecord | null> {
    for (const record of this.redemptions.values()) {
      if (record.redemption_id === redemptionId) return { ...record }
    }
    return null
  }

  async getCommissionBaseMinor(entitlementId: string): Promise<number> {
    let base = 0
    for (const record of this.redemptions.values()) {
      if (record.entitlement_id !== entitlementId) continue
      base +=
        record.kind === REDEMPTION_KIND_REVERSAL
          ? -record.amount_minor
          : record.amount_minor
    }
    return base
  }

  async getRedemptionGrossTotals(
    entitlementId: string
  ): Promise<RedemptionGrossTotals> {
    const totals: RedemptionGrossTotals = {
      redeemed_minor: 0,
      reversed_minor: 0,
    }
    for (const record of this.redemptions.values()) {
      if (record.entitlement_id !== entitlementId) continue
      if (record.kind === REDEMPTION_KIND_REVERSAL) {
        totals.reversed_minor += record.amount_minor
      } else {
        totals.redeemed_minor += record.amount_minor
      }
    }
    return totals
  }

  async findAnyRedemptionByEntitlementId(
    entitlementId: string
  ): Promise<RedemptionRecord | null> {
    for (const record of this.redemptions.values()) {
      if (record.entitlement_id === entitlementId) return { ...record }
    }
    return null
  }

  async getChoiceSetItemsForUpdate(
    entitlementId: string
  ): Promise<RedeemableChoiceSetItem[]> {
    return [...this.choiceSetItems.values()]
      .filter((item) => item.instance_id === entitlementId)
      .map((item) => ({ ...item }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  async insertRedemption(
    record: RedemptionRecord
  ): Promise<{ inserted: boolean }> {
    const key = inMemoryRedemptionKey(
      record.entitlement_id,
      record.idempotency_key,
      record.kind
    )
    if (this.redemptions.has(key)) return { inserted: false }
    this.redemptions.set(key, { ...record })
    return { inserted: true }
  }

  async updateEntitlementState(
    id: string,
    fromState: EntitlementInstanceState,
    toState: EntitlementInstanceState,
    _now: Date
  ): Promise<void> {
    const row = this.rows.get(id)
    if (!row || row.state !== fromState) {
      throw new Error(
        `updateEntitlementState ${id}: expected ${fromState}, got ${row?.state ?? "not found"}`
      )
    }
    this.rows.set(id, { ...row, state: toState })
    void _now
  }

  async updateEntitlementRemainingAndState(
    id: string,
    fromState: EntitlementInstanceState,
    toState: RedeemOutcome,
    remainingAfter: number,
    _now: Date
  ): Promise<void> {
    const row = this.rows.get(id)
    if (!row || row.state !== fromState) {
      throw new Error(
        `updateEntitlementRemainingAndState ${id}: expected ${fromState}, got ${row?.state ?? "not found"}`
      )
    }
    this.rows.set(id, {
      ...row,
      state: toState,
      remaining_amount: remainingAfter,
    })
    void _now
  }

  async consumeChoiceSetItem(
    id: string,
    redemptionId: string,
    _now: Date
  ): Promise<void> {
    const item = this.choiceSetItems.get(id)
    if (!item || item.status !== "ACTIVE" || item.remaining_minor <= 0) {
      throw new RedeemChoiceSetItemError(
        `consumeChoiceSetItem ${id}: expected ACTIVE item with remaining > 0`
      )
    }
    this.choiceSetItems.set(id, {
      ...item,
      status: "REDEEMED",
      remaining_minor: 0,
      redemption_id: redemptionId,
    })
    void _now
  }

  /**
   * Atrapa NIE MA transakcji SQL, więc nie może udawać, że projekcja przez nią
   * przeszła. `null` jest tu uczciwą odpowiedzią: projekcja M6 jest dowodzona
   * wyłącznie na realnym Postgresie.
   */
  projectionClient(): ProjectionQueryable | null {
    return null
  }

  async appendAudit(audit: TransitionAuditEnvelope): Promise<void> {
    // Append-only — odzwierciedla INSERT do voucher_event (PG). Rollback tx
    // odcina audyty w withTransaction (fail-closed, AC2).
    this.audits.push(audit)
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Factory (production container wiring)
// ──────────────────────────────────────────────────────────────────────────

type EventBusLike = {
  emit?: (message: {
    name: string
    data: TransitionEventEnvelope
  }) => Promise<unknown>
}

/**
 * Buduje operację z kontenera. KRYTYCZNE: bramka aktywacji NIE jest wstrzykiwana
 * ⇒ używana jest `defaultPostingActivationGate()` (czyta REALNĄ `runtime_enabled`
 * = false). Posting derecognition jest WIĘC audit-only/no-op w produkcji do czasu
 * ręcznej aktywacji P6/E6 (NIE flipujemy tu nic).
 */
export function createRedeemPartialOperationFromPool(
  pool: PgPool,
  extra: Partial<Omit<RedeemPartialDeps, "store">> = {}
): RedeemPartialEntitlementOperation {
  return new RedeemPartialEntitlementOperation({
    store: new PostgresRedeemPartialStore(pool),
    events: { async emit() {} },
    ...extra,
  })
}

/**
 * Buduje operację nad transakcją należącą do wołającego. Adapter nie otwiera,
 * nie zatwierdza i nie zwalnia połączenia, więc reversal może być atomowy z
 * webhookiem refundu, który już utrzymuje blokady `FOR UPDATE`.
 */
export function createRedeemPartialOperationFromTransaction(
  client: BorrowedPgClient,
  extra: Partial<Omit<RedeemPartialDeps, "store">> = {}
): RedeemPartialEntitlementOperation {
  return new RedeemPartialEntitlementOperation({
    store: new BorrowedTransactionRedeemPartialStore(client),
    events: { async emit() {} },
    ...extra,
  })
}

export function createRedeemPartialOperationFromScope(scope: {
  resolve: (key: string) => unknown
}): RedeemPartialEntitlementOperation {
  const pool = scope.resolve("__pg_pool__") as PgPool
  let eventBus: EventBusLike | undefined
  try {
    eventBus = scope.resolve(Modules.EVENT_BUS) as EventBusLike
  } catch {
    eventBus = undefined
  }
  return new RedeemPartialEntitlementOperation({
    store: new PostgresRedeemPartialStore(pool),
    events: {
      async emit(event) {
        await eventBus?.emit?.({ name: event.event_type, data: event })
      },
    },
    // ledgerWriter celowo niepodpięty domyślnie: posting hook inert przy
    // runtime_enabled=false (audit-only). Podpięcie writera = krok aktywacji E6/P6.
    // postingActivation domyślnie defaultPostingActivationGate() (runtime_enabled=false).
  })
}
