/**
 * entitlement-cancellation.ts — Story 4.6 (v1.11.0 Epic 4 / Wave 4 — lifecycle L4
 * cancellation / no-show policy).
 *
 * Czysta logika POLITYKI ANULACJI / NO-SHOW + OKABLOWANIA tranzycji (bez I/O) na
 * istniejącej maszynie stanów L4. Charakter pracy = wykorzystanie ISTNIEJĄCEGO
 * okablowania `wireEntitlementTransition` (Story 3.4) + fundamentu writera (Story 2.6)
 * + semantyki idempotencji/derecognition (Story 4.1) — Story 4.6 NIE reimplementuje
 * writera ani nie dodaje równoległej ścieżki postingu.
 *
 * Model domenowy (booking pointer): `entitlement_instance.booking_pointer` (v1.6.0
 * migr. 1778925265229) wiąże uprawnienie z terminem wizyty. Anulacja/no-show ZWALNIA
 * booking — voucher (saldo + wartość) pozostaje BEZ ZMIANY. To NIE redeem/refund:
 * anulacja zwraca voucher do stanu redeemowalnego (booking pointer wyczyszczony przez
 * warstwę operacji), saldo i `expires_at` zachowane.
 *
 * DWA progi czasowe (AC1 / AC2, FR19) na bazie CUTOFF min 12h:
 *
 *   (1) ≥24h przed terminem → voucher W PEŁNI AKTYWNY (AC1): `remaining` i `expires_at`
 *       NIEZMIENIONE, status nie degraduje wartości, brak derecognition. Tranzycja
 *       audytowana (event + append-only audit) przez `wireEntitlementTransition`.
 *
 *   (2) <24h (lecz ≥ CUTOFF 12h) lub realny NO-SHOW (mija termin) → WARTOŚĆ ZACHOWANA
 *       (saldo nie przepada), możliwy REBOOK. INWARIANT UX-DR-14 M-5: rebook NIE skraca
 *       `expires_at` — ważność liczona wg PIERWOTNEJ polityki (4.2), NIGDY od daty rebooku.
 *
 * CUTOFF fail-closed: jawna anulacja PO cutoff (<12h przed terminem) jest ODRZUCONA
 * ({@link CancellationCutoffError}) — po cutoff klient albo zjawia się, albo to no-show
 * (wartość i tak zachowana, rebook dostępny). Cutoff dotyczy WYŁĄCZNIE jawnej anulacji;
 * no-show (`determineNoShowOutcome`) NIE podlega cutoffowi (termin już minął).
 *
 * GRANICE / POSTING (KRYTYCZNE — ADR-139 D5): anulacja/no-show ZWALNIA booking, ale
 * entitlement liability (saldo + wartość) pozostaje BEZ ZMIANY ⇒ BRAK postingu. Tranzycja
 * routuje przez TEN SAM jednolity punkt okablowania co reszta L4 (event + audit + posting
 * hook), ALE posting payload jest CELOWO POMINIĘTY ⇒ hook = audit-only (`attempted:false`,
 * no-op derecognition). Niezależnie posting globalnie GATED: `runtime_enabled` zostaje
 * `false` (hook inert, NIE pisze do `voucher_ledger_*`). Flip `false→true` = osobny P6
 * finance gate (E6/P6 + per-market signoff D-59), WYŁĄCZNIE ręczna decyzja P6 (Robert),
 * NIE agent / NIE CI.
 *
 * GRANICE (D-5): anulacja/no-show/rebook NIE zmieniają taksonomii stanów
 * (`ALL_ENTITLEMENT_INSTANCE_STATES`, 13 stanów) ani grafu — to operacje na booking
 * pointerze (`from === to` = bieżący stan, jak extend 4.4). NIE rusza hard-gate'ów
 * `MPV_MULTI_VENDOR` (ADR-134) / `SUBSCRIPTION_B2C` (ADR-136). Scope: single-vendor,
 * bonbeauty-only.
 *
 * Podstawa normatywna (NFR4 — referencja, NIE autorstwo): ADR-139 (D3 posting hook =
 * wołanie writera, D5 governed activation; flip = P6), ADR-136 (anti-forfeiture / art.
 * 385¹ KC), ADR-133 (separacja entitlement↔money), ADR-099 (4-warstwowy model / boundary).
 */

import { assertNoForfeitureCopy } from "./entitlement-expiry"
import { EntitlementInstanceState } from "./models/entitlement"
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
// Progi czasowe — cutoff anulacji + próg pełnej aktywności (FR19)
// ──────────────────────────────────────────────────────────────────────────

/**
 * CUTOFF jawnej anulacji (godziny przed terminem): anulacja dozwolona WYŁĄCZNIE do
 * {@link CANCELLATION_CUTOFF_HOURS}h przed terminem. Po cutoff jawna anulacja jest
 * ODRZUCONA (fail-closed, {@link CancellationCutoffError}) — pozostaje pokazanie się
 * albo no-show (wartość i tak zachowana, FR19).
 */
export const CANCELLATION_CUTOFF_HOURS = 12 as const

/**
 * Próg PEŁNEJ AKTYWNOŚCI (godziny przed terminem): anulacja ≥ {@link
 * CANCELLATION_ACTIVE_THRESHOLD_HOURS}h przed terminem ⇒ voucher pozostaje w pełni
 * aktywny (AC1). Poniżej progu (lecz ≥ cutoff) ⇒ wartość zachowana + rebook (AC2).
 */
export const CANCELLATION_ACTIVE_THRESHOLD_HOURS = 24 as const

/** Tryb tranzycji anulacji/no-show/rebook (audit hint + okablowanie). */
export type CancellationKind = "cancellation" | "no_show" | "rebook"

/**
 * Wynik czasowej oceny anulacji (FR19):
 *   - `full_active`     — anulacja ≥24h: voucher w pełni aktywny (AC1).
 *   - `value_preserved` — anulacja <24h / no-show: wartość zachowana + rebook (AC2).
 * W OBU przypadkach wartość vouchera jest chroniona (zero forfeiture, anti-forfeiture
 * invariant Epic 4) — różnica jest WYŁĄCZNIE w audit hincie / komunikacie.
 */
export type CancellationTier = "full_active" | "value_preserved"

// ──────────────────────────────────────────────────────────────────────────
// Błędy fail-closed
// ──────────────────────────────────────────────────────────────────────────

/**
 * Rzucany gdy jawna anulacja żądana PO cutoff (< {@link CANCELLATION_CUTOFF_HOURS}h
 * przed terminem) — fail-closed (AC1, scope CUTOFF). Po cutoff anulacja niedozwolona;
 * wartość vouchera i tak zachowana przy no-show (patrz {@link determineNoShowOutcome}).
 */
export class CancellationCutoffError extends Error {
  readonly hours_before_appointment: number
  readonly cutoff_hours: number
  constructor(hoursBefore: number, cutoffHours: number) {
    super(
      `cancellation: jawna anulacja odrzucona — ${hoursBefore}h przed terminem ` +
        `jest po cutoff (min ${cutoffHours}h przed terminem, fail-closed). ` +
        `Po cutoff: pokaż się albo no-show — wartość vouchera i tak zachowana ` +
        `(rebook dostępny, saldo nie przepada; FR19).`
    )
    this.name = "CancellationCutoffError"
    this.hours_before_appointment = hoursBefore
    this.cutoff_hours = cutoffHours
  }
}

/**
 * Rzucany gdy operacja anulacji/no-show/rebook żądana bez klucza idempotencji
 * (runtime-backstop). Bez `idempotency_key` caller nie może zapewnić replay-safe
 * compare-and-set na poziomie operacji/persystencji — gate jest wymagany (T3).
 */
export class CancellationIdempotencyMissingError extends Error {
  constructor(kind: CancellationKind) {
    super(
      `cancellation: idempotency_key jest WYMAGANY dla operacji '${kind}' — bez niego ` +
        `nie można zapewnić replay-safe idempotencji (no-op przy replay, brak podwojenia ` +
        `audytu/postingu; T3). Podaj klucz z buildCancellationIdempotencyKey()/buildRebookIdempotencyKey().`
    )
    this.name = "CancellationIdempotencyMissingError"
  }
}

/** Rzucany gdy `hours_before_appointment` nie jest liczbą skończoną (fail-closed). */
export class CancellationHoursInvalidError extends Error {
  readonly hours_before_appointment: unknown
  constructor(hoursBefore: unknown) {
    super(
      `cancellation: hours_before_appointment '${String(hoursBefore)}' musi być ` +
        `liczbą skończoną (fail-closed) — bez wiarygodnego dystansu czasowego nie ` +
        `można ocenić progu anulacji (cutoff/≥24h).`
    )
    this.name = "CancellationHoursInvalidError"
    this.hours_before_appointment = hoursBefore
  }
}

/**
 * Rzucany gdy rebook próbuje SKRÓCIĆ `expires_at` (defense-in-depth, INWARIANT
 * UX-DR-14 M-5). Rebook zmienia termin wizyty, NIGDY ważność vouchera — ważność =
 * pierwotna polityka (4.2), niezależna od daty rebooku.
 */
export class RebookExpiryShorteningError extends Error {
  readonly before: string
  readonly after: string
  constructor(before: Date, after: Date) {
    super(
      `rebook: próba skrócenia expires_at (${before.toISOString()} → ${after.toISOString()}) ` +
        `ZABRONIONA — rebook NIE skraca ważności (UX-DR-14 M-5, anti-forfeiture). ` +
        `Ważność = pierwotna polityka (4.2), NIGDY liczona od daty rebooku.`
    )
    this.name = "RebookExpiryShorteningError"
    this.before = before.toISOString()
    this.after = after.toISOString()
  }
}

// ──────────────────────────────────────────────────────────────────────────
// (1)/(2) Determinacja czasowa anulacji — cutoff + próg ≥24h, idempotentna
// ──────────────────────────────────────────────────────────────────────────

export type CancellationDeterminationInput = {
  /** Liczba godzin DO terminu w momencie anulacji (≥0; <0 = termin minął → użyj no-show). */
  hours_before_appointment: number
  /** Cutoff jawnej anulacji (h). Domyślnie {@link CANCELLATION_CUTOFF_HOURS}. */
  cutoff_hours?: number
  /** Próg pełnej aktywności (h). Domyślnie {@link CANCELLATION_ACTIVE_THRESHOLD_HOURS}. */
  active_threshold_hours?: number
  /** Klucz idempotencji BIEŻĄCEGO żądania anulacji (WYMAGANY, T3). */
  idempotency_key?: string
  /** Klucz ostatnio ZASTOSOWANEJ anulacji (detekcja replay → no-op). */
  last_applied_idempotency_key?: string | null
}

export type CancellationDetermination = {
  /** Tryb (audit hint). */
  kind: CancellationKind
  /** Próg czasowy (AC1 full_active / AC2 value_preserved). */
  tier: CancellationTier
  /** Zawsze true — wartość vouchera ZAWSZE zachowana (anti-forfeiture, FR19). */
  value_preserved: true
  /** Zawsze false — anulacja/no-show NIE generuje derecognition (liability bez zmiany). */
  derecognition: false
  /** `remaining` NIGDY nie zmieniane przez anulację/no-show (AC1/AC2). */
  remaining_changed: false
  /** `expires_at` NIGDY nie zmieniane przez anulację/no-show/rebook (UX-DR-14 M-5). */
  expires_at_changed: false
  /** true gdy możliwy rebook (AC2 value_preserved; full_active także redeemowalny). */
  rebookable: boolean
  /** true gdy żądanie to replay już zastosowanej operacji (no-op, AC/T3). */
  idempotent_replay: boolean
}

function resolveReplay(
  kind: CancellationKind,
  idempotencyKey: string | undefined,
  lastApplied: string | null | undefined
): boolean {
  if (!idempotencyKey) {
    throw new CancellationIdempotencyMissingError(kind)
  }
  return idempotencyKey === lastApplied
}

/**
 * Rozstrzyga EFEKTYWNY próg czasowy jawnej anulacji (czysta funkcja, fail-closed):
 *
 *   - `hours_before >= active_threshold` (24h) ⇒ `full_active` (AC1): voucher w pełni
 *     aktywny, `remaining`/`expires_at` niezmienione, brak derecognition.
 *   - `cutoff <= hours_before < active_threshold` ⇒ `value_preserved` (AC2): wartość
 *     zachowana, rebook dostępny.
 *   - `hours_before < cutoff` ⇒ {@link CancellationCutoffError} (fail-closed) — jawna
 *     anulacja po cutoff niedozwolona (pozostaje no-show, wartość i tak zachowana).
 *
 * Idempotencja (T3): `idempotency_key` WYMAGANY; replay (ten sam klucz co ostatnio
 * zastosowany) ⇒ `idempotent_replay:true` i POMIJA gate cutoffu (operacja już raz
 * zaszła — no-op, NIE re-throw). Persystencja idempotencji delegowana do warstwy
 * operacji/writera (deterministyczny klucz, replay ⇒ no-op).
 */
export function determineCancellationOutcome(
  input: CancellationDeterminationInput
): CancellationDetermination {
  const replay = resolveReplay(
    "cancellation",
    input.idempotency_key,
    input.last_applied_idempotency_key
  )

  if (!Number.isFinite(input.hours_before_appointment)) {
    throw new CancellationHoursInvalidError(input.hours_before_appointment)
  }

  const cutoff = input.cutoff_hours ?? CANCELLATION_CUTOFF_HOURS
  const threshold = input.active_threshold_hours ?? CANCELLATION_ACTIVE_THRESHOLD_HOURS
  const hours = input.hours_before_appointment

  // Fail-closed cutoff — pomijany przy replay (operacja już raz zaszła, no-op).
  if (!replay && hours < cutoff) {
    throw new CancellationCutoffError(hours, cutoff)
  }

  const tier: CancellationTier =
    hours >= threshold ? "full_active" : "value_preserved"

  return {
    kind: "cancellation",
    tier,
    value_preserved: true,
    derecognition: false,
    remaining_changed: false,
    expires_at_changed: false,
    // Oba progi pozostawiają voucher z zachowaną wartością ⇒ rebook dostępny.
    rebookable: true,
    idempotent_replay: replay,
  }
}

export type NoShowDeterminationInput = {
  /** Klucz idempotencji żądania no-show (WYMAGANY, T3). */
  idempotency_key?: string
  /** Klucz ostatnio ZASTOSOWANEGO no-show (detekcja replay → no-op). */
  last_applied_idempotency_key?: string | null
}

/**
 * Rozstrzyga wynik NO-SHOW (czysta funkcja): termin minął, ale WARTOŚĆ ZACHOWANA
 * (saldo nie przepada) — `value_preserved` + rebook dostępny (AC2, FR19). No-show NIE
 * podlega cutoffowi (termin już minął) ani NIE generuje derecognition (liability bez
 * zmiany). Idempotencja (T3): `idempotency_key` WYMAGANY; replay ⇒ `idempotent_replay:true`.
 *
 * UWAGA: ta funkcja modeluje politykę „recovery as care" (wartość zachowana). Tryb
 * `mark_no_show` z opłatą/forfeiture (Story 2.7 BE-6, `policy_snapshot.no_show`) jest
 * OSOBNĄ ścieżką profilowo-zależną — 4.6 NIE zmienia jej semantyki.
 */
export function determineNoShowOutcome(
  input: NoShowDeterminationInput
): CancellationDetermination {
  const replay = resolveReplay(
    "no_show",
    input.idempotency_key,
    input.last_applied_idempotency_key
  )
  return {
    kind: "no_show",
    tier: "value_preserved",
    value_preserved: true,
    derecognition: false,
    remaining_changed: false,
    expires_at_changed: false,
    rebookable: true,
    idempotent_replay: replay,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// REBOOK — INWARIANT „NIE skraca expires_at" (UX-DR-14 M-5)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Deterministyczny `expires_at` po rebooku: TOŻSAMY z bieżącym (rebook jest
 * neutralny dla ważności — zmienia WYŁĄCZNIE termin wizyty, NIGDY ważność vouchera).
 * Ważność = pierwotna polityka (4.2), niezależna od daty rebooku. Zwraca KOPIĘ Daty
 * (immutability), aby caller nie zmutował wejścia. Test regresyjny (UX-DR-14 M-5):
 * `computeRebookExpiresAt(x).getTime() === x.getTime()`.
 */
export function computeRebookExpiresAt(currentExpiresAt: Date): Date {
  return new Date(currentExpiresAt.getTime())
}

/**
 * Defense-in-depth guard INWARIANTU rebooku (UX-DR-14 M-5): rzuca {@link
 * RebookExpiryShorteningError} gdy proponowany `after` skraca ważność względem
 * `before`. Wydłużenie/równość są dozwolone (rebook nominalnie NIE zmienia ważności,
 * ale wydłużenie z innej ścieżki — np. extend 4.4 — NIE jest forfeiture). Gate łapie
 * WYŁĄCZNIE niedozwolone skrócenie.
 */
export function assertRebookPreservesExpiry(before: Date, after: Date): void {
  if (after.getTime() < before.getTime()) {
    throw new RebookExpiryShorteningError(before, after)
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Idempotencja — deterministyczne klucze (replay ⇒ jedna operacja)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Deterministyczny klucz idempotencji anulacji/no-show: per (entitlement_id,
 * dyskryminator wystąpienia). Stabilny przy replay (ta sama para ⇒ ten sam klucz) ⇒
 * ponowne to samo żądanie NIE podwaja audytu/postingu (delegacja do warstwy operacji).
 * `cancellation_seq` = monotoniczny dyskryminator (np. ULID / booking_pointer / numer).
 */
export function buildCancellationIdempotencyKey(
  entitlementId: string,
  cancellationSeq: string | number
): string {
  return `entitlement:${entitlementId}:cancellation:${String(cancellationSeq)}`
}

/**
 * Deterministyczny klucz idempotencji rebooku: per (entitlement_id, dyskryminator
 * wystąpienia rebooku). Stabilny przy replay ⇒ ponowny ten sam rebook NIE podwaja
 * audytu. `rebook_seq` = monotoniczny dyskryminator wystąpienia rebooku.
 */
export function buildRebookIdempotencyKey(
  entitlementId: string,
  rebookSeq: string | number
): string {
  return `entitlement:${entitlementId}:rebook:${String(rebookSeq)}`
}

// ──────────────────────────────────────────────────────────────────────────
// Copy ścieżki anulacji/no-show/rebook — anti-forfeiture (egzekwowane mechanicznie)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Domyślny komunikat anulacji/no-show — anti-forfeiture (recovery as care). NIGDY
 * nie komunikuje przepadku wartości; informuje, że saldo i ważność są zachowane,
 * a rebook dostępny. Egzekwowane przez {@link assertCancellationCopySafe} (reuse
 * `assertNoForfeitureCopy` z 4.2: przepad/utrat/forfeit).
 */
export function defaultCancellationMessage(tier: CancellationTier): string {
  return tier === "full_active"
    ? "Anulowano wizytę. Twój voucher pozostaje w pełni aktywny — saldo i ważność " +
        "bez zmian. Możesz zarezerwować nowy termin, kiedy zechcesz."
    : "Anulowano wizytę. Wartość Twojego vouchera jest zachowana — saldo i ważność " +
        "bez zmian. Zarezerwuj nowy termin, kiedy będzie Ci wygodnie."
}

/**
 * Domyślny komunikat rebooku — anti-forfeiture, podkreśla że ważność vouchera NIE
 * ulega skróceniu (UX-DR-14 M-5). Egzekwowane przez {@link assertCancellationCopySafe}.
 */
export function defaultRebookMessage(): string {
  return (
    "Zmieniono termin wizyty. Ważność Twojego vouchera pozostaje bez zmian — " +
    "rezerwacja nowego terminu nie skraca daty ważności."
  )
}

/**
 * MECHANICZNY gate copy ścieżki anulacji/no-show/rebook: brak sygnału PRZEPADKU
 * wartości (reuse `assertNoForfeitureCopy` z 4.2: przepad/utrat/forfeit). Twardy gate,
 * NIE review (anti-forfeiture invariant, AC2 / Anti-patterns).
 */
export function assertCancellationCopySafe(text: string): void {
  assertNoForfeitureCopy(text)
}

// ──────────────────────────────────────────────────────────────────────────
// Posting GATED — anulacja/no-show/rebook = NO posting (audit-only), liability bez zmiany
// ──────────────────────────────────────────────────────────────────────────

/** Powód no-op postingu na anulacji/no-show/rebook (ADR-139 D5 / §Granice). */
export const CANCELLATION_POSTING_NOOP_REASON: string =
  "cancellation/no-show/rebook = zwolnienie bookingu (booking pointer) — NIE redeem/refund; " +
  "entitlement liability (saldo i wartość) pozostaje BEZ ZMIANY, BRAK ruchu pieniądza ⇒ " +
  "BRAK postingu. Tranzycja routuje przez wireEntitlementTransition (event + audit), ALE " +
  "posting payload jest CELOWO POMINIĘTY ⇒ hook = audit-only (attempted:false, no-op). " +
  "Niezależnie posting globalnie GATED: runtime_enabled zostaje false (flip = E6/P6 finance " +
  "gate, ręczna decyzja P6). NIE fabrykujemy księgowania."

/**
 * Marker no-op postingu anulacji/no-show/rebook (fail-closed, dokumentacyjny). Te
 * tranzycje NIE niosą payloadu postingu ⇒ hook jest audit-only (`attempted:false`);
 * liability bez zmiany. Mirror `buildTransferPostingNoop` (4.5).
 */
export type CancellationPostingNoop = {
  /** Zawsze true — anulacja/no-show/rebook NIGDY nie księguje (booking-only). */
  noop: true
  reason: typeof CANCELLATION_POSTING_NOOP_REASON
}

/** Buduje marker no-op postingu anulacji/no-show/rebook (ADR-139 D5). NIE księguje. */
export function buildCancellationPostingNoop(): CancellationPostingNoop {
  return { noop: true, reason: CANCELLATION_POSTING_NOOP_REASON }
}

// ──────────────────────────────────────────────────────────────────────────
// Okablowanie tranzycji — JEDNOLITY punkt (3.4), audit-only, BEZ posting
// ──────────────────────────────────────────────────────────────────────────

/** Hint aktora dla audytu anulacji/no-show/rebook (rozróżnia tryb + próg w śladzie). */
export function cancellationActorHint(
  kind: CancellationKind,
  tier?: CancellationTier
): string {
  return tier ? `${kind}:${tier}` : kind
}

export type BuildCancellationWiringInput = {
  entitlement_id: string
  /** Bieżący stan L4 (anulacja/no-show/rebook NIE zmienia stanu — `from === to`, D-5). */
  state: EntitlementInstanceState
  scope: TransitionScope
  /** Tryb tranzycji (audit hint). */
  kind: CancellationKind
  /** Próg czasowy (audit hint; tylko dla `cancellation`). */
  tier?: CancellationTier
  /** Aktor tranzycji (envelope.v1). Domyślnie `customer` (klient anuluje/rebookuje). */
  actor?: TransitionActor
  /** Czas wystąpienia (ISO). Domyślnie `now` w builderze kopert. */
  occurred_at?: string
  /**
   * Dyskryminator WYSTĄPIENIA (cykl-safe key, 3.4 AI-Review-2) — np. klucz idempotencji
   * anulacji/rebooku. Różne wystąpienia ⇒ różne klucze korelacji event↔audit.
   */
  cancellation_seq: string | number
}

/**
 * Buduje `TransitionInput` dla tranzycji anulacji/no-show/rebook routowanej przez
 * JEDNOLITY punkt okablowania (3.4). KRYTYCZNE: `from === to` (= bieżący stan) — D-5,
 * taksonomia 13 stanów NIEZMIENIONA (anulacja/no-show/rebook to operacje na booking
 * pointerze, NIE dodają stanu/krawędzi). Posting payload CELOWO pominięty (`posting`
 * undefined) — liability bez zmiany ⇒ hook audit-only (patrz {@link buildCancellationPostingNoop}).
 */
export function buildCancellationTransitionInput(
  input: BuildCancellationWiringInput
): TransitionInput {
  return {
    from: input.state,
    to: input.state,
    entitlement_id: input.entitlement_id,
    scope: input.scope,
    actor: input.actor ?? "customer",
    actor_hint: cancellationActorHint(input.kind, input.tier),
    ...(input.occurred_at ? { occurred_at: input.occurred_at } : {}),
    transition_seq: input.cancellation_seq,
    // POSTING CELOWO pominięty — anulacja/no-show/rebook audit-only (liability bez zmiany).
  }
}

export type CancellationWiringResult = {
  event: TransitionEventEnvelope
  audit: TransitionAuditEnvelope
  /** Wynik posting hooka — ZAWSZE audit-only (`attempted:false`, brak payloadu). */
  posting: TransitionPostingResult
  /**
   * true gdy emit eventu zawiódł (best-effort; kompletność = reconciliation 2.6).
   * false gdy `emitEvent` nie podano w deps LUB emit powiódł się.
   */
  emitFailed: boolean
}

/**
 * Okablowuje tranzycję anulacji/no-show/rebook przez TE SAME prymitywy co reszta L4
 * (3.4): koperty `buildTransitionEnvelopes` (event + append-only audit) +
 * `runTransitionPostingHook` (bramkowany dwuwarstwowo). Tranzycja NIE niesie payloadu
 * postingu ⇒ hook zwraca audit-only no-op (`attempted:false`) — zero zapisu do
 * `voucher_ledger_*`, niezależnie od `runtime_enabled`. NIE woła `assertWiringTransition`
 * (`from === to` — booking pointer op, NIE krawędź grafu; assercję grafu rezerwujemy dla
 * realnych tranzycji stanu, D-5). Mirror `buildExtendWiring` (4.4). Reużywa zegara z
 * `deps.clock` (testowalność).
 */
export async function buildCancellationWiring(
  deps: Pick<
    TransitionWiringDeps,
    "ledgerWriter" | "postingActivation" | "clock"
  > & {
    /**
     * Append-only sink audytu — gdy podany, woła w obrębie tx callera (atomowy ze
     * zmianą booking pointera). Bez tego audyt jest budowany ale NIE persystowany —
     * caller musi zapewnić persystencję zwróconego `audit`.
     */
    appendAudit?: (audit: TransitionAuditEnvelope) => Promise<void>
    /**
     * Best-effort emit eventu tranzycji (wołany po hooku, idealnie post-COMMIT). Gdy
     * podany, emit wołany przez `emitTransitionEventAfterCommit` (retry 2×, NIE rzuca).
     * Fail NIE blokuje — kompletność = reconciliation 2.6.
     */
    emitEvent?: (event: TransitionEventEnvelope) => Promise<void>
  },
  input: BuildCancellationWiringInput
): Promise<CancellationWiringResult> {
  const now = deps.clock?.() ?? new Date()
  const transitionInput = buildCancellationTransitionInput(input)
  const { event, audit } = buildTransitionEnvelopes(transitionInput, now)

  // appendAudit w obrębie tx callera (atomowy ze zwolnieniem booking pointera).
  if (deps.appendAudit) {
    await deps.appendAudit(audit)
  }

  const posting = await runTransitionPostingHook(deps, transitionInput, now)

  // Best-effort emit eventu (post-COMMIT) — reuse emitTransitionEventAfterCommit z 3.4.
  let emitFailed = false
  if (deps.emitEvent) {
    emitFailed = await emitTransitionEventAfterCommit(deps.emitEvent, event)
  }

  return { event, audit, posting, emitFailed }
}
