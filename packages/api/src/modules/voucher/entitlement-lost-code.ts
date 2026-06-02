/**
 * entitlement-lost-code.ts — Story 4.7 (v1.11.0 Epic 4 / Wave 4 — lifecycle L4
 * lost-code recovery: void(old) + issue(new), transfer całego salda).
 *
 * Czysta logika ODZYSKU UTRACONEGO KODU + OKABLOWANIA pary tranzycji `void(old)` +
 * `issue(new)` (bez I/O) na istniejącej maszynie stanów L4. Charakter pracy =
 * wykorzystanie ISTNIEJĄCEGO okablowania `wireEntitlementTransition` (Story 3.4) +
 * fundamentu writera (Story 2.6) + dyscypliny niezmienności salda / derecognition
 * (Story 4.1) — Story 4.7 NIE reimplementuje writera ani nie dodaje równoległej
 * ścieżki postingu / nowego punktu okablowania.
 *
 * Model domenowy (recovery as care, anti-forfeiture): klient gubi KOD vouchera, nie
 * wartość. Odzysk = para tranzycji:
 *
 *   (1) `void(old)`  — stary (utracony) kod → VOIDED (stan terminalny, niewykorzystywalny);
 *   (2) `issue(new)` — nowy kod wystawiony jako GENEZA → ISSUED z PEŁNYM niewykorzystanym
 *                      saldem (`remaining`) i ZACHOWANĄ ważnością (`expires_at`) starego.
 *
 * To KONTYNUACJA tego samego zobowiązania (saldo + ważność przeniesione 1:1), NIE nowa
 * emisja-z-VAT ani breakage/derecognition — voucher NIE wygasł, klient NIE stracił wartości.
 *
 * DWA OKNA CZASOWE (AC1, FR20):
 *   - OKNO ZGŁOSZENIA 30 dni  — zgłoszenie utraty musi nastąpić w {@link
 *                               LOST_CODE_REPORT_WINDOW_DAYS} dni OD UTRATY (`lost_at` →
 *                               `reported_at`); poza oknem ⇒ fail-closed.
 *   - OKNO DECYZJI ≤7 dni     — decyzja operatora/PO musi nastąpić w {@link
 *                               LOST_CODE_DECISION_WINDOW_DAYS} dni OD ZGŁOSZENIA
 *                               (`reported_at` → `decided_at`); po oknie ⇒ fail-closed.
 * Walidacja OBU okien PRZED jakimkolwiek efektem ubocznym (`void`/`issue`/transfer).
 *
 * TRANSFER SALDA — DYSCYPLINA 4.1: nowy kod otrzymuje DOKŁADNIE `remaining` starego —
 * NIGDY ponad `remaining`, NIE inflacja/reissue wartości (ta sama reguła co redeem partial
 * 4.1). Suma salda zachowana (net-zero transferu); wartość chroniona (anti-forfeiture).
 *
 * ANTI-DOUBLE-SPEND (KRYTYCZNE): `void(old)` jest wykonywany ZANIM nowy kod jest aktywny —
 * w żadnym momencie nie istnieją DWA ważne (redeemowalne) kody z tym samym saldem. Po
 * `void` redeem starego kodu jest niemożliwy (VOIDED terminal, brak krawędzi wyjściowej).
 * Okablowanie ({@link buildLostCodeRecoveryWiring}) egzekwuje kolejność: NAJPIERW void,
 * POTEM issue.
 *
 * IDEMPOTENCJA: `recovery_id` deterministyczny ({@link buildLostCodeRecoveryId}); ten sam
 * `recovery_id` ⇒ JEDEN void + JEDEN issue (NIE wiele nowych voucherów). Replay ⇒ no-op
 * (`directive:"noop"`); `void` jednorazowy. Nowy kod (`deriveRecoveryEntitlementId`) jest
 * deterministyczny per `recovery_id` — replay daje TEN SAM id (dedup na warstwie operacji).
 *
 * KRYTYCZNE — recovery ≠ DERECOGNITION; posting GATED (ADR-139 D5 / §Granice):
 *   `void+issue` to KONTYNUACJA zobowiązania (saldo przeniesione), NIE breakage/derecognition
 *   (voucher nie wygasł, wartość nie przepadła) ⇒ para jest księgowo NET-ZERO (to samo
 *   liability, nowy identyfikator) — prawdopodobnie audit-only / brak nowego postingu.
 *   Gdzie księgowo niejasne ⇒ FAIL-CLOSED na audit-only: obie tranzycje routują przez
 *   TEN SAM jednolity punkt `wireEntitlementTransition` (3.4) co reszta L4 (event + audit +
 *   posting hook), ALE posting payload jest CELOWO POMINIĘTY ⇒ hook = audit-only
 *   (`attempted:false`, no-op). Niezależnie posting globalnie GATED: `runtime_enabled`
 *   zostaje `false` (hook inert, NIE pisze do `voucher_ledger_*`). Flip `false→true` =
 *   osobny P6 finance gate (E6/P6 + per-market signoff D-59), WYŁĄCZNIE ręczna decyzja
 *   P6 (Robert), NIE agent / NIE CI.
 *
 * GRANICE (AC2, D-5): NIE zmienia taksonomii stanów (`ALL_ENTITLEMENT_INSTANCE_STATES`,
 * 13 stanów) ani grafu `ALLOWED_ENTITLEMENT_TRANSITIONS` — `void` używa ISTNIEJĄCEJ krawędzi
 * `{ISSUED,ACTIVE} → VOIDED`, `issue` używa istniejącej GENEZY → ISSUED (Path Y 3.3 wiring).
 * NIE rusza hard-gate'ów `MPV_MULTI_VENDOR` (ADR-134) / `SUBSCRIPTION_B2C` (ADR-136) —
 * recovery single-vendor / bonbeauty-only. NIE reimplementuje writera/VAT.
 *
 * Podstawa normatywna (NFR4 — referencja, NIE autorstwo): ADR-139 (D3 posting hook =
 * wołanie writera, D5 governed activation — flip = P6), ADR-137 (event/envelope envelope.v1
 * / AR-EVENTS), ADR-133 (separacja entitlement↔money / ledger). Cross-ref: Story 4.1
 * (derecognition / niezmienność salda), 3.4 (wiring), 2.6 (writer).
 */

import { createHash } from "node:crypto"

import { LOST_CODE_REISSUE_WINDOW_DAYS } from "./entitlement-boundary"
import {
  EntitlementInstanceState,
  snapshotPolicy,
  type EntitlementPolicySnapshot,
} from "./models/entitlement"
import {
  buildGenesisIssuedTransition,
  emitTransitionEventAfterCommit,
  wireEntitlementTransitionPersisted,
  type TransitionActor,
  type TransitionAuditEnvelope,
  type TransitionEventEnvelope,
  type TransitionInput,
  type TransitionPostingResult,
  type TransitionScope,
  type TransitionWiringDeps,
} from "./entitlement-transition-wiring"

// ──────────────────────────────────────────────────────────────────────────
// Okna czasowe — zgłoszenie 30 dni (od utraty) + decyzja ≤7 dni (od zgłoszenia)
// ──────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * OKNO ZGŁOSZENIA utraty (dni): zgłoszenie utraty kodu musi nastąpić w {@link
 * LOST_CODE_REPORT_WINDOW_DAYS} dni OD UTRATY (`lost_at` → `reported_at`). Reużywa
 * platformową stałą {@link LOST_CODE_REISSUE_WINDOW_DAYS} (30) — nie market/vendor
 * konfigurowalne (FR20). Poza oknem ⇒ {@link LostCodeReportWindowError} (fail-closed).
 */
export const LOST_CODE_REPORT_WINDOW_DAYS = LOST_CODE_REISSUE_WINDOW_DAYS

/**
 * OKNO DECYZJI operatora/PO (dni): decyzja o odzysku musi nastąpić w {@link
 * LOST_CODE_DECISION_WINDOW_DAYS} dni OD ZGŁOSZENIA (`reported_at` → `decided_at`).
 * Po oknie ⇒ {@link LostCodeDecisionWindowError} (fail-closed). Stała platformowa (FR20).
 */
export const LOST_CODE_DECISION_WINDOW_DAYS = 7

/**
 * Inkluzywny check okna zgłoszenia (czysta funkcja, fail-closed): czy `reported_at`
 * mieści się w `windowDays` od `lost_at`. Zgłoszenie PRZED utratą (`reported < lost`)
 * jest niespójne danościowo ⇒ false (fail-closed). Niewiarygodne daty ⇒ false.
 */
export function isWithinReportWindow(
  lostAt: Date,
  reportedAt: Date,
  windowDays: number = LOST_CODE_REPORT_WINDOW_DAYS
): boolean {
  const lostMs = lostAt.getTime()
  const reportedMs = reportedAt.getTime()
  if (!Number.isFinite(lostMs) || !Number.isFinite(reportedMs)) return false
  const delta = reportedMs - lostMs
  return delta >= 0 && delta <= windowDays * DAY_MS
}

/**
 * Inkluzywny check okna decyzji (czysta funkcja, fail-closed): czy `decided_at`
 * mieści się w `windowDays` od `reported_at`. Decyzja PRZED zgłoszeniem
 * (`decided < reported`) jest niespójna ⇒ false (fail-closed). Niewiarygodne daty ⇒ false.
 */
export function isWithinDecisionWindow(
  reportedAt: Date,
  decidedAt: Date,
  windowDays: number = LOST_CODE_DECISION_WINDOW_DAYS
): boolean {
  const reportedMs = reportedAt.getTime()
  const decidedMs = decidedAt.getTime()
  if (!Number.isFinite(reportedMs) || !Number.isFinite(decidedMs)) return false
  const delta = decidedMs - reportedMs
  return delta >= 0 && delta <= windowDays * DAY_MS
}

// ──────────────────────────────────────────────────────────────────────────
// Precondition stanu — recovery dozwolony WYŁĄCZNIE ze stanów z saldem (fail-closed)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Stany L4 DOZWOLONE jako źródło `void(old)` przy odzysku (fail-closed): WYŁĄCZNIE
 * ISSUED / ACTIVE — stany z niewykorzystanym saldem, z których krawędź `→ VOIDED`
 * jest legalna (D-5, `ALLOWED_ENTITLEMENT_TRANSITIONS`). Stany zrealizowane
 * (REDEEMED_PARTIAL/REDEEMED_FULL/SETTLED/CLOSED), terminalne (VOIDED/REFUNDED) i wygasłe (EXPIRED) NIE
 * podlegają odzyskowi kodu — saldo już skonsumowane / wartość rozliczona / kod martwy.
 */
export const LOST_CODE_RECOVERABLE_STATES: ReadonlySet<EntitlementInstanceState> =
  new Set([
    EntitlementInstanceState.ISSUED,
    EntitlementInstanceState.ACTIVE,
  ])

// ──────────────────────────────────────────────────────────────────────────
// Błędy fail-closed
// ──────────────────────────────────────────────────────────────────────────

/** Rzucany gdy zgłoszenie utraty poza oknem 30 dni od utraty (fail-closed, AC1). */
export class LostCodeReportWindowError extends Error {
  readonly lost_at: string
  readonly reported_at: string
  readonly window_days: number
  constructor(lostAt: Date, reportedAt: Date, windowDays: number) {
    super(
      `lost-code: zgłoszenie utraty poza oknem — utrata ${lostAt.toISOString()}, ` +
        `zgłoszenie ${reportedAt.toISOString()} (okno ${windowDays} dni od utraty, ` +
        `fail-closed, brak void/issue/transferu; FR20).`
    )
    this.name = "LostCodeReportWindowError"
    this.lost_at = lostAt.toISOString()
    this.reported_at = reportedAt.toISOString()
    this.window_days = windowDays
  }
}

/** Rzucany gdy decyzja operatora poza oknem ≤7 dni od zgłoszenia (fail-closed, AC1). */
export class LostCodeDecisionWindowError extends Error {
  readonly reported_at: string
  readonly decided_at: string
  readonly window_days: number
  constructor(reportedAt: Date, decidedAt: Date, windowDays: number) {
    super(
      `lost-code: decyzja operatora poza oknem — zgłoszenie ${reportedAt.toISOString()}, ` +
        `decyzja ${decidedAt.toISOString()} (okno ${windowDays} dni od zgłoszenia, ` +
        `fail-closed, brak void/issue/transferu; FR20).`
    )
    this.name = "LostCodeDecisionWindowError"
    this.reported_at = reportedAt.toISOString()
    this.decided_at = decidedAt.toISOString()
    this.window_days = windowDays
  }
}

/**
 * Rzucany gdy odzysk żądany bez `recovery_id` (runtime-backstop, T1/idempotencja).
 * Bez deterministycznego `recovery_id` caller nie może zapewnić replay-safe
 * compare-and-set (jeden void+issue per id) — gate wymagany.
 */
export class LostCodeIdempotencyMissingError extends Error {
  constructor() {
    super(
      `lost-code: recovery_id jest WYMAGANY — bez niego nie można zapewnić ` +
        `idempotencji odzysku (jeden void+issue per id, replay ⇒ no-op). Podaj ` +
        `klucz z buildLostCodeRecoveryId().`
    )
    this.name = "LostCodeIdempotencyMissingError"
  }
}

/**
 * Rzucany gdy odzysk żądany na niedozwolonym stanie źródłowym (CR precondition,
 * fail-closed). Stary kod MUSI być w stanie z niewykorzystanym saldem (ISSUED/ACTIVE);
 * stany zrealizowane/terminalne/wygasłe ⇒ odzysk bezprzedmiotowy (brak salda do
 * przeniesienia / kod już martwy). Warstwa operacji MUSI sprawdzić stan PRZED wołaniem.
 */
export class LostCodePreconditionError extends Error {
  readonly state: EntitlementInstanceState
  constructor(state: EntitlementInstanceState) {
    super(
      `lost-code: niedozwolony stan źródłowy '${state}' — odzysk kodu dozwolony ` +
        `wyłącznie ze stanów z niewykorzystanym saldem ` +
        `(${[...LOST_CODE_RECOVERABLE_STATES].join("/")}). Stany zrealizowane/terminalne/` +
        `wygasłe ⇒ odzysk bezprzedmiotowy (fail-closed, AC1).`
    )
    this.name = "LostCodePreconditionError"
    this.state = state
  }
}

/**
 * Rzucany gdy transfer salda naruszałby dyscyplinę 4.1: `remaining` nieprawidłowy
 * (nie-skończony / ujemny) ⇒ nie można bezpiecznie przenieść wartości (fail-closed).
 * Transfer jest DOKŁADNIE 1:1 — NIGDY ponad `remaining`, NIE inflacja (mirror 4.1).
 */
export class LostCodeBalanceTransferError extends Error {
  readonly remaining: unknown
  constructor(remaining: unknown) {
    super(
      `lost-code: nieprawidłowe saldo '${String(remaining)}' do przeniesienia — ` +
        `wymagana liczba skończona ≥ 0 (transfer DOKŁADNIE 1:1, NIGDY ponad remaining, ` +
        `NIE inflacja wartości; dyscyplina 4.1, fail-closed).`
    )
    this.name = "LostCodeBalanceTransferError"
    this.remaining = remaining
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Idempotencja — deterministyczny recovery_id + deterministyczny nowy kod
// ──────────────────────────────────────────────────────────────────────────

/**
 * Deterministyczny `recovery_id` odzysku: per (old_entitlement_id, dyskryminator
 * wystąpienia). Stabilny przy replay (ta sama para ⇒ ten sam id) ⇒ ponowny ten sam
 * odzysk NIE tworzy drugiego void+issue (delegacja dedup do warstwy operacji). Spójny
 * z konwencją kluczy 3.4/4.5 (`buildTransferId`). `recovery_seq` = monotoniczny
 * dyskryminator (np. ULID / numer zgłoszenia).
 */
export function buildLostCodeRecoveryId(
  oldEntitlementId: string,
  recoverySeq: string | number
): string {
  return `entitlement:${oldEntitlementId}:lost-code-recovery:${String(recoverySeq)}`
}

/**
 * Deterministyczny id NOWEGO (recovery) entitlementu, wyprowadzony z `recovery_id`
 * (sha256, GP-XXXX-XXXX-XXXX). Stabilny przy replay (ten sam `recovery_id` ⇒ ten sam
 * nowy id) ⇒ replay NIE mnoży nowych voucherów (idempotencja, T1). Pełni rolę zarówno
 * klucza nowego wiersza, jak i nowego (czytelnego) kodu vouchera.
 *
 * Budżet kolizji: pierwsze 48 bitów SHA-256 → ~1 na 281T per kod, akceptowalne dla
 * niskoczęstej operacji admin (mirror legacy `generateReadableEntitlementCode`).
 */
export function deriveRecoveryEntitlementId(recoveryId: string): string {
  const digest = createHash("sha256")
    .update(recoveryId)
    .digest("hex")
    .toUpperCase()
  return `GP-${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`
}

// ──────────────────────────────────────────────────────────────────────────
// Transfer salda + zachowanie ważności (dyscyplina 4.1 — NIGDY ponad remaining)
// ──────────────────────────────────────────────────────────────────────────

/** Wynik przeniesienia salda 1:1 (net-zero) ze starego kodu na nowy. */
export type RecoveryBalanceTransfer = {
  /** Saldo starego kodu (minor units) — źródło. */
  remaining_old: number
  /** Saldo nowego kodu — DOKŁADNIE `remaining_old` (NIGDY ponad, NIE inflacja). */
  remaining_new: number
  /** Zawsze true — transfer jest net-zero względem zobowiązania (zachowanie wartości). */
  net_zero: true
}

/**
 * Oblicza transfer salda 1:1 (czysta funkcja, fail-closed, dyscyplina 4.1): nowy kod
 * otrzymuje DOKŁADNIE `remainingOld` — NIGDY ponad `remaining`, NIE inflacja/reissue
 * wartości. `remainingOld` musi być liczbą skończoną ≥ 0 ({@link LostCodeBalanceTransferError}
 * inaczej). Suma salda zachowana (net-zero); wartość chroniona (anti-forfeiture, FR20).
 */
export function computeRecoveryBalanceTransfer(
  remainingOld: number
): RecoveryBalanceTransfer {
  if (!Number.isFinite(remainingOld) || remainingOld < 0) {
    throw new LostCodeBalanceTransferError(remainingOld)
  }
  return {
    remaining_old: remainingOld,
    remaining_new: remainingOld,
    net_zero: true,
  }
}

/**
 * Deterministyczny `expires_at` nowego kodu: TOŻSAMY z ważnością starego (ważność
 * PRZENIESIONA, NIE liczona od daty odzysku — kontynuacja, anti-forfeiture). Zwraca
 * KOPIĘ Daty (immutability), aby caller nie zmutował wejścia. `null` (brak ważności)
 * przeniesiony wprost. Regresja: `computeRecoveryExpiresAt(x)?.getTime() === x.getTime()`.
 */
export function computeRecoveryExpiresAt(
  oldExpiresAt: Date | null
): Date | null {
  return oldExpiresAt == null ? null : new Date(oldExpiresAt.getTime())
}

// ──────────────────────────────────────────────────────────────────────────
// Determinacja odzysku — okna + precondition + idempotencja (fail-closed)
// ──────────────────────────────────────────────────────────────────────────

export type LostCodeRecoveryDeterminationInput = {
  /** Bieżący stan L4 starego (utraconego) kodu — musi być recoverable (ISSUED/ACTIVE). */
  old_state: EntitlementInstanceState
  /** Niewykorzystane saldo starego kodu (minor units) — przenoszone 1:1 na nowy. */
  remaining_old: number
  /** Moment utraty kodu (`lost_at`) — baza okna zgłoszenia 30 dni. */
  lost_at: Date
  /** Moment zgłoszenia utraty (`reported_at`) — w oknie 30 dni od `lost_at`. */
  reported_at: Date
  /** Moment decyzji operatora/PO (`decided_at`) — w oknie ≤7 dni od `reported_at`. */
  decided_at: Date
  /** Deterministyczny `recovery_id` bieżącego żądania (WYMAGANY, idempotencja). */
  recovery_id?: string
  /** `recovery_id` ostatnio ZASTOSOWANEGO odzysku (detekcja replay → no-op). */
  last_applied_recovery_id?: string | null
  /** Okno zgłoszenia (dni). Domyślnie {@link LOST_CODE_REPORT_WINDOW_DAYS}. */
  report_window_days?: number
  /** Okno decyzji (dni). Domyślnie {@link LOST_CODE_DECISION_WINDOW_DAYS}. */
  decision_window_days?: number
}

export type LostCodeRecoveryDetermination = {
  /**
   * Dyrektywa dla warstwy operacji:
   *   `"apply"` — nowe żądanie, caller wykonuje void(old)+issue(new).
   *   `"noop"`  — `idempotent_replay:true`, caller MUSI zwrócić ZAPAMIĘTANY wynik i
   *               NIE wykonywać ponownie void/issue (jeden void+issue per recovery_id).
   */
  directive: "apply" | "noop"
  /** Transfer salda 1:1 (net-zero) — `remaining_new == remaining_old`. */
  transfer: RecoveryBalanceTransfer
  /** Zawsze false — recovery to KONTYNUACJA (net-zero), NIE derecognition/breakage. */
  derecognition: false
  /** Zawsze true — para void+issue jest księgowo neutralna (to samo liability). */
  net_zero: true
  /** true gdy żądanie to replay już zastosowanego odzysku (no-op). */
  idempotent_replay: boolean
}

/**
 * Rozstrzyga EFEKT odzysku (czysta funkcja, fail-closed). Kolejność gardów:
 *
 *   1. `recovery_id` WYMAGANY ({@link LostCodeIdempotencyMissingError}).
 *   2. Replay (ten sam `recovery_id` co ostatnio zastosowany) ⇒ `idempotent_replay:true`,
 *      `directive:"noop"` — POMIJA gardy okien/precondition (operacja już raz zaszła,
 *      no-op; caller zwraca cached wynik, NIE re-throw).
 *   3. Precondition stanu ({@link LostCodePreconditionError}) — stary kod recoverable.
 *   4. Okno zgłoszenia 30 dni ({@link LostCodeReportWindowError}) — PRZED efektami ubocznymi.
 *   5. Okno decyzji ≤7 dni ({@link LostCodeDecisionWindowError}) — PRZED efektami ubocznymi.
 *   6. Transfer salda 1:1 ({@link computeRecoveryBalanceTransfer}, dyscyplina 4.1).
 *
 * KONTRAKT REPLAY: gdy `directive:"noop"`, warstwa operacji MUSI zwrócić ZAPAMIĘTANY
 * (pierwotny) wynik i NIE aplikować void/issue ponownie (mirror 4.6 CR-1).
 */
export function determineLostCodeRecoveryOutcome(
  input: LostCodeRecoveryDeterminationInput
): LostCodeRecoveryDetermination {
  if (!input.recovery_id) {
    throw new LostCodeIdempotencyMissingError()
  }

  const replay = input.recovery_id === input.last_applied_recovery_id

  // Transfer salda liczony zawsze (kształt wyniku stały) — fail-closed na złym saldzie
  // niezależnie od replay (replay też zwraca spójny transfer net-zero).
  const transfer = computeRecoveryBalanceTransfer(input.remaining_old)

  if (replay) {
    // Replay: operacja już raz zaszła — no-op, POMIJA gardy okien/precondition.
    return {
      directive: "noop",
      transfer,
      derecognition: false,
      net_zero: true,
      idempotent_replay: true,
    }
  }

  // 3. Precondition stanu — stary kod musi być recoverable (z saldem).
  if (!LOST_CODE_RECOVERABLE_STATES.has(input.old_state)) {
    throw new LostCodePreconditionError(input.old_state)
  }

  const reportWindow = input.report_window_days ?? LOST_CODE_REPORT_WINDOW_DAYS
  const decisionWindow =
    input.decision_window_days ?? LOST_CODE_DECISION_WINDOW_DAYS

  // 4. Okno zgłoszenia 30 dni (od utraty) — PRZED efektami ubocznymi.
  if (!isWithinReportWindow(input.lost_at, input.reported_at, reportWindow)) {
    throw new LostCodeReportWindowError(
      input.lost_at,
      input.reported_at,
      reportWindow
    )
  }

  // 5. Okno decyzji ≤7 dni (od zgłoszenia) — PRZED efektami ubocznymi.
  if (
    !isWithinDecisionWindow(input.reported_at, input.decided_at, decisionWindow)
  ) {
    throw new LostCodeDecisionWindowError(
      input.reported_at,
      input.decided_at,
      decisionWindow
    )
  }

  return {
    directive: "apply",
    transfer,
    derecognition: false,
    net_zero: true,
    idempotent_replay: false,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Posting GATED — recovery = NO posting (audit-only), kontynuacja net-zero
// ──────────────────────────────────────────────────────────────────────────

/** Powód no-op postingu na parze void+issue odzysku (ADR-139 D5 / §Granice). */
export const LOST_CODE_POSTING_NOOP_REASON: string =
  "lost-code recovery (void+issue) = KONTYNUACJA tego samego zobowiązania (saldo i ważność " +
  "przeniesione 1:1 na nowy identyfikator) — NIE breakage/derecognition (voucher nie wygasł, " +
  "klient nie stracił wartości). Para jest księgowo NET-ZERO (to samo liability) ⇒ BRAK nowego " +
  "postingu. Obie tranzycje routują przez wireEntitlementTransition (event + audit), ALE posting " +
  "payload jest CELOWO POMINIĘTY ⇒ hook = audit-only (attempted:false, no-op). Niezależnie posting " +
  "globalnie GATED: runtime_enabled zostaje false (flip = E6/P6 finance gate, ręczna decyzja P6). " +
  "Gdzie księgowo niejasne ⇒ fail-closed na audit-only. NIE fabrykujemy księgowania."

/**
 * Marker no-op postingu odzysku (fail-closed, dokumentacyjny). Para void+issue NIE niesie
 * payloadu postingu ⇒ hook jest audit-only (`attempted:false`); liability bez zmiany
 * (net-zero). Mirror `buildTransferPostingNoop` (4.5) / `buildCancellationPostingNoop` (4.6).
 */
export type LostCodePostingNoop = {
  /** Zawsze true — recovery NIGDY nie księguje (kontynuacja net-zero, audit-only). */
  noop: true
  reason: typeof LOST_CODE_POSTING_NOOP_REASON
}

/** Buduje marker no-op postingu odzysku (ADR-139 D5). NIE wykonuje księgowania. */
export function buildLostCodePostingNoop(): LostCodePostingNoop {
  return { noop: true, reason: LOST_CODE_POSTING_NOOP_REASON }
}

// ──────────────────────────────────────────────────────────────────────────
// Okablowanie pary tranzycji — JEDNOLITY punkt (3.4), audit-only, void→issue order
// ──────────────────────────────────────────────────────────────────────────

/** Hint aktora dla audytu `void(old)` (append-only ślad: KTO unieważnił + recovery_id). */
export function lostCodeVoidActorHint(
  operatorId: string | null,
  recoveryId: string
): string {
  return `lost-code:void:operator=${operatorId ?? "?"}:recovery=${recoveryId}`
}

/** Hint aktora dla audytu `issue(new)` (append-only ślad: KTO wystawił + recovery_id + nowy id). */
export function lostCodeReissueActorHint(
  operatorId: string | null,
  recoveryId: string,
  newEntitlementId: string
): string {
  return `lost-code:issue:operator=${operatorId ?? "?"}:recovery=${recoveryId}:new=${newEntitlementId}`
}

export type BuildLostCodeWiringInput = {
  /** Stary (utracony) entitlement_id — źródło `void`. */
  old_entitlement_id: string
  /** Bieżący stan starego kodu (recoverable: ISSUED/ACTIVE). */
  old_state: EntitlementInstanceState
  /** Id NOWEGO (recovery) kodu — domyślnie `deriveRecoveryEntitlementId(recovery_id)`. */
  new_entitlement_id?: string
  /** Scope tranzycji (ontologia FK 3.2) — wspólny dla void i issue (ten sam market). */
  scope: TransitionScope
  /** Deterministyczny `recovery_id` (cykl-safe key + dyskryminator audytu/idempotencji). */
  recovery_id: string
  /** Operator/PO podejmujący decyzję (audit hint; id-only, RODO minimal). */
  operator_id?: string | null
  /** Aktor tranzycji (envelope.v1). Domyślnie `admin` (operator unieważnia/wystawia). */
  actor?: TransitionActor
  /** Czas wystąpienia (ISO). Domyślnie `now` w builderze kopert. */
  occurred_at?: string
}

/**
 * Buduje `TransitionInput` dla `void(old)`: krawędź `{ISSUED,ACTIVE} → VOIDED` (istniejąca,
 * D-5). Posting payload CELOWO pominięty (`posting` undefined) — recovery = kontynuacja
 * net-zero ⇒ hook audit-only (patrz {@link buildLostCodePostingNoop}). `transition_seq` =
 * `recovery_id` (cykl-safe key); `actor_hint` koduje KTO unieważnił + recovery_id (AC2).
 * Fail-closed precondition: stan musi być recoverable ({@link LostCodePreconditionError}).
 */
export function buildLostCodeVoidTransitionInput(
  input: BuildLostCodeWiringInput
): TransitionInput {
  if (!LOST_CODE_RECOVERABLE_STATES.has(input.old_state)) {
    throw new LostCodePreconditionError(input.old_state)
  }
  return {
    from: input.old_state,
    to: EntitlementInstanceState.VOIDED,
    entitlement_id: input.old_entitlement_id,
    scope: input.scope,
    actor: input.actor ?? "admin",
    actor_hint: lostCodeVoidActorHint(
      input.operator_id ?? null,
      input.recovery_id
    ),
    ...(input.occurred_at ? { occurred_at: input.occurred_at } : {}),
    transition_seq: input.recovery_id,
    // POSTING CELOWO pominięty — recovery audit-only (kontynuacja net-zero, NIE derecognition).
  }
}

/**
 * Buduje `TransitionInput` dla `issue(new)`: GENEZA → ISSUED (Path Y live-issue wiring 3.4,
 * istniejąca — D-5). Nowy kod startuje w ISSUED z PRZENIESIONYM saldem/ważnością (warstwa
 * operacji persystuje `remaining_new`/`expires_at`). Posting payload CELOWO pominięty —
 * audit-only (net-zero). `actor_hint` koduje KTO wystawił + recovery_id + nowy id (AC2);
 * `transition_seq` = `recovery_id` dla korelacji void↔issue tej samej operacji.
 */
export function buildLostCodeReissueGenesisInput(
  input: BuildLostCodeWiringInput,
  newEntitlementId: string
): TransitionInput {
  return buildGenesisIssuedTransition({
    entitlement_id: newEntitlementId,
    scope: { ...input.scope, instance_id: newEntitlementId },
    actor: input.actor ?? "admin",
    actor_hint: lostCodeReissueActorHint(
      input.operator_id ?? null,
      input.recovery_id,
      newEntitlementId
    ),
    ...(input.occurred_at ? { occurred_at: input.occurred_at } : {}),
    transition_seq: input.recovery_id,
    // POSTING CELOWO pominięty — issue(new) audit-only (kontynuacja net-zero).
  })
}

/** Wynik okablowania POJEDYNCZEJ tranzycji odzysku (void lub issue). */
export type LostCodeLegResult = {
  event: TransitionEventEnvelope
  audit: TransitionAuditEnvelope
  /** Wynik posting hooka — ZAWSZE audit-only (`attempted:false`, brak payloadu). */
  posting: TransitionPostingResult
  /** true gdy emit eventu zawiódł (best-effort; kompletność = reconciliation 2.6). */
  emitFailed: boolean
}

export type LostCodeRecoveryWiringResult = {
  /** Id nowego (recovery) kodu (deterministyczny per recovery_id). */
  new_entitlement_id: string
  /** Okablowanie `void(old)` — wykonane PIERWSZE (anti-double-spend). */
  void: LostCodeLegResult
  /** Okablowanie `issue(new)` — wykonane PO void (stary już terminalny). */
  issue: LostCodeLegResult
}

/**
 * Okablowuje PARĘ tranzycji odzysku przez JEDNOLITY punkt (3.4), egzekwując KOLEJNOŚĆ
 * ANTI-DOUBLE-SPEND: NAJPIERW `void(old)` (stary kod → VOIDED, terminal, niewykorzystywalny),
 * POTEM `issue(new)` (nowy kod genezą → ISSUED z przeniesionym saldem). W żadnym momencie
 * nie istnieją dwa ważne kody z tym samym saldem.
 *
 * Każda noga przechodzi przez `wireEntitlementTransitionPersisted`:
 *   (1) `assertWiringTransition` fail-closed (void: krawędź grafu; issue: geneza → ISSUED),
 *   (2) append-only audit (kto/co/kiedy/scope/wynik) atomowo w tx callera,
 *   (3) posting hook AUDIT-ONLY (brak payloadu ⇒ `attempted:false`, no-op; runtime_enabled=false).
 * Eventy obu nóg emitowane best-effort PO hooku (`emitTransitionEventAfterCommit`).
 *
 * KONTRAKT POST-COMMIT (3.4 AI-Review-3): dla ścieżek z REALNĄ DB-tx POMIŃ `emitEvent`
 * i emituj `res.void.event` / `res.issue.event` DOPIERO PO commit (inaczej rollback =
 * phantom-event). Dla testów / in-memory (bez granicy commit) użycie `emitEvent` jest OK.
 *
 * Determinacja okien/precondition/idempotencji deleguje do {@link determineLostCodeRecoveryOutcome}
 * (woła PRZED okablowaniem, fail-closed). Ta funkcja zakłada `directive:"apply"` (replay no-op
 * obsługiwany przez warstwę operacji — NIE woła okablowania).
 */
export async function buildLostCodeRecoveryWiring(
  deps: Pick<
    TransitionWiringDeps,
    "ledgerWriter" | "postingActivation" | "clock"
  > & {
    /** Append-only sink audytu (w obrębie tx callera — atomowy ze zmianą stanu). */
    appendAudit?: (audit: TransitionAuditEnvelope) => Promise<void>
    /** Best-effort emit eventu (post-COMMIT). Fail NIE blokuje (kompletność = reconciliation 2.6). */
    emitEvent?: (event: TransitionEventEnvelope) => Promise<void>
  },
  input: BuildLostCodeWiringInput
): Promise<LostCodeRecoveryWiringResult> {
  const newEntitlementId =
    input.new_entitlement_id ?? deriveRecoveryEntitlementId(input.recovery_id)

  const persistDeps: Pick<
    TransitionWiringDeps,
    "appendAudit" | "ledgerWriter" | "postingActivation" | "clock"
  > = {
    appendAudit: deps.appendAudit ?? (async () => {}),
    ...(deps.ledgerWriter ? { ledgerWriter: deps.ledgerWriter } : {}),
    ...(deps.postingActivation
      ? { postingActivation: deps.postingActivation }
      : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
  }

  // ── (1) ANTI-DOUBLE-SPEND: void(old) NAJPIERW — stary kod terminalny przed issue. ──
  const voidInput = buildLostCodeVoidTransitionInput(input)
  const voidWired = await wireEntitlementTransitionPersisted(persistDeps, voidInput)
  let voidEmitFailed = false
  if (deps.emitEvent) {
    voidEmitFailed = await emitTransitionEventAfterCommit(
      deps.emitEvent,
      voidWired.event
    )
  }

  // ── (2) issue(new) PO void — nowy kod genezą → ISSUED z przeniesionym saldem. ──
  const issueInput = buildLostCodeReissueGenesisInput(input, newEntitlementId)
  const issueWired = await wireEntitlementTransitionPersisted(
    persistDeps,
    issueInput
  )
  let issueEmitFailed = false
  if (deps.emitEvent) {
    issueEmitFailed = await emitTransitionEventAfterCommit(
      deps.emitEvent,
      issueWired.event
    )
  }

  return {
    new_entitlement_id: newEntitlementId,
    void: {
      event: voidWired.event,
      audit: voidWired.audit,
      posting: voidWired.posting,
      emitFailed: voidEmitFailed,
    },
    issue: {
      event: issueWired.event,
      audit: issueWired.audit,
      posting: issueWired.posting,
      emitFailed: issueEmitFailed,
    },
  }
}

/**
 * Buduje snapshot polityki dla nowego (recovery) kodu — TOŻSAMY z polityką starego
 * (kontynuacja: ta sama polityka, nowy identyfikator). Reużywa `snapshotPolicy` (deep
 * freeze + structural clone) by nowy wiersz nie współdzielił referencji ze starym.
 */
export function cloneRecoveryPolicySnapshot(
  oldPolicySnapshot: EntitlementPolicySnapshot
): EntitlementPolicySnapshot {
  return snapshotPolicy(oldPolicySnapshot as Record<string, unknown>)
}
