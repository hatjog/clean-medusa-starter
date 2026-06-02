/**
 * entitlement-expiry.ts — Story 4.2 (v1.11.0 Epic 4 / Wave 4 — lifecycle).
 *
 * Warstwa SALDA i DEFENSYWNEGO EXPIRY (anti-forfeiture) na istniejącej maszynie
 * stanów L4. Czysta logika (bez I/O) trzech filarów (AC1/AC3):
 *
 *   (1) SALDO (AC1/AC2): `remaining` (minor units) odczytywane z TEGO SAMEGO
 *       `entitlement_id` (spójne z redeem/partial 4.1 — NIGDY reissue). Saldo
 *       żyje na istniejącym wierszu; ta warstwa go NIE mutuje (redeem = 4.1).
 *   (2) DETERMINISTYCZNY `expires_at` (AC1): ważność domyślna 12 mies., boundary
 *       [validity_months_min, validity_months_max] = [1, 24] z Layer 2
 *       (`ENTITLEMENT_BOUNDARY`, D-9/FR14). NIE poszerza boundary — reużywa.
 *   (3) PRE-EXPIRY POWIADOMIENIE (AC1): oferuje `extend` ORAZ **bezpłatny zwrot
 *       salda** jako RÓWNORZĘDNĄ alternatywę. Copy NIGDY nie zawiera „przepadnie"
 *       / równoważnego sygnału przepadku — anti-forfeiture invariant egzekwowany
 *       MECHANICZNIE (`assertNoForfeitureCopy`, NIE tylko review). Odpłatny extend
 *       NIGDY bez równoczesnej bezpłatnej opcji (UX-DR-08 H-2).
 *
 * AC3 (blokada profilu forfeiture): `assertExpiryProfileActivatable` REUŻYWA
 * `checkPolicyAgainstBoundary` (Layer 2, as-built TS mirror reguły 1.2 — forfeiture
 * wykluczone z `on_expiry_convert_to`). Pełny governance gate defensywnego expiry
 * (w tym `on_expiry` string + `forfeit_unused_value` bool) pozostaje w walidatorze
 * 1.2 (`_grow/tools/validate_entitlement_profiles.py`, `_check_defensive_expiry`)
 * egzekwowanym przy aktywacji przez komendę `validate` (6.2). Story 4.2 **NIE
 * reimplementuje** reguły — reużywa.
 *
 * GRANICE (E4): warstwa saldo/expiry/copy. Redeem = 4.1, refund = 4.3, extend =
 * 4.4. Posting EXPIRED→BREAKAGE = `workflows/expire-entitlement.ts` (routuje przez
 * `wireEntitlementTransition` 3.4, gated). NIE rusza hard-gate'ów MPV/SUBSCRIPTION.
 *
 * Podstawa normatywna (NFR4 — referencja, NIE autorstwo): ADR-136 (defensywny
 * expiry / forfeiture zakazany, art. 385¹ KC), ADR-133 (separacja entitlement↔money,
 * breakage), ADR-139 (governed activation postingu — D5).
 */

import {
  ENTITLEMENT_BOUNDARY,
  ON_EXPIRY_CONVERT_TARGETS,
  checkPolicyAgainstBoundary,
} from "./entitlement-boundary"
import type { EntitlementPolicySnapshot } from "./models/entitlement"

// ──────────────────────────────────────────────────────────────────────────
// (1) Saldo — query pozostałego salda na TYM SAMYM entitlement_id (AC1/AC2)
// ──────────────────────────────────────────────────────────────────────────

/** Saldo entitlementu (minor units) na moment odczytu — spójne z 4.1. */
export type EntitlementBalance = {
  entitlement_id: string
  /** Pozostałe saldo (minor units), clamped ≥ 0. */
  remaining_minor: number
  /** Czy saldo niewykorzystane (`remaining > 0`) — kandydat na breakage przy EXPIRED. */
  has_unused_balance: boolean
}

/**
 * Czyta pozostałe saldo z wiersza entitlementu (TEN SAM `entitlement_id`, NIGDY
 * reissue). `remaining_amount` null (legacy/przed migracją) ⇒ 0. Saldo jest
 * mutowane WYŁĄCZNIE przez redeem/partial (4.1) — ta funkcja tylko ODCZYTUJE.
 */
export function entitlementRemainingBalance(row: {
  id: string
  remaining_amount: number | null
}): EntitlementBalance {
  const remaining = Math.max(0, row.remaining_amount ?? 0)
  return {
    entitlement_id: row.id,
    remaining_minor: remaining,
    has_unused_balance: remaining > 0,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// (2) Deterministyczny expires_at (AC1, D-9/FR14) — boundary [1, 24] mies.
// ──────────────────────────────────────────────────────────────────────────

/** Ważność domyślna gdy profil nie deklaruje `validity_months` (D-9/FR14). */
export const DEFAULT_VALIDITY_MONTHS = 12 as const

/**
 * Rozstrzyga liczbę miesięcy ważności z profilu (snapshot), deterministycznie:
 *   - brak `validity_months` ⇒ {@link DEFAULT_VALIDITY_MONTHS} (12);
 *   - obecny ⇒ CLAMP do boundary Layer 2 [validity_months_min, validity_months_max]
 *     = [1, 24] (ADR-136 D-9 / FR14). NIE poszerza boundary — reużywa
 *     `ENTITLEMENT_BOUNDARY` (single source-of-truth, parytet z walidatorem 1.2).
 *
 * Clamp (nie throw): boundary egzekucja profilu należy do walidatora 1.2/6.2 przy
 * aktywacji (`assertExpiryProfileActivatable`); tu liczymy deterministyczny termin
 * obronnie nawet dla wartości spoza zakresu (defense-in-depth, NIGDY > 24 mies.).
 */
export function resolveValidityMonths(
  policy: EntitlementPolicySnapshot | Record<string, unknown>
): number {
  const raw = (policy as Record<string, unknown>).validity_months
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_VALIDITY_MONTHS
  }
  const min = ENTITLEMENT_BOUNDARY.validity_months_min
  const max = ENTITLEMENT_BOUNDARY.validity_months_max
  return Math.min(max, Math.max(min, Math.trunc(raw)))
}

/**
 * UTC-safe dodawanie miesięcy (mirror `VoucherService.addMonths`). Clamp dnia
 * przy przepełnieniu miesiąca (np. 31 sty + 1 mies. ⇒ ostatni dzień lutego),
 * by termin był deterministyczny i nigdy nie „przeskakiwał" miesiąca.
 */
export function addMonthsUtc(date: Date, months: number): Date {
  const d = new Date(date.getTime())
  const targetDay = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const lastDayOfTargetMonth = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
  ).getUTCDate()
  d.setUTCDate(Math.min(targetDay, lastDayOfTargetMonth))
  return d
}

/**
 * Deterministyczny `expires_at` = `issuedAt` + N miesięcy ważności wg profilu
 * (12 domyślnie, boundary [1, 24], D-9/FR14). Czysta funkcja — ten sam input ⇒
 * ten sam termin (audytowalność, brak zależności od zegara DB).
 */
export function computeExpiresAt(
  issuedAt: Date,
  policy: EntitlementPolicySnapshot | Record<string, unknown>
): Date {
  return addMonthsUtc(issuedAt, resolveValidityMonths(policy))
}

// ──────────────────────────────────────────────────────────────────────────
// (3) Anti-forfeiture invariant w copy (AC1) — egzekwowany MECHANICZNIE
// ──────────────────────────────────────────────────────────────────────────

/**
 * Status klienta po EXPIRED (UX §8) — recovery-as-care, NIGDY „przepadło".
 * Współdzielony przez warstwę powiadomień (AC1) i operację EXPIRED (AC2).
 */
export const EXPIRED_CUSTOMER_STATUS =
  "Ważność minęła — sprawdź opcje zwrotu" as const

/**
 * Zakazane sygnały przepadku w copy adresowanym do klienta (anti-forfeiture
 * invariant, art. 385¹ KC / UX-DR-08). Token-scope spójny z walidatorem 1.2
 * (`_FORFEITURE_TOKENS = forfeit/forfeiture/przepad/utrata`): prefiks „przepad"
 * pokrywa „przepadnie/przepadek/przepada", „utrat" pokrywa „utrata/utraci".
 * Case-insensitive; dopasowanie po znormalizowaniu (lowercase).
 */
export const FORBIDDEN_FORFEITURE_TOKENS: readonly string[] = [
  "przepad",
  "utrat",
  "forfeit",
  "forfeiture",
] as const

/** Rzucany gdy copy zawiera zakazany sygnał przepadku (fail-closed, AC1). */
export class ForfeitureCopyError extends Error {
  readonly token: string
  readonly text: string
  constructor(token: string, text: string) {
    super(
      `anti-forfeiture invariant naruszony: copy zawiera zakazany sygnał ` +
        `przepadku „${token}" (art. 385¹ KC / UX-DR-08); copy NIGDY nie może ` +
        `sugerować przepadku salda — oferuj extend oraz bezpłatny zwrot. ` +
        `Tekst: "${text}"`
    )
    this.name = "ForfeitureCopyError"
    this.token = token
    this.text = text
  }
}

/**
 * MECHANICZNA egzekucja anti-forfeiture invariantu (AC1): rzuca, gdy `text`
 * zawiera DOWOLNY zakazany token przepadku (po normalizacji lowercase). To NIE
 * jest review — to twardy gate copy. Używane przez `buildPreExpiryNotification`
 * oraz test odrzucający zakazane frazy.
 */
export function assertNoForfeitureCopy(text: string): void {
  const normalized = text.toLowerCase()
  for (const token of FORBIDDEN_FORFEITURE_TOKENS) {
    if (normalized.includes(token)) {
      throw new ForfeitureCopyError(token, text)
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// (3) Pre-expiry powiadomienie: extend ‖ bezpłatny zwrot salda (AC1)
// ──────────────────────────────────────────────────────────────────────────

/** Event type powiadomienia pre-expiry (AR-EVENTS naming, envelope-spójny). */
export const PRE_EXPIRY_REMINDER_EVENT_TYPE =
  "gp.entitlements.entitlement_pre_expiry_reminder.v1" as const

/** Rodzaj opcji recovery oferowanej w pre-expiry powiadomieniu. */
export type ExpiryRecoveryKind = "extend" | "refund_balance"

/** Pojedyncza opcja recovery (extend / bezpłatny zwrot salda). */
export type ExpiryRecoveryOption = {
  kind: ExpiryRecoveryKind
  /** true ⇒ opcja odpłatna (np. extend z fee). `refund_balance` ZAWSZE bezpłatny. */
  paid: boolean
}

/** Pre-expiry powiadomienie (anti-forfeiture copy) — kontrakt warstwy AC1. */
export type PreExpiryNotification = {
  event_type: typeof PRE_EXPIRY_REMINDER_EVENT_TYPE
  entitlement_id: string
  /** Deterministyczny termin ważności (ISO). */
  expires_at: string
  /** Pozostałe saldo (minor units) — przedmiot recovery. */
  remaining_minor: number
  /** Waluta salda (ISO-4217-kształt) — bonbeauty PLN. */
  currency: string
  /**
   * Opcje recovery: MUSZĄ zawierać `extend` ORAZ `refund_balance` (bezpłatny)
   * jako RÓWNORZĘDNE alternatywy (UX-DR-08). Niezmiennik egzekwowany przy budowie.
   */
  options: ExpiryRecoveryOption[]
  /** Copy klienta — anti-forfeiture (przeszedł `assertNoForfeitureCopy`). */
  message: string
  /** Klucz dedupe powiadomienia (per entitlement + termin) — patrz operacja. */
  idempotency_key: string
}

export type BuildPreExpiryNotificationInput = {
  entitlement_id: string
  expires_at: Date
  remaining_minor: number
  currency?: string
  /** Czy oferowany extend jest odpłatny (z fee). Domyślnie false (bezpłatny). */
  paid_extend?: boolean
  /** Override copy (np. i18n). Domyślnie copy anti-forfeiture poniżej. */
  message?: string
}

/** Rzucany gdy odpłatny extend NIE ma równoczesnej bezpłatnej opcji (UX-DR-08 H-2). */
export class ExpiryRecoveryOptionsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExpiryRecoveryOptionsError"
  }
}

/**
 * Domyślne copy pre-expiry — opiekuńcze (recovery-as-care). NIGDY nie zawiera
 * sygnału przepadku; oferuje extend i bezpłatny zwrot jako równorzędne.
 * Egzekwowane mechanicznie przez `assertNoForfeitureCopy`.
 */
export function defaultPreExpiryMessage(): string {
  return (
    "Ważność Twojego vouchera wkrótce się kończy. Nie musisz nic tracić: " +
    "możesz przedłużyć ważność albo bezpłatnie odzyskać niewykorzystane saldo " +
    "— wybór należy do Ciebie."
  )
}

/**
 * Buduje pre-expiry powiadomienie (AC1). Egzekwuje DWA niezmienniki:
 *   (a) opcje zawierają `extend` ORAZ `refund_balance` (bezpłatny) jako
 *       równorzędne — odpłatny extend NIGDY bez bezpłatnej opcji (UX-DR-08 H-2);
 *   (b) copy NIE zawiera zakazanego sygnału przepadku (`assertNoForfeitureCopy`).
 * Naruszenie któregokolwiek ⇒ rzuca (fail-closed, NIE generuje copy „zapłać albo strać").
 */
export function buildPreExpiryNotification(
  input: BuildPreExpiryNotificationInput
): PreExpiryNotification {
  const message = input.message ?? defaultPreExpiryMessage()
  // (b) anti-forfeiture invariant — MECHANICZNY gate copy (AC1).
  assertNoForfeitureCopy(message)

  const options: ExpiryRecoveryOption[] = [
    { kind: "extend", paid: input.paid_extend === true },
    // Bezpłatny zwrot salda — ZAWSZE bezpłatny, RÓWNORZĘDNA alternatywa.
    { kind: "refund_balance", paid: false },
  ]
  // (a) odpłatny extend nigdy bez bezpłatnej opcji (UX-DR-08 H-2).
  const hasFreeOption = options.some((o) => !o.paid)
  if (!hasFreeOption) {
    throw new ExpiryRecoveryOptionsError(
      "pre-expiry: brak bezpłatnej opcji recovery — odpłatny extend NIGDY bez " +
        "równoczesnej bezpłatnej alternatywy (UX-DR-08 H-2, anti-forfeiture)"
    )
  }

  const expiresAtIso = input.expires_at.toISOString()
  return {
    event_type: PRE_EXPIRY_REMINDER_EVENT_TYPE,
    entitlement_id: input.entitlement_id,
    expires_at: expiresAtIso,
    remaining_minor: input.remaining_minor,
    currency: input.currency ?? "PLN",
    options,
    message,
    idempotency_key: buildPreExpiryIdempotencyKey(
      input.entitlement_id,
      expiresAtIso
    ),
  }
}

/**
 * Deterministyczny klucz dedupe pre-expiry powiadomienia: per (entitlement_id,
 * termin ważności). Stabilny przy replay sweepu ⇒ powiadomienie NIE duplikuje
 * (re-run tego samego okna = no-op). Zmiana `expires_at` (np. po extend 4.4) ⇒
 * nowy klucz ⇒ nowe okno przypomnienia (zamierzone).
 */
export function buildPreExpiryIdempotencyKey(
  entitlementId: string,
  expiresAtIso: string
): string {
  return `entitlement:${entitlementId}:pre_expiry:${expiresAtIso}`
}

// ──────────────────────────────────────────────────────────────────────────
// AC3 — blokada profilu forfeiture przy aktywacji (REUSE walidatora 1.2)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Rzucany gdy profil deklaruje forfeiture/przepadek na expiry (AC3). Podstawa:
 * art. 385¹ KC (klauzula abuzywna) — wymagana polityka `extend` lub `refund`.
 */
export class ExpiryProfileForfeitureError extends Error {
  readonly violations: string[]
  constructor(violations: string[]) {
    super(
      `aktywacja warstwy expiry zablokowana — profil deklaruje forfeiture/` +
        `przepadek na wygaśnięciu (art. 385¹ KC, klauzula abuzywna); wymagana ` +
        `polityka: ${ON_EXPIRY_CONVERT_TARGETS.join(" / ")}. Naruszenia: ` +
        `${violations.join("; ")}`
    )
    this.name = "ExpiryProfileForfeitureError"
    this.violations = violations
  }
}

/**
 * Gate aktywacji warstwy expiry (AC3): profil z `on_expiry_convert_to`
 * ustawionym na forfeiture/przepadek jest ZABLOKOWANY. REUŻYWA
 * `checkPolicyAgainstBoundary` (Layer 2 — as-built TS mirror reguły 1.2, gdzie
 * `ON_EXPIRY_CONVERT_TARGETS` celowo NIE zawiera forfeiture). Story 4.2 NIE
 * reimplementuje reguły — deleguje do istniejącego boundary checku.
 *
 * Pełny governance gate defensywnego expiry (w tym pola `on_expiry` string i
 * `forfeit_unused_value` bool) pozostaje w walidatorze 1.2
 * (`validate_entitlement_profiles.py`, `_check_defensive_expiry`) egzekwowanym
 * przy aktywacji przez komendę `validate` (6.2). Ta funkcja jest runtime-owym
 * punktem reużycia reguły boundary dla warstwy expiry (powiązanie 1.2/6.2).
 *
 * Rzuca {@link ExpiryProfileForfeitureError} gdy naruszony jest
 * `policy.on_expiry_convert_to` (forfeiture). Inne naruszenia boundary są poza
 * zakresem tej bramki (egzekwuje je pełny walidator 1.2/6.2).
 */
export function assertExpiryProfileActivatable(
  policy: Record<string, unknown>
): void {
  const violations = checkPolicyAgainstBoundary(policy)
  const forfeitureViolations = violations
    .filter((v) => v.field === "policy.on_expiry_convert_to")
    .map((v) => v.message)
  if (forfeitureViolations.length > 0) {
    throw new ExpiryProfileForfeitureError(forfeitureViolations)
  }
}
