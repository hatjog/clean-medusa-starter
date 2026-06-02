/**
 * entitlement-refund.ts — Story 4.3 (v1.11.0 Epic 4 / Wave 4 — lifecycle L4 refund).
 *
 * Czysta logika DWÓCH MECHANIZMÓW ZWROTU (bez I/O) na istniejącej maszynie stanów
 * L4 — po redeem (4.1) i saldo/expiry (4.2):
 *
 *   (a) ODSTĄPIENIE 14 dni (AC1, FR17/UX-DR-14) — PEŁNY zwrot, gdy voucher
 *       CAŁKOWICIE niewykorzystany w oknie ustawowym (`refund_window_days:14`,
 *       `requires_unused_entitlement:true`). Prawo odstąpienia gaśnie WYŁĄCZNIE
 *       przy `REDEEMED_FULL` (reużycie `isWithdrawalRightExtinguished` z 4.1 —
 *       AC3 4.1, art. 38 pkt 1). Próba (a) po jakimkolwiek redeem ⇒ NIE-mechanizm-(a)
 *       (kieruje do (b)); próba (a) po oknie 14 dni ⇒ FAIL-CLOSED.
 *
 *   (b) ZWROT SALDA (AC2, FR17/UX-DR-14, art. 385¹ KC) — zwracana niewykorzystana
 *       część `remaining` (stan ze Story 4.1), DOZWOLONY także po partial.
 *
 * Copy MUSI rozróżniać (a) od (b) — podstawa i kwota zwrotu NIGDY mylące
 * (anti-forfeiture invariant; reużycie `assertNoForfeitureCopy` z 4.2 — UX-DR-14).
 *
 * RODO art. 26 carry-forward (AC3, NFR8/UX-DR-10): refund KONSUMUJE istniejący
 * kontrakt DSAR (ADR-069 współadministracja art. 26 + JCA) — `buildDsarCarryForward`
 * zwraca referencję do `consent-privacy-dsar-integrity.v1` (`dsar_procedure`
 * → realny punkt kontaktowy + `response_sla_days`). NIE buduje nowego kanału DSAR
 * (korekta readiness M3, 2026-05-31).
 *
 * KRYTYCZNE — posting derecognition FAIL-CLOSED (ADR-139 §Granice):
 *   posting profile `voucher_liability_only_v1` NIE zna `REFUNDED` (lifecycle =
 *   ISSUED / REDEEMED / EXPIRED→BREAKAGE — ADR-139 §Granice). Refund posting =
 *   **NO posting + alarm, wymaga OSOBNEGO ADR** (refund-after-redeem / reversal
 *   entry-type; noga kontry = konto pieniężne = money-ledger, poza profilem). Ta
 *   warstwa NIE wymyśla księgowania: tranzycja refund routuje przez
 *   `wireEntitlementTransition` (3.4) dla event+audit (gated, audit-only/no-op),
 *   a derecognition finansowy jest DEFEROWANY architektonicznie
 *   (`buildRefundPostingDeferral`) — NIE przekazujemy payloadu postingu do hooka.
 *
 * GRANICE (E4): refund (extend = 4.4, transfer = 4.5). NIE aktywuje postingu
 * globalnie (`runtime_enabled` zostaje false, flip = E6/P6). NIE rusza hard-gate'ów
 * MPV_MULTI_VENDOR (ADR-134) / SUBSCRIPTION_B2C (ADR-136). NIE buduje cross-vendor
 * wallet (kanał `vendor_wallet` jest single-vendor).
 *
 * Podstawa normatywna (NFR4 — referencja, NIE autorstwo): ADR-069 (art. 26 / JCA /
 * DSAR), ADR-139 (§Granice refund-after-redeem fail-closed; D5 governed activation),
 * ADR-133 (separacja entitlement↔money), ADR-136 (defensywny expiry / art. 385¹ KC).
 */

import {
  REFUND_CHANNELS,
  type RefundChannel,
} from "./entitlement-boundary"
import { assertNoForfeitureCopy } from "./entitlement-expiry"
import {
  EntitlementInstanceState,
  type EntitlementPolicySnapshot,
} from "./models/entitlement"
import { isWithdrawalRightExtinguished } from "./workflows/redeem-partial-entitlement"

// ──────────────────────────────────────────────────────────────────────────
// Mechanizm zwrotu (a) odstąpienie / (b) zwrot salda
// ──────────────────────────────────────────────────────────────────────────

/**
 * Dwa rozłączne mechanizmy zwrotu (FR17/UX-DR-14):
 *   `withdrawal` — (a) odstąpienie 14 dni, pełny zwrot niewykorzystanego (art. 38 pkt 1);
 *   `balance`    — (b) zwrot salda `remaining`, dozwolony także po partial (art. 385¹ KC).
 */
export type RefundMechanism = "withdrawal" | "balance"

/** Ustawowe okno odstąpienia (dni) — `refund_window_days:14`. */
export const WITHDRAWAL_WINDOW_DAYS = 14 as const

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Rozstrzyga długość okna odstąpienia (dni) z profilu (snapshot), deterministycznie:
 * preferuje `policy.refund_window_days`, potem `policy.withdrawal.window_days`,
 * inaczej {@link WITHDRAWAL_WINDOW_DAYS} (14). Wartość spoza (≤0 / nie-liczba) ⇒
 * domyślne 14 (defense-in-depth; NIE poszerza prawa ponad ustawowe okno).
 */
export function resolveRefundWindowDays(
  policy: EntitlementPolicySnapshot | Record<string, unknown>
): number {
  const p = policy as Record<string, unknown>
  const direct = p.refund_window_days
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) {
    return Math.trunc(direct)
  }
  const withdrawal = p.withdrawal as Record<string, unknown> | undefined
  const nested = withdrawal?.window_days
  if (typeof nested === "number" && Number.isFinite(nested) && nested > 0) {
    return Math.trunc(nested)
  }
  return WITHDRAWAL_WINDOW_DAYS
}

/**
 * Czy `now` mieści się w oknie odstąpienia liczonym od `issuedAt` (inclusive).
 * Czysta funkcja — ten sam input ⇒ ten sam wynik (audytowalność). Niepoprawne
 * daty (NaN) ⇒ false (fail-closed: poza oknem). Okno liczone w pełnych dobach.
 */
export function isWithinWithdrawalWindow(
  issuedAt: Date,
  now: Date,
  windowDays: number = WITHDRAWAL_WINDOW_DAYS
): boolean {
  const issuedMs = issuedAt.getTime()
  const nowMs = now.getTime()
  if (!Number.isFinite(issuedMs) || !Number.isFinite(nowMs)) return false
  if (nowMs < issuedMs) return false
  return nowMs - issuedMs <= windowDays * DAY_MS
}

// ──────────────────────────────────────────────────────────────────────────
// Kanał zwrotu (reuse boundary REFUND_CHANNELS) — single-vendor, NIE cross-vendor
// ──────────────────────────────────────────────────────────────────────────

/** Rzucany gdy `policy_snapshot.refund_channel` jest nieznany/niewspierany (fail-closed). */
export class RefundChannelError extends Error {
  readonly refund_channel: unknown
  constructor(refundChannel: unknown) {
    super(
      `refund: policy_snapshot.refund_channel '${String(refundChannel)}' nie jest ` +
        `wspieranym kanałem zwrotu (dozwolone: ${REFUND_CHANNELS.join(" / ")}). ` +
        `Kanał 'vendor_wallet' jest SINGLE-VENDOR (NIE cross-vendor wallet, ADR-134 ` +
        `hard-gate MPV_MULTI_VENDOR trwale off).`
    )
    this.name = "RefundChannelError"
    this.refund_channel = refundChannel
  }
}

/**
 * Rozstrzyga kanał zwrotu ze snapshotu (immutable post-ISSUED, regulamin § 12).
 * Fail-closed na nieznany/brakujący kanał. NIE buduje cross-vendor wallet —
 * `vendor_wallet` pozostaje single-vendor (ADR-134).
 */
export function resolveRefundChannel(
  policy: EntitlementPolicySnapshot | Record<string, unknown>
): RefundChannel {
  const raw = (policy as Record<string, unknown>).refund_channel
  if (
    raw === undefined ||
    !(REFUND_CHANNELS as readonly string[]).includes(raw as string)
  ) {
    throw new RefundChannelError(raw)
  }
  return raw as RefundChannel
}

// ──────────────────────────────────────────────────────────────────────────
// Błędy fail-closed mechanizmu
// ──────────────────────────────────────────────────────────────────────────

/** Rzucany gdy próba odstąpienia (a) po upływie okna 14 dni (fail-closed, AC1). */
export class RefundWithdrawalWindowError extends Error {
  readonly entitlement_id: string
  readonly issued_at: string
  readonly window_days: number
  constructor(entitlementId: string, issuedAt: Date, windowDays: number) {
    super(
      `refund: odstąpienie (mechanizm a) niedostępne — okno ustawowe ${windowDays} dni ` +
        `od emisji (${issuedAt.toISOString()}) upłynęło (fail-closed, art. 38 pkt 1 / AC1). ` +
        `Sprawdź mechanizm (b) zwrot salda jeśli pozostało niewykorzystane saldo.`
    )
    this.name = "RefundWithdrawalWindowError"
    this.entitlement_id = entitlementId
    this.issued_at = issuedAt.toISOString()
    this.window_days = windowDays
  }
}

/**
 * Rzucany gdy żądano mechanizmu (a) odstąpienia, ale warunki rozłączne kierują do
 * (b) (voucher częściowo wykorzystany) LUB prawo odstąpienia wygasło (REDEEMED_FULL).
 * Fail-closed: NIE wykonujemy pełnego zwrotu po redeem (anti-forfeiture / NIE
 * wprowadzamy w błąd co do podstawy i kwoty).
 */
export class RefundMechanismError extends Error {
  readonly entitlement_id: string
  readonly reason: "partially_redeemed" | "withdrawal_right_extinguished"
  constructor(
    entitlementId: string,
    reason: "partially_redeemed" | "withdrawal_right_extinguished",
    message: string
  ) {
    super(message)
    this.name = "RefundMechanismError"
    this.entitlement_id = entitlementId
    this.reason = reason
  }
}

/** Rzucany gdy brak salda do zwrotu (mechanizm b z remaining=0) (fail-closed). */
export class RefundAmountError extends Error {
  readonly entitlement_id: string
  readonly remaining: number
  constructor(entitlementId: string, remaining: number, message: string) {
    super(message)
    this.name = "RefundAmountError"
    this.entitlement_id = entitlementId
    this.remaining = remaining
  }
}

/**
 * Rzucany gdy inwariant `remaining ≤ issued_gross` jest naruszony (fail-closed).
 * Sytuacja: saldo vouchera przekracza brutto emisji — niespójny stan DB / błąd
 * callera. Math.max(0, …) cichym clampem maskowałby over-refund; jawny guard
 * zapobiega zwrotowi większemu niż realna wartość (money invariant).
 */
export class RefundBalanceInvariantError extends Error {
  readonly entitlement_id: string
  readonly remaining: number
  readonly issued_gross: number
  constructor(entitlementId: string, remaining: number, issuedGross: number) {
    super(
      `refund: inwariant salda naruszony — remaining=${remaining} > ` +
        `issued_gross=${issuedGross} (fail-closed; niespójny stan vouchera ` +
        `${entitlementId}; over-refund niemożliwy)`
    )
    this.name = "RefundBalanceInvariantError"
    this.entitlement_id = entitlementId
    this.remaining = remaining
    this.issued_gross = issuedGross
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Determinacja mechanizmu (czysta) — rozłączne warunki wejścia (a)/(b)
// ──────────────────────────────────────────────────────────────────────────

export type RefundDeterminationInput = {
  /** Mechanizm żądany przez callera (intencja). */
  requested: RefundMechanism
  /** Stan entitlementu PRZED refundem (źródło rozłączności). */
  state: EntitlementInstanceState
  /** Pozostałe saldo (minor units), clamped ≥ 0. */
  remaining_minor: number
  /** Brutto CAŁEGO vouchera przy emisji (minor units) — do detekcji „niewykorzystany". */
  issued_gross_minor: number
  /** Moment emisji (start okna odstąpienia). */
  issued_at: Date
  now: Date
  /** Okno odstąpienia (dni). Domyślnie {@link WITHDRAWAL_WINDOW_DAYS}. */
  window_days?: number
}

export type RefundDetermination = {
  mechanism: RefundMechanism
  /** Kwota zwrotu (minor units): pełna (a) lub `remaining` (b). */
  refunded_amount_minor: number
  /** true ⇒ voucher całkowicie niewykorzystany (redeemed-to-date = 0). */
  fully_unused: boolean
  /** AC3 4.1: prawo odstąpienia (art. 38 pkt 1) — gaśnie WYŁĄCZNIE przy REDEEMED_FULL. */
  withdrawal_right_extinguished: boolean
}

/**
 * Rozstrzyga EFEKTYWNY mechanizm zwrotu z rozłącznych warunków wejścia (fail-closed):
 *
 *   (a) `withdrawal`: wymaga (i) prawo odstąpienia NIE wygasło (state ≠ REDEEMED_FULL,
 *       reuse 4.1), (ii) voucher CAŁKOWICIE niewykorzystany (`requires_unused_entitlement`
 *       — redeemed-to-date = 0), (iii) `now` w oknie `window_days` od `issued_at`.
 *       Naruszenie (i)/(ii) ⇒ {@link RefundMechanismError} (kieruje do b — NIE pełny
 *       zwrot po redeem); naruszenie (iii) ⇒ {@link RefundWithdrawalWindowError}.
 *       Kwota = pełna (`remaining` == `issued_gross`).
 *
 *   (b) `balance`: zwraca `remaining` (dozwolony także po partial, art. 385¹ KC).
 *       `remaining` = 0 ⇒ {@link RefundAmountError} (brak salda).
 *
 * Czysta funkcja — bez I/O. NIGDY nie zwraca ponad `remaining` (mechanizm b) ani
 * nie wykonuje (a) po jakimkolwiek redeem.
 */
export function determineRefundMechanism(
  input: RefundDeterminationInput
): RefundDetermination {
  const remaining = Math.max(0, input.remaining_minor)
  const issuedGross = Math.max(0, input.issued_gross_minor)
  // M1: jawny inwariant — remaining nigdy > issued_gross (fail-closed).
  // Math.max(0, …) maskowałby over-refund; chcemy fail-closed zamiast cichego clampa.
  if (remaining > issuedGross) {
    throw new RefundBalanceInvariantError(
      "(determination)",
      remaining,
      issuedGross
    )
  }
  // redeemed-to-date (kumulatywnie zrealizowane brutto) = brutto emisji − saldo.
  const redeemedToDate = issuedGross - remaining // safe: remaining ≤ issuedGross (inwariant powyżej)
  const fullyUnused = redeemedToDate === 0
  const extinguished = isWithdrawalRightExtinguished(input.state)
  const windowDays = input.window_days ?? WITHDRAWAL_WINDOW_DAYS

  if (input.requested === "withdrawal") {
    // (i) prawo odstąpienia wygasło WYŁĄCZNIE przy REDEEMED_FULL (AC3 4.1).
    if (extinguished) {
      throw new RefundMechanismError(
        "(determination)",
        "withdrawal_right_extinguished",
        `refund: odstąpienie (mechanizm a) niedostępne — prawo odstąpienia wygasło ` +
          `(stan REDEEMED_FULL, usługa wykonana w całości; art. 38 pkt 1, AC3 Story 4.1).`
      )
    }
    // (ii) `requires_unused_entitlement` — całkowicie niewykorzystany.
    if (!fullyUnused) {
      throw new RefundMechanismError(
        "(determination)",
        "partially_redeemed",
        `refund: odstąpienie (mechanizm a) niedostępne — voucher częściowo wykorzystany ` +
          `(redeemed-to-date=${redeemedToDate} > 0). Użyj mechanizmu (b) zwrot salda ` +
          `pozostałej części ${remaining} (art. 385¹ KC). Copy MUSI rozróżniać (a)/(b).`
      )
    }
    // (iii) okno ustawowe 14 dni — fail-closed po upływie.
    if (!isWithinWithdrawalWindow(input.issued_at, input.now, windowDays)) {
      throw new RefundWithdrawalWindowError(
        "(determination)",
        input.issued_at,
        windowDays
      )
    }
    return {
      mechanism: "withdrawal",
      refunded_amount_minor: remaining,
      fully_unused: true,
      withdrawal_right_extinguished: false,
    }
  }

  // (b) zwrot salda — dozwolony także po partial (art. 385¹ KC).
  if (remaining <= 0) {
    throw new RefundAmountError(
      "(determination)",
      remaining,
      `refund: zwrot salda (mechanizm b) niemożliwy — brak niewykorzystanego salda ` +
        `(remaining=${remaining}).`
    )
  }
  return {
    mechanism: "balance",
    refunded_amount_minor: remaining,
    fully_unused: fullyUnused,
    withdrawal_right_extinguished: extinguished,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Copy rozróżniające (a)/(b) — anti-forfeiture, NIGDY mylące (AC2/UX-DR-14)
// ──────────────────────────────────────────────────────────────────────────

/** Customer-facing copy zwrotu (rozróżnia podstawę i kwotę (a) vs (b)). */
export type RefundCopy = {
  mechanism: RefundMechanism
  /** Podstawa prawna (jednoznaczna, NIGDY myląca). */
  basis: string
  /** Komunikat dla klienta (przeszedł `assertNoForfeitureCopy`). */
  message: string
  /** Kwota zwrotu (minor units) odzwierciedlona w copy. */
  refunded_amount_minor: number
  currency: string
}

/** Podstawa prawna mechanizmu (a) — jednoznaczna etykieta. */
export const WITHDRAWAL_BASIS_LABEL =
  "odstąpienie od umowy w 14 dni (art. 38 pkt 1 u.p.k.)" as const
/** Podstawa prawna mechanizmu (b) — jednoznaczna etykieta. */
export const BALANCE_BASIS_LABEL =
  "zwrot niewykorzystanego salda (art. 385¹ KC)" as const

function formatMinor(amountMinor: number, currency: string): string {
  const major = (amountMinor / 100).toFixed(2)
  return `${major} ${currency}`
}

/**
 * Buduje copy zwrotu rozróżniające (a) od (b) — podstawa i kwota NIGDY mylące
 * (FR17/UX-DR-14, anti-forfeiture). Copy przechodzi `assertNoForfeitureCopy` (reuse
 * 4.2) — NIGDY sygnału przepadku. Mechanizm (a) komunikuje PEŁNY zwrot + podstawę
 * odstąpienia; (b) komunikuje zwrot SALDA + podstawę art. 385¹ KC.
 */
export function buildRefundCopy(input: {
  mechanism: RefundMechanism
  refunded_amount_minor: number
  currency: string
}): RefundCopy {
  const amount = formatMinor(input.refunded_amount_minor, input.currency)
  const basis =
    input.mechanism === "withdrawal"
      ? WITHDRAWAL_BASIS_LABEL
      : BALANCE_BASIS_LABEL
  const message =
    input.mechanism === "withdrawal"
      ? `Zwracamy pełną kwotę ${amount} na podstawie: ${basis}. ` +
        `Voucher był całkowicie niewykorzystany w ustawowym oknie ${WITHDRAWAL_WINDOW_DAYS} dni.`
      : `Zwracamy niewykorzystane saldo ${amount} na podstawie: ${basis}. ` +
        `Zwrot salda przysługuje także po częściowej realizacji vouchera.`
  // Anti-forfeiture invariant — MECHANICZNY gate copy (reuse 4.2, UX-DR-14).
  assertNoForfeitureCopy(message)
  return {
    mechanism: input.mechanism,
    basis,
    message,
    refunded_amount_minor: input.refunded_amount_minor,
    currency: input.currency,
  }
}

/** Rzucany gdy copy (a) i (b) są nierozróżnialne / mylące (fail-closed, UX-DR-14). */
export class RefundCopyAmbiguityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RefundCopyAmbiguityError"
  }
}

/**
 * Egzekwuje, że copy mechanizmu (a) i (b) RÓŻNIĄ się podstawą i komunikatem
 * (anti-forfeiture / NIGDY mylące — UX-DR-14). Używane przez test rozróżnienia (a)/(b)
 * oraz przy budowie powiadomień refund. Rzuca {@link RefundCopyAmbiguityError} gdy
 * podstawa lub komunikat są identyczne.
 */
export function assertRefundCopyDistinct(a: RefundCopy, b: RefundCopy): void {
  if (a.mechanism === b.mechanism) {
    throw new RefundCopyAmbiguityError(
      `assertRefundCopyDistinct: porównano copy tego samego mechanizmu (${a.mechanism}) ` +
        `— rozróżnienie wymaga (a) withdrawal vs (b) balance.`
    )
  }
  if (a.basis === b.basis) {
    throw new RefundCopyAmbiguityError(
      `copy (a)/(b) ma identyczną podstawę „${a.basis}" — klient MUSI rozróżnić ` +
        `odstąpienie od zwrotu salda (UX-DR-14, anti-forfeiture).`
    )
  }
  if (a.message === b.message) {
    throw new RefundCopyAmbiguityError(
      `copy (a)/(b) ma identyczny komunikat — podstawa/kwota zwrotu nie może być ` +
        `myląca (UX-DR-14).`
    )
  }
}

// ──────────────────────────────────────────────────────────────────────────
// RODO art. 26 carry-forward (AC3) — KONSUMUJE istniejący kanał DSAR (ADR-069)
// ──────────────────────────────────────────────────────────────────────────

/** Ścieżka istniejącego kontraktu DSAR konsumowanego przez AC3 (NIE budowanego). */
export const DSAR_CONTRACT_REF =
  "specs/contracts/governance/schemas/consent-privacy-dsar-integrity.v1.schema.json" as const

/** ADR podstawy carry-forward (współadministracja art. 26 + JCA). */
export const DSAR_CARRY_FORWARD_ADR =
  "specs/adr/2026-04-28-adr-069-gp-vendor-jca-wspoladministracja.md" as const

/**
 * Referencja carry-forward praw podmiotu danych przy refundzie (mechanizm, NIE zapis).
 * KONSUMUJE istniejący kontrakt DSAR (`dsar_procedure` → realny punkt kontaktowy +
 * `response_sla_days`) — NIE buduje nowego kanału/endpointu (AC3, NFR8/UX-DR-10,
 * korekta readiness M3). Scope (`market_id`/`sales_channel_id`) umożliwia powiązanie
 * z procedurą DSAR per faza/administrator (współadministracja art. 26, ADR-069).
 */
export type DsarCarryForward = {
  /** Referencja do istniejącego kontraktu DSAR (KONSUMUJE, NIE buduje). */
  contract_ref: typeof DSAR_CONTRACT_REF
  /** Podstawa carry-forward (ADR-069 współadministracja art. 26 + JCA). */
  adr_ref: typeof DSAR_CARRY_FORWARD_ADR
  /** Pole kontraktu = realny punkt kontaktowy / mechanizm wykonywania praw. */
  dsar_procedure_field: "dsar_procedure"
  /** Pole kontraktu = SLA odpowiedzi (mechanizm, nie sam zapis). */
  response_sla_field: "response_sla_days"
  /** Scope powiązania z administratorem/fazą (ontologia FK 3.2). */
  scope: {
    market_id: string
    sales_channel_id?: string | null
  }
}

/**
 * Buduje referencję carry-forward DSAR dla refundu (AC3). NIE buduje nowego kanału —
 * wskazuje istniejący kontrakt (`DSAR_CONTRACT_REF`) i jego pola realizacji praw
 * (`dsar_procedure`, `response_sla_days`), wiążąc je ze scope refundu (per
 * administrator/faza, ADR-069 współadministracja art. 26).
 */
export function buildDsarCarryForward(scope: {
  market_id: string
  sales_channel_id?: string | null
}): DsarCarryForward {
  return {
    contract_ref: DSAR_CONTRACT_REF,
    adr_ref: DSAR_CARRY_FORWARD_ADR,
    dsar_procedure_field: "dsar_procedure",
    response_sla_field: "response_sla_days",
    scope: {
      market_id: scope.market_id,
      sales_channel_id: scope.sales_channel_id ?? null,
    },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Posting derecognition FAIL-CLOSED (ADR-139 §Granice) — DEFERRED architectural
// ──────────────────────────────────────────────────────────────────────────

/** ADR wymagany do aktywacji refund postingu (osobny od ADR-139). */
export const REFUND_POSTING_REQUIRED_ADR =
  "ADR-required: voucher refund/reversal posting entry-type (REFUNDED unknown to voucher_liability_only_v1)" as const

/** Powód deferralu refund postingu (ADR-139 §Granice — refund-after-redeem). */
export const REFUND_POSTING_DEFERRAL_REASON: string =
  "posting profile voucher_liability_only_v1 NIE zna REFUNDED (lifecycle = " +
  "ISSUED/REDEEMED/EXPIRED→BREAKAGE, ADR-139 §Granice); refund derecognition = " +
  "NO posting + alarm, wymaga osobnego ADR (reversal entry-type; noga kontry = " +
  "money-ledger, poza profilem entitlement-ledger). NIE wymyślamy księgowania."

/**
 * Marker fail-closed derecognition refundu (ADR-139 §Granice). Refund routuje
 * tranzycję przez `wireEntitlementTransition` (event + audit, gated/audit-only),
 * ALE NIE przekazuje payloadu postingu — bo profil NIE zna `REFUNDED`. Posting
 * derecognition jest DEFEROWANY architektonicznie i wymaga osobnego ADR. Marker
 * jest emitowany w wyniku operacji (alarm) i utrwalany w audycie refundu.
 */
export type RefundPostingDeferral = {
  /** Zawsze true — refund posting jest deferowany (NIGDY wymyślony). */
  deferred: true
  /** Powód architektoniczny (ADR-139 §Granice). */
  reason: typeof REFUND_POSTING_DEFERRAL_REASON
  /** Wymagany osobny ADR (warunek aktywacji refund postingu). */
  requires_adr: typeof REFUND_POSTING_REQUIRED_ADR
  /** Mechanizm zwrotu, którego dotyczy deferral (kontekst alarmu). */
  mechanism: RefundMechanism
  /** Kwota, która NIE została zaksięgowana (deferral, dla telemetrii alarmu). */
  unposted_amount_minor: number
  currency: string
}

/**
 * Buduje marker deferralu refund postingu (ADR-139 §Granice, fail-closed). NIE
 * wykonuje księgowania — dokumentuje, że derecognition refundu wymaga osobnego ADR.
 */
export function buildRefundPostingDeferral(input: {
  mechanism: RefundMechanism
  unposted_amount_minor: number
  currency: string
}): RefundPostingDeferral {
  return {
    deferred: true,
    reason: REFUND_POSTING_DEFERRAL_REASON,
    requires_adr: REFUND_POSTING_REQUIRED_ADR,
    mechanism: input.mechanism,
    unposted_amount_minor: input.unposted_amount_minor,
    currency: input.currency,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Stripe refund idempotency seam (NIE aktywuje realnych płatności — scope window)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Deterministyczny klucz idempotencji zwrotu płatności (seam Stripe). Stabilny
 * przy replay (ta sama para ⇒ ten sam klucz) ⇒ ponowny refund NIE inicjuje drugiego
 * zwrotu płatności. Ta warstwa NIE wykonuje realnego `refund.create` — BonBeauty
 * Stripe TEST poza zakresem tej story (scope window v1.10.0–v1.15.0 BonBeauty-only,
 * money-ledger). Klucz jest udostępniany jako seam dla przyszłej integracji płatności.
 */
export function buildPaymentRefundIdempotencyKey(
  entitlementId: string,
  refundId: string
): string {
  return `payment-refund:${entitlementId}:${refundId}`
}

/** Stany terminalne refundu — replay markerem (REFUNDED). */
export const REFUND_TERMINAL_STATE = EntitlementInstanceState.REFUNDED
