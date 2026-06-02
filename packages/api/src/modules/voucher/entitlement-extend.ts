/**
 * entitlement-extend.ts — Story 4.4 (v1.11.0 Epic 4 / Wave 4 — lifecycle L4 extend).
 *
 * Czysta logika POLITYKI + OKABLOWANIA PRZEDŁUŻENIA WAŻNOŚCI (extend) entitlementu
 * (bez I/O) na istniejącej maszynie stanów L4 — po expiry/saldzie (4.2) i refundzie
 * (4.3). Mechanizm extend ma DWA tryby (FR18):
 *
 *   (1) PIERWSZY extend NIEODPŁATNY, dokładnie 1× (AC1) — licznik free-extend per
 *       entitlement (`unpaid_extension_count`) przechodzi `0→1`, idempotentnie
 *       (replay z tym samym `idempotency_key` NIE podwaja licznika). Po wyczerpaniu
 *       (`>= MAX_FREE_EXTENDS`) bezpłatny extend jest ODRZUCONY i kieruje do trybu
 *       odpłatnego (z równorzędną bezpłatną opcją zwrotu salda — patrz niżej).
 *
 *   (2) ODPŁATNY extend (5–15% boundary L2, AC2) — opłata walidowana FAIL-CLOSED
 *       w przedziale [{@link EXTEND_FEE_PCT_MIN}, {@link EXTEND_FEE_PCT_MAX}]
 *       (NIGDY poniżej 5% / powyżej 15%, reuse `ENTITLEMENT_BOUNDARY.policy.extension`).
 *
 * KRYTYCZNY inwariant ochrony konsumenta (FR18, art. 385¹ KC, UX-DR-08 H-2):
 * odpłatny extend NIGDY nie jest prezentowany jako „zapłać albo strać" — ZAWSZE
 * towarzyszy mu RÓWNORZĘDNA, BEZPŁATNA oferta zwrotu salda (mechanizm (b) z 4.3).
 * Brak parytetu / profil z forfeiture ⇒ {@link ExtendParityError} (fail-closed,
 * anti-dark-pattern). Copy w ścieżce extend NIGDY nie zawiera „przepadnie" /
 * „zapłać albo strać" — egzekwowane MECHANICZNIE (reuse `assertNoForfeitureCopy`
 * z 4.2 + {@link assertNoCoercionExtendCopy}), NIE tylko review.
 *
 * GRANICE / POSTING (T3, KRYTYCZNE — ADR-139 D5): extend zmienia WAŻNOŚĆ
 * (`expires_at`) + licznik, NIE redeem/refund — entitlement liability pozostaje
 * BEZ ZMIANY ⇒ extend NIE przekazuje payloadu postingu do hooka (audit-only).
 * Ewentualna opłata za odpłatny extend = OSOBNA płatność (money-ledger), poza
 * profilem `voucher_liability_only_v1`; rozpoznanie przychodu z opłaty jest
 * DEFEROWANE architektonicznie ({@link buildExtendPostingDeferral}) i wymaga
 * osobnego ADR + E6/P6 finance gate (`runtime_enabled` zostaje `false`). NIE
 * wymyślamy księgowania. Tranzycja extend routuje przez TEN SAM jednolity punkt
 * okablowania co reszta L4 (envelope + audit + posting hook — `buildTransitionEnvelopes`
 * / `runTransitionPostingHook` z 3.4), BEZ dodawania stanu/krawędzi do taksonomii
 * (`ALL_ENTITLEMENT_INSTANCE_STATES` — 13 stanów, D-5, niezmienione: extend
 * zmienia `expires_at`/licznik, NIE stan).
 *
 * Podstawa normatywna (NFR4 — referencja, NIE autorstwo): ADR-139 (D3 posting hook
 * = wołanie writera, D5 governed activation; flip = P6), ADR-136 (defensywny expiry
 * / forfeiture zakazany, art. 385¹ KC), ADR-133 (separacja entitlement↔money),
 * ADR-099 (4-warstwowy model / boundary L2 immutable).
 */

import {
  ENTITLEMENT_BOUNDARY,
  checkPolicyAgainstBoundary,
} from "./entitlement-boundary"
import {
  addMonthsUtc,
  assertNoForfeitureCopy,
} from "./entitlement-expiry"
import {
  EntitlementInstanceState,
} from "./models/entitlement"
import {
  buildTransitionEnvelopes,
  emitTransitionEventAfterCommit,
  runTransitionPostingHook,
  type TransitionActor,
  type TransitionAuditEnvelope,
  type TransitionEventEnvelope,
  type TransitionInput,
  type TransitionPostingResult,
  type TransitionScope,
  type TransitionWiringDeps,
} from "./entitlement-transition-wiring"

// ──────────────────────────────────────────────────────────────────────────
// Boundary L2 — opłata odpłatnego extendu + maksimum ważności (reuse, NIE poszerza)
// ──────────────────────────────────────────────────────────────────────────

/** Minimalna opłata odpłatnego extendu (% wartości) — boundary L2 (reuse). */
export const EXTEND_FEE_PCT_MIN =
  ENTITLEMENT_BOUNDARY.policy.extension.fee_pct_min // 5
/** Maksymalna opłata odpłatnego extendu (% wartości) — boundary L2 (reuse). */
export const EXTEND_FEE_PCT_MAX =
  ENTITLEMENT_BOUNDARY.policy.extension.fee_pct_max // 15
/** Maksymalna liczba BEZPŁATNYCH extendów per entitlement (FR18, BE-1). */
export const MAX_FREE_EXTENDS = 1 as const

/** Tryb extendu: `free` (1× nieodpłatny) lub `paid` (odpłatny 5–15%). */
export type ExtendMode = "free" | "paid"

// ──────────────────────────────────────────────────────────────────────────
// Błędy fail-closed
// ──────────────────────────────────────────────────────────────────────────

/**
 * Rzucany gdy żądano bezpłatnego extendu po wyczerpaniu licznika (1×).
 * Kieruje do trybu ODPŁATNEGO — który MUSI być oferowany z równorzędną,
 * bezpłatną opcją zwrotu salda (FR18, UX-DR-08 H-2).
 */
export class FreeExtendExhaustedError extends Error {
  readonly unpaid_extension_count: number
  constructor(unpaidExtensionCount: number) {
    super(
      `extend: bezpłatny extend wyczerpany (max ${MAX_FREE_EXTENDS}×, ` +
        `unpaid_extension_count=${unpaidExtensionCount}) — kolejne przedłużenie ` +
        `WYŁĄCZNIE odpłatne (${EXTEND_FEE_PCT_MIN}–${EXTEND_FEE_PCT_MAX}%) i ZAWSZE ` +
        `z równorzędną, BEZPŁATNĄ opcją zwrotu salda (FR18, UX-DR-08 H-2, art. 385¹ KC).`
    )
    this.name = "FreeExtendExhaustedError"
    this.unpaid_extension_count = unpaidExtensionCount
  }
}

/** Rzucany gdy opłata odpłatnego extendu jest poza przedziałem 5–15% (fail-closed, AC2). */
export class ExtendFeeBoundaryError extends Error {
  readonly fee_pct: unknown
  constructor(feePct: unknown) {
    super(
      `extend: opłata za odpłatne przedłużenie '${String(feePct)}%' poza przedziałem ` +
        `boundary L2 [${EXTEND_FEE_PCT_MIN}, ${EXTEND_FEE_PCT_MAX}]% (fail-closed; ` +
        `NIGDY poniżej ${EXTEND_FEE_PCT_MIN}% / powyżej ${EXTEND_FEE_PCT_MAX}%).`
    )
    this.name = "ExtendFeeBoundaryError"
    this.fee_pct = feePct
  }
}

/**
 * Rzucany gdy odpłatny extend NIE ma równoczesnej, równorzędnej BEZPŁATNEJ opcji
 * zwrotu salda (UX-DR-08 H-2, art. 385¹ KC — klauzula abuzywna „zapłać albo strać").
 */
export class ExtendParityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExtendParityError"
  }
}

/** Rzucany gdy copy ścieżki extend zawiera zakazany sygnał przymusu (fail-closed, AC2). */
export class ExtendCoercionCopyError extends Error {
  readonly token: string
  readonly text: string
  constructor(token: string, text: string) {
    super(
      `extend: copy zawiera zakazany sygnał przymusu „${token}" (UX-DR-08 H-2, ` +
        `art. 385¹ KC); odpłatny extend NIGDY „zapłać albo strać" — extend i zwrot ` +
        `salda są równorzędnymi alternatywami. Tekst: "${text}"`
    )
    this.name = "ExtendCoercionCopyError"
    this.token = token
    this.text = text
  }
}

/**
 * Rzucany gdy free extend żądany bez klucza idempotencji (runtime-backstop L1).
 * Bez `idempotency_key` caller nie może zapewnić replay-safe compare-and-set
 * na poziomie operacji/persystencji — gate jest wymagany.
 */
export class FreeExtendIdempotencyMissingError extends Error {
  constructor() {
    super(
      `extend: idempotency_key jest WYMAGANY dla bezpłatnego extendu — bez niego ` +
        `nie można zapewnić replay-safe idempotencji na poziomie operacji/persystencji ` +
        `(AC1, runtime-backstop L1). Podaj klucz z buildExtendIdempotencyKey().`
    )
    this.name = "FreeExtendIdempotencyMissingError"
  }
}

/** Rzucany gdy extension_months ≤ 0 lub nie jest liczbą skończoną (dolna granica FR14, fail-closed, L3). */
export class ExtendExtensionMonthsBoundaryError extends Error {
  readonly extension_months: unknown
  constructor(extensionMonths: unknown) {
    super(
      `extend: extension_months '${String(extensionMonths)}' musi być > 0 ` +
        `(dolna granica FR14, fail-closed) — 0/ujemne ⇒ brak realnego przedłużenia; ` +
        `darmowy extend NIE może zostać skonsumowany bez korzyści dla klienta (L3).`
    )
    this.name = "ExtendExtensionMonthsBoundaryError"
    this.extension_months = extensionMonths
  }
}

/** Rzucany gdy profil blokuje aktywację extendu (forfeiture / opłata poza boundary). */
export class ExtendProfileError extends Error {
  readonly violations: string[]
  constructor(violations: string[]) {
    super(
      `aktywacja warstwy extend zablokowana — profil narusza boundary L2 ` +
        `(forfeiture / opłata extendu poza ${EXTEND_FEE_PCT_MIN}–${EXTEND_FEE_PCT_MAX}%; ` +
        `art. 385¹ KC). Naruszenia: ${violations.join("; ")}`
    )
    this.name = "ExtendProfileError"
    this.violations = violations
  }
}

// ──────────────────────────────────────────────────────────────────────────
// (1)/(2) Determinacja trybu extendu — licznik free 1× idempotentny + boundary 5–15%
// ──────────────────────────────────────────────────────────────────────────

export type ExtendDeterminationInput = {
  /** Tryb żądany przez callera. */
  requested: ExtendMode
  /** Bieżący licznik bezpłatnych extendów (`entitlement_instance.unpaid_extension_count`). */
  unpaid_extension_count: number
  /** Opłata (% wartości) dla trybu `paid` — walidowana [5, 15] fail-closed. */
  fee_pct?: number
  /** Klucz idempotencji BIEŻĄCEGO żądania extendu. */
  idempotency_key?: string
  /** Klucz ostatnio ZASTOSOWANEGO extendu (do detekcji replay). */
  last_applied_idempotency_key?: string | null
}

export type ExtendDetermination = {
  mode: ExtendMode
  /** Opłata (%); 0 dla `free`. */
  fee_pct: number
  /** Licznik bezpłatnych extendów PO operacji (idempotentny — replay NIE podwaja). */
  unpaid_extension_count_after: number
  /** true gdy żądanie to replay już zastosowanego extendu (no-op, licznik bez zmian). */
  idempotent_replay: boolean
}

/**
 * Rozstrzyga EFEKTYWNY tryb extendu (czysta funkcja, fail-closed):
 *
 *   (1) `free`: dozwolony WYŁĄCZNIE gdy `unpaid_extension_count < MAX_FREE_EXTENDS`
 *       (1×). Licznik `0→1`. Replay (ten sam `idempotency_key` co ostatnio
 *       zastosowany) ⇒ NIE podwaja licznika (`idempotent_replay:true`). Po
 *       wyczerpaniu ⇒ {@link FreeExtendExhaustedError} (kieruje do trybu odpłatnego
 *       z równorzędną bezpłatną opcją zwrotu).
 *
 *   (2) `paid`: opłata MUSI być w [{@link EXTEND_FEE_PCT_MIN}, {@link EXTEND_FEE_PCT_MAX}]%
 *       (boundary L2). Poza przedziałem / brak / NaN ⇒ {@link ExtendFeeBoundaryError}
 *       (fail-closed). Licznik bezpłatnych NIE rośnie (opłata ≠ free).
 *
 * Idempotencja: licznik free jest podbijany TYLKO przy realnym, nie-replayowym
 * bezpłatnym extendzie — replay tego samego `idempotency_key` zwraca bieżący stan
 * licznika bez podwojenia (delegacja persystencji idempotencji do warstwy operacji).
 */
export function determineExtendMode(
  input: ExtendDeterminationInput
): ExtendDetermination {
  const currentCount = Math.max(0, Math.trunc(input.unpaid_extension_count))
  const replay =
    input.idempotency_key != null &&
    input.idempotency_key === input.last_applied_idempotency_key

  if (input.requested === "free") {
    // Runtime-backstop (L1): idempotency_key WYMAGANY dla free extend.
    // Bez niego caller nie może zapewnić replay-safe compare-and-set na poziomie
    // persystencji — blokujemy wejście zanim licznik zostanie podwyższony.
    if (!input.idempotency_key) {
      throw new FreeExtendIdempotencyMissingError()
    }
    // (1) bezpłatny extend dokładnie 1× — fail-closed po wyczerpaniu (chyba że replay).
    if (!replay && currentCount >= MAX_FREE_EXTENDS) {
      throw new FreeExtendExhaustedError(currentCount)
    }
    const after = replay ? currentCount : currentCount + 1
    return {
      mode: "free",
      fee_pct: 0,
      unpaid_extension_count_after: after,
      idempotent_replay: replay,
    }
  }

  // (2) odpłatny extend — opłata 5–15% fail-closed.
  const fee = input.fee_pct
  if (
    typeof fee !== "number" ||
    !Number.isFinite(fee) ||
    fee < EXTEND_FEE_PCT_MIN ||
    fee > EXTEND_FEE_PCT_MAX
  ) {
    throw new ExtendFeeBoundaryError(fee)
  }
  return {
    mode: "paid",
    fee_pct: fee,
    // Odpłatny extend NIE konsumuje licznika bezpłatnych (pozostaje bez zmian).
    unpaid_extension_count_after: currentCount,
    idempotent_replay: replay,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Deterministyczny `expires_at` po extendzie — clamp do boundary (NIGDY > 24 mies.)
// ──────────────────────────────────────────────────────────────────────────

export type ComputeExtendedExpiresAtInput = {
  /** Moment emisji (start okna ważności; granica górna liczona od niego). */
  issued_at: Date
  /** Bieżący `expires_at` (przed extendem). */
  current_expires_at: Date
  /** Liczba miesięcy przedłużenia (z polityki, `extension.max_extension_months`). */
  extension_months: number
  /** Górny limit ważności (mies. od emisji). Domyślnie boundary L2 (24). */
  validity_months_max?: number
}

/**
 * Deterministyczny `expires_at` po extendzie: `current_expires_at` + N miesięcy,
 * CLAMPOWANY do górnej granicy ważności (`issued_at` + {@link
 * ENTITLEMENT_BOUNDARY.validity_months_max}, domyślnie 24 mies., FR14/D-9). Extend
 * NIGDY nie ustawia ważności poza boundary (clamp, NIE throw — boundary egzekwuje
 * walidator 1.2/6.2 przy aktywacji; tu liczymy obronnie). Extend NIGDY nie skraca
 * ważności (gdy bieżący termin jest już ≥ granica, zwraca bieżący termin).
 *
 * Czysta funkcja — ten sam input ⇒ ten sam termin (audytowalność, brak zależności
 * od zegara DB). Reużywa `addMonthsUtc` (UTC-safe clamp dnia) z 4.2 — single source.
 */
export function computeExtendedExpiresAt(
  input: ComputeExtendedExpiresAtInput
): Date {
  // L3 fix: dolna granica — 0/ujemne/NaN ⇒ fail-closed (NIE konsumuj darmowego extendu
  // bez realnego przedłużenia; klient traci extend bez korzyści — anti-forfeiture FR14).
  if (
    !Number.isFinite(input.extension_months) ||
    input.extension_months <= 0
  ) {
    throw new ExtendExtensionMonthsBoundaryError(input.extension_months)
  }
  const maxMonths =
    input.validity_months_max ?? ENTITLEMENT_BOUNDARY.validity_months_max
  const months = Math.trunc(input.extension_months)
  const candidate = addMonthsUtc(input.current_expires_at, months)
  const ceiling = addMonthsUtc(input.issued_at, maxMonths)
  // Clamp do górnej granicy ważności (NIGDY poza boundary).
  const clamped = candidate.getTime() > ceiling.getTime() ? ceiling : candidate
  // Extend NIGDY nie skraca ważności (defense-in-depth gdy bieżący termin > granica).
  return clamped.getTime() < input.current_expires_at.getTime()
    ? input.current_expires_at
    : clamped
}

// ──────────────────────────────────────────────────────────────────────────
// Idempotencja extendu — deterministyczny klucz (replay ⇒ jeden extend)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Deterministyczny klucz idempotencji extendu: per (entitlement_id, dyskryminator
 * żądania). Stabilny przy replay (ta sama para ⇒ ten sam klucz) ⇒ ponowne to samo
 * żądanie extendu NIE podwaja przedłużenia ani opłaty (delegacja do warstwy operacji
 * / writera). `extend_seq` = monotoniczny dyskryminator żądania (np. ULID / numer
 * sekwencji extendu) — różne extendy tego samego vouchera ⇒ różne klucze.
 */
export function buildExtendIdempotencyKey(
  entitlementId: string,
  extendSeq: string | number
): string {
  return `entitlement:${entitlementId}:extend:${String(extendSeq)}`
}

// ──────────────────────────────────────────────────────────────────────────
// Copy ścieżki extend — anti-coercion / anti-forfeiture (AC2, egzekwowane mechanicznie)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Zakazane sygnały PRZYMUSU w copy odpłatnego extendu („zapłać albo strać"). Token
 * „strac"/„strać" pokrywa „stracisz/stracić/strata"; case-insensitive po normalizacji.
 * Komplementarne do `FORBIDDEN_FORFEITURE_TOKENS` z 4.2 (przepad/utrat/forfeit).
 *
 * M1 fix: lista obejmuje synonimy klasy semantycznej „zapłać albo strać" / przepadek,
 * nie tylko dokładne frazy. Residual risk: klucze i18n z allowlisty (copy strukturalne)
 * są bezpieczniejsze niż wolny tekst; gate jest backstopem, nie pełną gwarancją.
 */
export const FORBIDDEN_COERCION_TOKENS: readonly string[] = [
  "strać",
  "strac",
  "stracisz",
  "stracić",
  "albo strać",
  "zapłać albo",
  "pay or lose",
  // M1: synonimy przepadku/przymusu spoza dokładnych fraz
  "bezpowrotn",   // „bezpowrotnie", „bezpowrotny" — nie do odzyskania
  "ostatnia szans", // „ostatnia szansa" — fałszywa pilność/presja
  "tylko teraz",  // „tylko teraz" — presja czasowa, urgency coercion
] as const

/**
 * MECHANICZNA egzekucja anti-coercion invariantu (AC2): rzuca, gdy `text` zawiera
 * DOWOLNY zakazany token przymusu (po normalizacji lowercase). Komplementarna do
 * `assertNoForfeitureCopy` (4.2) — patrz {@link assertExtendCopySafe}.
 */
export function assertNoCoercionExtendCopy(text: string): void {
  const normalized = text.toLowerCase()
  for (const token of FORBIDDEN_COERCION_TOKENS) {
    if (normalized.includes(token)) {
      throw new ExtendCoercionCopyError(token, text)
    }
  }
}

/**
 * Pełny gate copy ścieżki extend: brak sygnału PRZEPADKU (reuse `assertNoForfeitureCopy`
 * z 4.2: przepad/utrat/forfeit) ORAZ brak sygnału PRZYMUSU ({@link
 * assertNoCoercionExtendCopy}: „zapłać albo strać"). Twardy gate, NIE review.
 */
export function assertExtendCopySafe(text: string): void {
  assertNoForfeitureCopy(text)
  assertNoCoercionExtendCopy(text)
}

// ──────────────────────────────────────────────────────────────────────────
// Oferta odpłatnego extendu z RÓWNORZĘDNYM bezpłatnym zwrotem salda (AC2 — rdzeń)
// ──────────────────────────────────────────────────────────────────────────

/** Rodzaj opcji w ofercie extendu. */
export type ExtendOptionKind = "paid_extend" | "free_refund_balance"

/** Pojedyncza opcja oferty extendu (odpłatny extend / bezpłatny zwrot salda). */
export type ExtendOption = {
  kind: ExtendOptionKind
  /** true ⇒ opcja odpłatna. `free_refund_balance` ZAWSZE bezpłatny (`false`). */
  paid: boolean
  /** Opłata (%) dla `paid_extend`; brak dla bezpłatnego zwrotu. */
  fee_pct?: number
}

/**
 * Oferta odpłatnego extendu (AC2): MUSI zawierać `paid_extend` ORAZ
 * `free_refund_balance` (bezpłatny) jako RÓWNORZĘDNE alternatywy — odpłatny extend
 * NIGDY bez bezpłatnej opcji (UX-DR-08 H-2, art. 385¹ KC). Copy przeszło
 * {@link assertExtendCopySafe}.
 */
export type ExtendOffer = {
  options: ExtendOption[]
  /** Opłata odpłatnego extendu (% wartości) — w boundary [5, 15]. */
  fee_pct: number
  /** Pozostałe saldo (minor units) — przedmiot równorzędnego bezpłatnego zwrotu. */
  remaining_minor: number
  /** Waluta salda (bonbeauty PLN). */
  currency: string
  /** Copy klienta (anti-forfeiture + anti-coercion). */
  message: string
}

export type BuildPaidExtendOfferInput = {
  /** Opłata odpłatnego extendu (% wartości) — walidowana [5, 15] fail-closed. */
  fee_pct: number
  /** Pozostałe saldo (minor units) — kwota równorzędnego bezpłatnego zwrotu. */
  remaining_minor: number
  /** Waluta salda. Domyślnie PLN (bonbeauty). */
  currency?: string
  /** Override copy (np. i18n). Domyślnie copy równorzędności poniżej. */
  message?: string
  /**
   * M2 fix: czy bezpłatny zwrot salda jest faktycznie DOSTĘPNY dla tego entitlementu
   * (mechanizm (b) z 4.3). Gdy `false` ⇒ {@link ExtendParityError} (brak parytetu;
   * fail-closed, AC2, art. 385¹ KC). Domyślnie `true`.
   * Podaj wynik sprawdzenia dostępności refundu z warstwy operacji (4.3),
   * aby parytet był WALIDOWANY, a nie tylko hardkodowany.
   */
  refund_available?: boolean
}

/**
 * Domyślne copy oferty odpłatnego extendu — równorzędność (recovery-as-choice).
 * Prezentuje odpłatny extend i BEZPŁATNY zwrot salda jako równorzędne alternatywy;
 * NIGDY „przepadnie" / „zapłać albo strać". Egzekwowane przez {@link assertExtendCopySafe}.
 */
export function defaultPaidExtendMessage(
  feePct: number,
  remainingMinor: number,
  currency: string
): string {
  const amount = `${(remainingMinor / 100).toFixed(2)} ${currency}`
  return (
    `Możesz przedłużyć ważność za opłatą ${feePct}% wartości — ALBO bezpłatnie ` +
    `odzyskać niewykorzystane saldo ${amount}. Obie opcje są równorzędne; ` +
    `wybór należy do Ciebie.`
  )
}

/**
 * Buduje ofertę ODPŁATNEGO extendu (AC2). Egzekwuje TRZY niezmienniki fail-closed:
 *   (i)   opłata w [{@link EXTEND_FEE_PCT_MIN}, {@link EXTEND_FEE_PCT_MAX}]%
 *         ({@link ExtendFeeBoundaryError});
 *   (ii)  PARYTET — opcje zawierają `paid_extend` ORAZ równorzędny, BEZPŁATNY
 *         `free_refund_balance` ({@link ExtendParityError} gdy brak bezpłatnej opcji);
 *   (iii) copy bez sygnału przepadku/przymusu ({@link assertExtendCopySafe}).
 * Naruszenie któregokolwiek ⇒ rzuca (NIGDY oferta „zapłać albo strać").
 */
export function buildPaidExtendOffer(
  input: BuildPaidExtendOfferInput
): ExtendOffer {
  // (i) opłata 5–15% fail-closed (reuse semantyki determineExtendMode).
  const fee = input.fee_pct
  if (
    typeof fee !== "number" ||
    !Number.isFinite(fee) ||
    fee < EXTEND_FEE_PCT_MIN ||
    fee > EXTEND_FEE_PCT_MAX
  ) {
    throw new ExtendFeeBoundaryError(fee)
  }

  const currency = input.currency ?? "PLN"
  const remaining = Math.max(0, Math.trunc(input.remaining_minor))
  const message =
    input.message ?? defaultPaidExtendMessage(fee, remaining, currency)
  // (iii) anti-forfeiture + anti-coercion — twardy gate copy.
  assertExtendCopySafe(message)

  // (ii) M2 fix: PARYTET walidowany — opcja refundu dodawana TYLKO gdy dostępna
  // (refund_available z warstwy operacji), nie hardkodowana. ExtendParityError
  // jest OSIĄGALNY gdy mechanizm (b) z 4.3 niedostępny dla tego entitlementu.
  const refundAvailable = input.refund_available !== false
  const options: ExtendOption[] = [
    { kind: "paid_extend", paid: true, fee_pct: fee },
    ...(refundAvailable
      ? [{ kind: "free_refund_balance" as ExtendOptionKind, paid: false }]
      : []),
  ]
  const hasFreeRefund = options.some(
    (o) => o.kind === "free_refund_balance" && !o.paid
  )
  if (!hasFreeRefund) {
    throw new ExtendParityError(
      "extend: odpłatny extend bez równorzędnej, BEZPŁATNEJ opcji zwrotu salda — " +
        "mechanizm (b) z 4.3 niedostępny dla tego entitlementu " +
        "(UX-DR-08 H-2, art. 385¹ KC — klauzula abuzywna 'zapłać albo strać'). " +
        "Podaj refund_available:true tylko gdy zwrot salda faktycznie dostępny."
    )
  }

  return { options, fee_pct: fee, remaining_minor: remaining, currency, message }
}

// ──────────────────────────────────────────────────────────────────────────
// AC2 — blokada profilu forfeiture / opłaty extendu poza boundary (REUSE walidatora L2)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Gate aktywacji warstwy extend (AC2): profil z opłatą odpłatnego extendu poza
 * [5, 15]% LUB z `on_expiry_convert_to` ustawionym na forfeiture jest ZABLOKOWANY
 * (art. 385¹ KC). REUŻYWA `checkPolicyAgainstBoundary` (Layer 2 — as-built TS mirror
 * reguły 1.2). Story 4.4 NIE reimplementuje reguły — deleguje do boundary checku.
 * Pełny governance gate pozostaje w walidatorze 1.2 (`validate_entitlement_profiles.py`)
 * egzekwowanym przy aktywacji przez komendę `validate` (6.2).
 */
export function assertExtendProfileActivatable(
  policy: Record<string, unknown>
): void {
  const violations = checkPolicyAgainstBoundary(policy)
  const extendViolations = violations
    .filter(
      (v) =>
        v.field === "policy.extension.fee_pct" ||
        v.field === "policy.on_expiry_convert_to"
    )
    .map((v) => v.message)

  // L2 fix: rozszerzone pokrycie forfeiture — omission (`on_expiry_convert_to`
  // undefined/null) wykrywane jawnie. `checkPolicyAgainstBoundary` traktuje brak
  // pola jako no-op (additive), ale przy aktywacji extendu brak jawnej deklaracji
  // = niekontrolowane zachowanie po wygaśnięciu (domyślny przepadek, art. 385¹ KC).
  // Pełny gate governance: walidator 1.2 (`validate_entitlement_profiles.py`).
  if (
    policy.on_expiry_convert_to === undefined ||
    policy.on_expiry_convert_to === null
  ) {
    extendViolations.push(
      "on_expiry_convert_to nieobecne — wymagana jawna deklaracja spośród " +
        "[extend, refund, store_credit]; brak wartości = niekontrolowane zachowanie " +
        "po wygaśnięciu (domyślny przepadek — art. 385¹ KC, klauzula abuzywna). " +
        "Pełna walidacja governance: walidator 1.2 (validate_entitlement_profiles.py)."
    )
  }

  if (extendViolations.length > 0) {
    throw new ExtendProfileError(extendViolations)
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Posting GATED — extend = NO posting (audit-only), opłata = money-ledger (DEFERRED)
// ──────────────────────────────────────────────────────────────────────────

/** ADR wymagany do aktywacji rozpoznania przychodu z opłaty za extend (osobny). */
export const EXTEND_FEE_POSTING_REQUIRED_ADR =
  "ADR-required: voucher paid-extend fee revenue recognition (opłata = money-ledger, poza voucher_liability_only_v1)" as const

/** Powód deferralu postingu opłaty za extend (ADR-139 D5 / §Granice). */
export const EXTEND_POSTING_DEFERRAL_REASON: string =
  "extend zmienia ważność (expires_at) + licznik, NIE redeem/refund — entitlement " +
  "liability BEZ ZMIANY ⇒ extend NIE przekazuje payloadu postingu do hooka (audit-only). " +
  "Ewentualna opłata za odpłatny extend = OSOBNA płatność (money-ledger), poza profilem " +
  "voucher_liability_only_v1; rozpoznanie przychodu z opłaty wymaga osobnego ADR + E6/P6 " +
  "finance gate (runtime_enabled=false). NIE wymyślamy księgowania."

/**
 * Marker fail-closed: extend NIE księguje na entitlement-ledgerze (audit-only).
 * Tranzycja extend routuje przez jednolity punkt okablowania (event + audit), ALE
 * NIE przekazuje payloadu postingu — liability bez zmiany, opłata = money-ledger.
 * Rozpoznanie przychodu z opłaty jest DEFEROWANE i wymaga osobnego ADR + E6/P6.
 */
export type ExtendPostingDeferral = {
  /** Zawsze true — extend posting jest deferowany / NIGDY wymyślony. */
  deferred: true
  /** Powód architektoniczny (ADR-139 D5 / §Granice). */
  reason: typeof EXTEND_POSTING_DEFERRAL_REASON
  /** Wymagany osobny ADR (warunek aktywacji rozpoznania przychodu z opłaty). */
  requires_adr: typeof EXTEND_FEE_POSTING_REQUIRED_ADR
  /** Tryb extendu (kontekst alarmu/telemetrii). */
  mode: ExtendMode
  /** Kwota opłaty NIE zaksięgowana na entitlement-ledgerze (0 dla free). */
  unposted_fee_minor: number
  currency: string
}

/**
 * Buduje marker deferralu postingu opłaty za extend (ADR-139 D5, fail-closed). NIE
 * wykonuje księgowania — dokumentuje, że rozpoznanie przychodu z opłaty za odpłatny
 * extend wymaga osobnego ADR + E6/P6 finance gate (entitlement liability bez zmiany).
 */
export function buildExtendPostingDeferral(input: {
  mode: ExtendMode
  unposted_fee_minor: number
  currency?: string
}): ExtendPostingDeferral {
  return {
    deferred: true,
    reason: EXTEND_POSTING_DEFERRAL_REASON,
    requires_adr: EXTEND_FEE_POSTING_REQUIRED_ADR,
    mode: input.mode,
    unposted_fee_minor: Math.max(0, Math.trunc(input.unposted_fee_minor)),
    currency: input.currency ?? "PLN",
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Okablowanie tranzycji extend — JEDNOLITY punkt (3.4), audit-only, BEZ posting
// ──────────────────────────────────────────────────────────────────────────

/** Hint aktora dla audytu extendu (rozróżnia tryb w append-only śladzie). */
export function extendActorHint(mode: ExtendMode, feePct: number): string {
  return mode === "paid" ? `extend:paid:${feePct}%` : "extend:free"
}

export type BuildExtendWiringInput = {
  entitlement_id: string
  /** Bieżący stan L4 (extend NIE zmienia stanu — `from === to`, D-5). */
  state: EntitlementInstanceState
  scope: TransitionScope
  /** Tryb extendu (audit hint). */
  mode: ExtendMode
  /** Opłata (%) — tylko dla audit hintu trybu paid. */
  fee_pct?: number
  /** Aktor tranzycji (envelope.v1). Domyślnie `customer` (klient korzysta z extend). */
  actor?: TransitionActor
  /** Czas wystąpienia (ISO). Domyślnie `now` w builderze kopert. */
  occurred_at?: string
  /**
   * Dyskryminator WYSTĄPIENIA extendu (cykl-safe key, 3.4 AI-Review-2) — np. klucz
   * idempotencji extendu. Różne extendy ⇒ różne klucze korelacji event↔audit.
   */
  extend_seq: string | number
}

/**
 * Buduje `TransitionInput` dla tranzycji extend routowanej przez JEDNOLITY punkt
 * okablowania (3.4). KRYTYCZNE: extend NIE zmienia stanu (`from === to` = bieżący
 * stan) — D-5, taksonomia 13 stanów NIEZMIENIONA (extend zmienia `expires_at`/licznik,
 * NIE dodaje stanu/krawędzi). Posting payload jest CELOWO pominięty (`posting`
 * undefined) — extend = entitlement liability bez zmiany ⇒ hook jest audit-only
 * (`attempted:false`); opłata = money-ledger (deferred, patrz {@link buildExtendPostingDeferral}).
 */
export function buildExtendTransitionInput(
  input: BuildExtendWiringInput
): TransitionInput {
  return {
    from: input.state,
    to: input.state,
    entitlement_id: input.entitlement_id,
    scope: input.scope,
    actor: input.actor ?? "customer",
    actor_hint: extendActorHint(input.mode, input.fee_pct ?? 0),
    ...(input.occurred_at ? { occurred_at: input.occurred_at } : {}),
    transition_seq: input.extend_seq,
    // POSTING CELOWO pominięty — extend audit-only (liability bez zmiany, opłata = money-ledger).
  }
}

export type ExtendWiringResult = {
  event: TransitionEventEnvelope
  audit: TransitionAuditEnvelope
  /** Wynik posting hooka — dla extendu ZAWSZE audit-only (`attempted:false`, brak payloadu). */
  posting: TransitionPostingResult
  /**
   * M3: true gdy emit eventu zawiódł (best-effort; kompletność = reconciliation 2.6).
   * false gdy `emitEvent` nie podano w deps LUB emit powiódł się.
   */
  emitFailed: boolean
}

/**
 * Okablowuje tranzycję extend przez TE SAME prymitywy co reszta L4 (3.4): koperty
 * `buildTransitionEnvelopes` (event + append-only audit) + `runTransitionPostingHook`
 * (bramkowany dwuwarstwowo). Extend NIE niesie payloadu postingu ⇒ hook zwraca
 * audit-only no-op (`attempted:false`) — zero zapisu do `voucher_ledger_*`,
 * niezależnie od `runtime_enabled`. NIE woła `assertWiringTransition` (extend NIE
 * jest krawędzią grafu — `from === to`; assercję grafu rezerwujemy dla realnych
 * tranzycji stanu, D-5). Reużywa zegara z `deps.clock` (testowalność).
 */
export async function buildExtendWiring(
  deps: Pick<
    TransitionWiringDeps,
    "ledgerWriter" | "postingActivation" | "clock"
  > & {
    /**
     * M3 fix: append-only sink audytu — gdy podany, woła w obrębie tx callera
     * (atomowy ze zmianą stanu + licznika extendu). Bez tego audyt jest budowany
     * ale NIE persystowany — caller musi zapewnić persystencję zwróconego `audit`.
     */
    appendAudit?: (audit: TransitionAuditEnvelope) => Promise<void>
    /**
     * M3 fix: best-effort emit eventu tranzycji (wołany po hooku postingu,
     * idealnie post-COMMIT). Gdy podany, emit wołany przez `emitTransitionEventAfterCommit`
     * (retry 2×, NIE rzuca). Fail NIE blokuje — kompletność = reconciliation 2.6.
     */
    emitEvent?: (event: TransitionEventEnvelope) => Promise<void>
  },
  input: BuildExtendWiringInput
): Promise<ExtendWiringResult> {
  const now = deps.clock?.() ?? new Date()
  const transitionInput = buildExtendTransitionInput(input)
  const { event, audit } = buildTransitionEnvelopes(transitionInput, now)

  // M3 fix: appendAudit w obrębie tx callera (atomowy ze zmianą stanu + licznika).
  // Reużywa tej samej semantyki co wireEntitlementTransitionPersisted (3.4),
  // omijając wyłącznie assertWiringTransition (extend from===to, NIE krawędź grafu).
  if (deps.appendAudit) {
    await deps.appendAudit(audit)
  }

  const posting = await runTransitionPostingHook(deps, transitionInput, now)

  // M3 fix: best-effort emit eventu (post-COMMIT). Reużywa emitTransitionEventAfterCommit
  // z 3.4 (retry 2×, fail NIE blokuje tranzycji).
  let emitFailed = false
  if (deps.emitEvent) {
    emitFailed = await emitTransitionEventAfterCommit(deps.emitEvent, event)
  }

  return { event, audit, posting, emitFailed }
}
