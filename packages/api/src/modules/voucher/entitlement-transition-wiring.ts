/**
 * entitlement-transition-wiring.ts — Story 3.4 (v1.11.0 Epic 3 / Wave 3).
 * Okablowanie maszyny stanów L4: KAŻDA dozwolona tranzycja → trzy efekty uboczne
 * w JEDNYM deterministycznym punkcie (NIE rozproszone per call-site, AC1):
 *
 *   (1) EVENT do outboxu — best-effort, post-COMMIT, naming AR-EVENTS,
 *       envelope `envelope.v1`. Emit NIE blokuje tranzycji; przy 2× fail
 *       kompletność gwarantuje reconciliation-inwariant z 2.6 (ADR-139 D2).
 *   (2) AUDIT envelope — append-only, niemutowalny ślad (kto / co / kiedy /
 *       scope / wynik). Działa niezależnie od postingu (nawet runtime_enabled=false).
 *   (3) POSTING HOOK — wołanie idempotentnego `ledger-writer` (Story 2.6),
 *       ujście dla `generateVoucherPosting()` (Story 2.3). Hook NIE reimplementuje
 *       posting/VAT logiki. Idempotencja deterministyczna delegowana do writera
 *       (`transaction_id` sha256, dedup-first; replay tranzycji ⇒ no-op posting).
 *
 * GRANICA (D-5 / ADR-139 D5) — HOOK ≠ AKTYWACJA POSTINGU:
 *   Posting hook jest PODPIĘTY i WOŁANY, ale FAKTYCZNA persystencja jest
 *   BRAMKOWANA DWUWARSTWOWO (governed activation):
 *     warstwa A (global)     — `runtime_enabled` (`VOUCHER_LIABILITY_ONLY_V1`,
 *                              trwale `false`; flip = ręczna decyzja P6 / E6).
 *     warstwa B (per-market) — per-market signoff (D-59; domyślnie zamknięte).
 *   Hook persystuje TYLKO gdy OBIE warstwy on. Gdy którakolwiek off ⇒ hook
 *   jest podpięty (zdolność okablowana) ale **audit-only / no-op** — NIE pisze
 *   do `voucher_ledger_*`. To OKABLOWANIE, NIE aktywacja. Domyślna bramka
 *   `defaultPostingActivationGate()` czyta REALNĄ flagę (false) — NIGDY jej nie
 *   flipuje. Testy symulują "on" przez WSTRZYKNIĘCIE bramki (seam testowy),
 *   co NIE modyfikuje produkcyjnej stałej ani nie aktywuje postingu w runtime.
 *
 * NIE zmienia taksonomii stanów (AC3): konsumuje istniejące `assertTransition` /
 * `ALLOWED_ENTITLEMENT_TRANSITIONS` / `ALL_ENTITLEMENT_INSTANCE_STATES` (13 stanów,
 * D-5) — dodaje WYŁĄCZNIE okablowanie efektów ubocznych.
 *
 * Podstawa normatywna (NFR4 — referencja, NIE autorstwo): ADR-137 (Path Y events /
 * envelope.v1 / dwupoziomowa idempotencja), ADR-139 (D3 posting hook = wołanie
 * writera, D5 governed activation dwuwarstwowa), ADR-133 (separacja entitlement↔money).
 */

import {
  EntitlementInstanceState,
  assertTransition,
} from "./models/entitlement"
import {
  generateVoucherPosting,
  VOUCHER_LIABILITY_ONLY_V1,
  type VoucherPostingInput,
  type LedgerScope,
} from "./posting-profile"
import {
  deriveLedgerTransactionId,
  type LedgerLifecycleDiscriminator,
  type VoucherLedgerWriteRequest,
  type VoucherLedgerWriteResult,
} from "./ledger-writer"

// ──────────────────────────────────────────────────────────────────────────
// Geneza (creation) vs tranzycja grafu (AI-Review-1 — okablowanie ISSUED live)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Sentinel `from` dla GENEZY (creation) — wiersz tworzony WPROST w stanie
 * docelowym, bez wcześniejszego stanu persystowanego. Path Y live-issue (3.3)
 * tworzy `entitlement_instance` od razu w ISSUED — to NIE jest tranzycja grafu
 * (do ISSUED nie prowadzi żadna krawędź `ALLOWED_ENTITLEMENT_TRANSITIONS`), lecz
 * geneza. Modelujemy ją jawnym sentinelem zamiast naciągać graf (AC3: taksonomia
 * 13 stanów + krawędzie pozostają NIEZMIENIONE — sentinel żyje wyłącznie w
 * warstwie okablowania, NIE w `models/entitlement.ts`).
 *
 * Fail-closed: JEDYNYM legalnym celem genezy jest ISSUED (patrz
 * `assertWiringTransition`); geneza do dowolnego innego stanu rzuca.
 */
export const ENTITLEMENT_GENESIS = "__genesis__" as const

/** `from` okablowania: realny stan grafu LUB sentinel genezy (creation → ISSUED). */
export type TransitionFromState =
  | EntitlementInstanceState
  | typeof ENTITLEMENT_GENESIS

/** Rzucane gdy geneza celuje w stan inny niż ISSUED (fail-closed, AC2). */
export class EntitlementGenesisError extends Error {
  readonly to: EntitlementInstanceState
  constructor(to: EntitlementInstanceState) {
    super(
      `Illegal entitlement genesis: ${ENTITLEMENT_GENESIS} → ${to}. ` +
        `Geneza (creation) dozwolona wyłącznie do ISSUED (Path Y live-issue).`
    )
    this.name = "EntitlementGenesisError"
    this.to = to
  }
}

/**
 * Fail-closed guard tranzycji okablowania (AC2). Dla genezy (`from` = sentinel)
 * jedyny legalny cel to ISSUED; dla realnego stanu deleguje do `assertTransition`
 * (graf `ALLOWED_ENTITLEMENT_TRANSITIONS` = SSOT). RZUCA zanim powstanie
 * jakikolwiek efekt uboczny.
 */
export function assertWiringTransition(
  from: TransitionFromState,
  to: EntitlementInstanceState
): void {
  if (from === ENTITLEMENT_GENESIS) {
    if (to !== EntitlementInstanceState.ISSUED) {
      throw new EntitlementGenesisError(to)
    }
    return
  }
  assertTransition(from, to)
}

// ──────────────────────────────────────────────────────────────────────────
// Kontrakt eventu (AR-EVENTS naming + envelope.v1)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Domenowy event tranzycji L4 (AR-EVENTS naming, envelope.v1). JEDNOLITY dla
 * każdej dozwolonej tranzycji (audytowalność = jednolitość okablowania). Dla
 * ISSUED domyka Path Y z 3.3 (subscriber tworzy ISSUED; ta warstwa czyni JEJ
 * tranzycję — i każdej kolejnej — emitowalną/audytowalną/księgowalną).
 */
export const ENTITLEMENT_STATE_CHANGED_EVENT_TYPE =
  "gp.entitlements.entitlement_state_changed.v1" as const

/** Aktor domenowy audytu tranzycji. */
export type TransitionActor = "system" | "customer" | "vendor" | "admin"

/** Aktor publicznego eventu envelope.v1 (`actor` enum z envelope.v1.schema.json). */
export type TransitionEventActor =
  | "system"
  | "end_customer"
  | "vendor_user"
  | "market_operator"

/**
 * Scope tranzycji (ontologia FK 3.2). `instance_id` + `market_id` wymagane
 * (fail-closed izolacja per-market, NFR3); `sales_channel_id` / `vendor_id` /
 * `location_id` opcjonalne (uzupełniane z ontologii gdy dostępne).
 */
export type TransitionScope = {
  instance_id: string
  market_id: string
  sales_channel_id?: string | null
  vendor_id?: string | null
  location_id?: string | null
}

/** Event do outboxu (best-effort, post-COMMIT) — koperta envelope.v1. */
export type TransitionEventEnvelope = {
  schema_version: "1"
  event_type: typeof ENTITLEMENT_STATE_CHANGED_EVENT_TYPE
  occurred_at: string
  actor: TransitionEventActor
  scope: Pick<TransitionScope, "instance_id" | "market_id" | "vendor_id" | "location_id">
  idempotency_key: string
  payload: {
    entitlement_id: string
    /** Stan źródłowy LUB sentinel genezy `__genesis__` (creation → ISSUED). */
    from_state: TransitionFromState
    to_state: EntitlementInstanceState
    transitioned_at: string
    actor_hint?: string
  }
}

/**
 * Append-only audit envelope (niemutowalny ślad tranzycji). Pokrywa pięć osi:
 *   kto    → `actor` (+ `actor_hint`)
 *   co     → `event_type` + (`from_state` → `to_state`)
 *   kiedy  → `occurred_at`
 *   scope  → `scope` (market_id / sales_channel_id z ontologii 3.2)
 *   wynik  → `outcome` (`transitioned`)
 * Audyt jest NIEZALEŻNY od postingu — powstaje także gdy `runtime_enabled=false`.
 */
export type TransitionAuditEnvelope = {
  schema_version: "1"
  // kto
  actor: TransitionActor
  actor_hint?: string
  // co
  event_type: typeof ENTITLEMENT_STATE_CHANGED_EVENT_TYPE
  from_state: TransitionFromState
  to_state: EntitlementInstanceState
  // kiedy
  occurred_at: string
  // scope
  scope: TransitionScope
  // wynik
  outcome: "transitioned"
  entitlement_id: string
  idempotency_key: string
}

// ──────────────────────────────────────────────────────────────────────────
// Posting hook — payload + bramka aktywacji dwuwarstwowa (ADR-139 D5)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Payload postingu dostarczany przez callera (detal finansowy = jego domena).
 * Wiring SAM liczy deterministyczny `transaction_id` (ADR-139 D3) z dyskryminatora
 * — dlatego payload go NIE niesie (Omit). `scope`/`occurred_at` opcjonalne:
 * gdy brak, dziedziczone ze scope/occurred_at tranzycji.
 *
 * Zakres 3.4: posting na ISSUED (domknięcie 3.3). Derecognition REDEEMED/EXPIRED
 * (pełna) = E4 — ale dyskryminator REDEEMED/EXPIRED jest tu obsłużony generycznie,
 * by E4 mógł reużyć ten sam punkt okablowania bez zmiany kontraktu.
 */
export type TransitionPostingPayload = Omit<
  VoucherPostingInput,
  "transaction_id" | "scope" | "occurred_at"
> & {
  /** Domyślnie scope tranzycji (instance_id + market_id + opcjonalne). */
  scope?: LedgerScope
  /** Domyślnie occurred_at tranzycji. */
  occurred_at?: string
  /** REDEEMED: wymagany dyskryminator (multi-installment-safe, ADR-139 D3). */
  redemption_id?: string | null
  /** EXPIRED/BREAKAGE: wymagany dyskryminator (snapshot rezydualnego brutto). */
  remaining_gross_snapshot?: number | null
  /** Opcjonalny currency consistency guard (writer fail-closed). */
  expected_currency?: string
}

/**
 * Bramka aktywacji postingu DWUWARSTWOWA (governed activation, ADR-139 D5).
 * Persystencja TYLKO gdy OBIE warstwy on. Domyślnie obie zamknięte (fail-closed).
 */
export type PostingActivationGate = {
  /** Warstwa A (global): `runtime_enabled`. Domyślnie REALNA flaga (false). */
  runtimeEnabled: boolean
  /** Warstwa B (per-market): signoff D-59. Domyślnie zamknięte. */
  isMarketActivated: (marketId: string) => boolean
}

/**
 * Domyślna bramka: czyta REALNĄ `VOUCHER_LIABILITY_ONLY_V1.runtime_enabled`
 * (trwale `false`) i domyślnie ZAMYKA warstwę per-market (signoff = D-59/E6/P6).
 * NIGDY nie flipuje produkcyjnej flagi — odzwierciedla ją. Aktywacja postingu =
 * osobna ręczna decyzja P6 (flip stałej + per-market signoff), NIE ten kod.
 */
export function defaultPostingActivationGate(): PostingActivationGate {
  return {
    runtimeEnabled: VOUCHER_LIABILITY_ONLY_V1.runtime_enabled,
    isMarketActivated: () => false,
  }
}

/** Wynik posting hooka — rozróżnia bramkowany no-op od faktycznej persystencji. */
export type TransitionPostingResult = {
  /** true gdy hook miał payload do zaksięgowania (ISSUED itp.). */
  attempted: boolean
  /** true gdy obie warstwy bramki on (próba realnej persystencji). */
  activated: boolean
  /** true gdy writer fizycznie zapisał wpis (false = dedup/no-op/no-payload). */
  persisted: boolean
  /** true gdy replay (writer ON CONFLICT) ⇒ no-op idempotentny. */
  deduped: boolean
  /** Deterministyczny transaction_id (gdy posting policzony). */
  transaction_id?: string
  /** Człowieko-czytelny powód no-op (bramka off / posted:false / brak payloadu). */
  reason?: string
}

/** Sygnatura writera potrzebna hookowi (podzbiór `VoucherLedgerWriter`). */
export type TransitionLedgerWriter = {
  write: (req: VoucherLedgerWriteRequest) => Promise<VoucherLedgerWriteResult>
}

// ──────────────────────────────────────────────────────────────────────────
// Wejście / wyjście / zależności wiring
// ──────────────────────────────────────────────────────────────────────────

export type TransitionInput = {
  /** Stan źródłowy LUB `ENTITLEMENT_GENESIS` (creation → ISSUED, Path Y 3.3). */
  from: TransitionFromState
  to: EntitlementInstanceState
  entitlement_id: string
  scope: TransitionScope
  actor: TransitionActor
  actor_hint?: string
  /** Domyślnie `now`. */
  occurred_at?: string
  /**
   * Dyskryminator WYSTĄPIENIA tranzycji (AI-Review-2 — cykl-safe idempotency_key).
   * Graf zawiera legalne CYKLE (np. `ACTIVE↔DISPUTED`, `REFUND_REQUESTED→ACTIVE→…`),
   * w których ta sama para `from→to` powtarza się legalnie. Sam `from→to` NIE
   * dyskryminuje wystąpień ⇒ append-only audit zwijałby drugie wystąpienie.
   * Podaj monotoniczny per-entitlement dyskryminator (np. ULID / numer sekwencji
   * tranzycji / redemption_id). Gdy brak — kluczem wystąpienia jest `occurred_at`
   * (znacznik czasu), co rozróżnia różne-w-czasie wystąpienia tej samej krawędzi.
   */
  transition_seq?: string | number
  /**
   * Payload postingu. Obecny ⇒ hook próbuje zaksięgować (bramkowany). Brak ⇒
   * hook podpięty ale bez payloadu (tranzycja niefinansowa / derecognition=E4).
   */
  posting?: TransitionPostingPayload
}

export type TransitionWiringDeps = {
  /** Append-only sink audytu (w obrębie tx callera — atomowy ze zmianą stanu). */
  appendAudit: (audit: TransitionAuditEnvelope) => Promise<void>
  /** Best-effort emit eventu (post-COMMIT). Fail NIE blokuje tranzycji. */
  emitEvent: (event: TransitionEventEnvelope) => Promise<void>
  /** Idempotentny writer ledgera (2.6). Wołany tylko gdy bramka aktywuje posting. */
  ledgerWriter?: TransitionLedgerWriter
  /** Bramka aktywacji (domyślnie `defaultPostingActivationGate()`). */
  postingActivation?: PostingActivationGate
  /** Zegar (testowalność). Domyślnie `() => new Date()`. */
  clock?: () => Date
}

export type TransitionWiringResult = {
  event: TransitionEventEnvelope
  audit: TransitionAuditEnvelope
  posting: TransitionPostingResult
  /** true gdy 2× emit eventu zawiódł (best-effort) — kompletność = reconciliation 2.6. */
  emitFailed: boolean
}

// ──────────────────────────────────────────────────────────────────────────
// Buildery (czyste, deterministyczne)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Deterministyczny, CYKL-SAFE idempotency_key tranzycji (AI-Review-2). Klucz
 * koreluje event↔audit dla TEGO SAMEGO wystąpienia tranzycji i jest stabilny
 * przy replay (te same wejścia ⇒ ten sam klucz). KRYTYCZNE: zawiera dyskryminator
 * WYSTĄPIENIA (`occurrence`), więc legalne POWTÓRZENIE tej samej krawędzi grafu
 * w cyklu (np. `ACTIVE→DISPUTED→ACTIVE→DISPUTED`) daje RÓŻNE klucze — append-only
 * audit NIE zwija drugiego, legalnego wystąpienia. `occurrence` = jawny
 * `transition_seq` (monotoniczny per entitlement) gdy podany, inaczej `occurred_at`
 * (znacznik czasu rozróżniający różne-w-czasie wystąpienia).
 *
 * Idempotencja POSTINGU jest osobna i finansowo-poprawna — deterministyczny
 * `transaction_id` writera (sha256 + dyskryminator REDEEMED/EXPIRED, ADR-139 D3);
 * TEN klucz jest WYŁĄCZNIE dla korelacji/deduplikacji śladu event↔audit.
 */
function buildTransitionIdempotencyKey(
  entitlementId: string,
  from: TransitionFromState,
  to: EntitlementInstanceState,
  occurrence: string
): string {
  return `entitlement:${entitlementId}:transition:${from}->${to}@${occurrence}`
}

function toEnvelopeActor(actor: TransitionActor): TransitionEventActor {
  switch (actor) {
    case "customer":
      return "end_customer"
    case "vendor":
      return "vendor_user"
    case "admin":
      return "market_operator"
    default:
      return "system"
  }
}

/**
 * Buduje parę kopert (event + audit) dla tranzycji. CZYSTA funkcja — bez I/O,
 * bez bramki, bez side-effectów. AC1 (kształt) + AC3 (brak zmiany taksonomii)
 * testują przez nią. NIE woła `assertTransition` (to robi orkiestrator PRZED).
 */
export function buildTransitionEnvelopes(
  input: TransitionInput,
  now: Date
): { event: TransitionEventEnvelope; audit: TransitionAuditEnvelope } {
  const occurredAt = input.occurred_at ?? now.toISOString()
  // Dyskryminator wystąpienia (AI-Review-2): jawny `transition_seq` gdy podany,
  // inaczej `occurred_at` — w obu wariantach legalny cykl daje różne klucze.
  const occurrence =
    input.transition_seq != null ? String(input.transition_seq) : occurredAt
  const idempotencyKey = buildTransitionIdempotencyKey(
    input.entitlement_id,
    input.from,
    input.to,
    occurrence
  )
  const auditScope: TransitionScope = {
    instance_id: input.scope.instance_id,
    market_id: input.scope.market_id,
    sales_channel_id: input.scope.sales_channel_id ?? null,
    vendor_id: input.scope.vendor_id ?? null,
    location_id: input.scope.location_id ?? null,
  }
  const eventScope: TransitionEventEnvelope["scope"] = {
    instance_id: auditScope.instance_id,
    market_id: auditScope.market_id,
    vendor_id: auditScope.vendor_id ?? null,
    location_id: auditScope.location_id ?? null,
  }

  const event: TransitionEventEnvelope = {
    schema_version: "1",
    event_type: ENTITLEMENT_STATE_CHANGED_EVENT_TYPE,
    occurred_at: occurredAt,
    actor: toEnvelopeActor(input.actor),
    scope: eventScope,
    idempotency_key: idempotencyKey,
    payload: {
      entitlement_id: input.entitlement_id,
      from_state: input.from,
      to_state: input.to,
      transitioned_at: occurredAt,
      ...(input.actor_hint ? { actor_hint: input.actor_hint } : {}),
    },
  }

  const audit: TransitionAuditEnvelope = {
    schema_version: "1",
    actor: input.actor,
    ...(input.actor_hint ? { actor_hint: input.actor_hint } : {}),
    event_type: ENTITLEMENT_STATE_CHANGED_EVENT_TYPE,
    from_state: input.from,
    to_state: input.to,
    occurred_at: occurredAt,
    scope: auditScope,
    outcome: "transitioned",
    entitlement_id: input.entitlement_id,
    idempotency_key: idempotencyKey,
  }

  return { event, audit }
}

// ──────────────────────────────────────────────────────────────────────────
// Posting hook (bramkowany dwuwarstwowo)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Posting hook: woła idempotentny writer (2.6) z payloadem tranzycji — ALE
 * faktyczna persystencja jest BRAMKOWANA dwuwarstwowo (ADR-139 D5). Gdy
 * którakolwiek warstwa off ⇒ audit-only no-op (NIE woła writera). Idempotencja
 * (replay ⇒ no-op) delegowana do writera (deterministyczny `transaction_id`).
 *
 * Hook NIE reimplementuje posting/VAT logiki — `generateVoucherPosting()` (2.3)
 * + `VoucherLedgerWriter` (2.6) są jedynymi źródłami. Hook tylko liczy
 * deterministyczny id i bramkuje persystencję.
 */
export async function runTransitionPostingHook(
  deps: Pick<
    TransitionWiringDeps,
    "ledgerWriter" | "postingActivation"
  >,
  input: TransitionInput,
  now: Date
): Promise<TransitionPostingResult> {
  const posting = input.posting
  if (!posting) {
    // Hook podpięty, ale brak payloadu finansowego (tranzycja niefinansowa /
    // derecognition REDEEMED/EXPIRED = E4). NIE woła writera. Audyt+event i tak powstają.
    return {
      attempted: false,
      activated: false,
      persisted: false,
      deduped: false,
      reason: "brak payloadu postingu (tranzycja niefinansowa / derecognition = E4)",
    }
  }

  // Dyskryminator ADR-139 D3 — deterministyczny transaction_id (fail-closed gdy brak
  // wymaganego pola REDEEMED/EXPIRED). Liczony PRZED bramką: kształt id jest stały.
  const discriminator: LedgerLifecycleDiscriminator = {
    entitlement_id: input.entitlement_id,
    lifecycle_event: posting.lifecycle_event,
    redemption_id: posting.redemption_id ?? null,
    remaining_gross_snapshot: posting.remaining_gross_snapshot ?? null,
  }
  const transactionId = deriveLedgerTransactionId(discriminator)

  // ── Bramka aktywacji DWUWARSTWOWA (ADR-139 D5) ────────────────────────────
  const gate = deps.postingActivation ?? defaultPostingActivationGate()
  if (!gate.runtimeEnabled) {
    // Warstwa A off (runtime_enabled=false, stan trwały): hook podpięty, inert.
    return {
      attempted: true,
      activated: false,
      persisted: false,
      deduped: false,
      transaction_id: transactionId,
      reason:
        "runtime_enabled=false (warstwa global) — hook podpięty, persystencja inert (audit-only); flip = P6/E6",
    }
  }
  if (!gate.isMarketActivated(input.scope.market_id)) {
    // Warstwa B off (per-market signoff D-59 niezałatwiony): inert per-market.
    return {
      attempted: true,
      activated: false,
      persisted: false,
      deduped: false,
      transaction_id: transactionId,
      reason: `per-market posting nieaktywowany dla market_id='${input.scope.market_id}' (warstwa per-market, signoff D-59)`,
    }
  }

  // Obie warstwy on. Defense-in-depth: brak writera ⇒ no-op (NIE cichy zapis).
  if (!deps.ledgerWriter) {
    return {
      attempted: true,
      activated: true,
      persisted: false,
      deduped: false,
      transaction_id: transactionId,
      reason: "bramka aktywowana, ale writer niepodpięty (ledgerWriter brak)",
    }
  }

  // ── Generacja postingu (2.3, pure) + persystencja idempotentna (2.6) ──────
  const postingScope: LedgerScope = posting.scope ?? {
    instance_id: input.scope.instance_id,
    market_id: input.scope.market_id,
    vendor_id: input.scope.vendor_id ?? null,
    location_id: input.scope.location_id ?? null,
  }
  const occurredAt = posting.occurred_at ?? input.occurred_at ?? now.toISOString()

  const generated = generateVoucherPosting({
    ...posting,
    scope: postingScope,
    occurred_at: occurredAt,
    transaction_id: transactionId,
  })
  if (!generated.posted) {
    // Udokumentowany no-op generatora (np. SPV REDEEMED, EXPIRED bez salda) —
    // NIE wołamy writera (nic do zapisania). To NIE błąd.
    return {
      attempted: true,
      activated: true,
      persisted: false,
      deduped: false,
      transaction_id: transactionId,
      reason: `generateVoucherPosting no-op: ${generated.reason}`,
    }
  }

  const write = await deps.ledgerWriter.write({
    ...discriminator,
    transaction: generated.transaction,
    ...(posting.expected_currency
      ? { expected_currency: posting.expected_currency }
      : {}),
  })
  return {
    attempted: true,
    activated: true,
    persisted: write.applied,
    deduped: write.deduped,
    transaction_id: write.transaction_id,
    ...(write.deduped
      ? { reason: "replay tranzycji ⇒ no-op posting (writer dedup, ADR-139 D3)" }
      : {}),
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Orkiestrator — JEDNOLITY PUNKT OKABLOWANIA (AC1/AC2)
// ──────────────────────────────────────────────────────────────────────────

/**
 * KONTRAKT ATOMOWOŚCI / POST-COMMIT (AI-Review-3, ADR-139 D2) — egzekwowany
 * przez ROZDZIELENIE API, nie tylko docstring:
 *
 *   `wireEntitlementTransitionPersisted` — praca PERSYSTENTNA (audit + posting)
 *      w obrębie TEJ SAMEJ atomowej jednostki/tx co zmiana stanu callera.
 *      NIE emituje eventu. Zwraca `event` do wyemitowania PO commit.
 *   `emitTransitionEventAfterCommit` — emit best-effort wołany przez callera
 *      DOPIERO PO COMMIT zmiany stanu. Gdy caller wycofa tx, event NIE jest
 *      emitowany ⇒ brak phantom-eventu dla tranzycji, która się nie wydarzyła.
 *
 * Caller (subscriber 3.3 Path Y / workflowy E4) MUSI:
 *   (1) otworzyć tx, zmienić stan, wołać `…Persisted` w TEJ tx (audit atomowy),
 *   (2) COMMIT,
 *   (3) DOPIERO po commit wołać `emitTransitionEventAfterCommit`.
 *
 * UWAGA o postingu (ADR-139 D2): przy `runtime_enabled=false` (stan obecny)
 * posting jest INERT (writer nie wołany) ⇒ ryzyko rozjazdu state↔ledger = 0.
 * PO flipie E6/P6 writer 2.6 prowadzi WŁASNĄ DB-tx; kontrakt callera MUSI wtedy
 * gwarantować, że `…Persisted` jest wołane W tej samej granicy co commit zmiany
 * stanu i że NIE ma rollbacku PO zwrocie z hooka (reconciliation 2.6 łapie braki,
 * nie rozjazdy state↔ledger). Patrz ADR-139 D2 (post-COMMIT + reconciliation).
 */
export async function wireEntitlementTransitionPersisted(
  deps: Pick<
    TransitionWiringDeps,
    "appendAudit" | "ledgerWriter" | "postingActivation" | "clock"
  >,
  input: TransitionInput
): Promise<{
  event: TransitionEventEnvelope
  audit: TransitionAuditEnvelope
  posting: TransitionPostingResult
}> {
  const now = deps.clock?.() ?? new Date()

  // (0) FAIL-CLOSED guard (graf LUB geneza) — NIC poniżej nie wykona się na
  //     niedozwolonej tranzycji / niedozwolonej genezie (AC2).
  assertWiringTransition(input.from, input.to)

  // (1) deterministyczne koperty.
  const { event, audit } = buildTransitionEnvelopes(input, now)

  // (2) AUDIT append-only — w obrębie tx callera (atomowy ze zmianą stanu).
  await deps.appendAudit(audit)

  // (3) POSTING HOOK — bramkowany dwuwarstwowo; audit-only no-op gdy off.
  const posting = await runTransitionPostingHook(deps, input, now)

  return { event, audit, posting }
}

/**
 * Emit eventu tranzycji — best-effort, wołany przez callera DOPIERO PO COMMIT
 * (AI-Review-3). Zwraca `true` gdy 2× emit zawiódł (`emitFailed`); kompletność
 * przy fail = reconciliation-inwariant 2.6 (ADR-139 D2). NIE rzuca.
 */
export async function emitTransitionEventAfterCommit(
  emit: (event: TransitionEventEnvelope) => Promise<void>,
  event: TransitionEventEnvelope
): Promise<boolean> {
  return emitBestEffort(emit, event)
}

/**
 * Okablowuje JEDNĄ dozwoloną tranzycję L4 → event + audit + posting hook
 * (deterministyczna, jednolita ścieżka — AC1). KOMPOZYCJA `…Persisted` + emit.
 *
 * UŻYWAĆ TYLKO gdy caller traktuje całość jako JEDNĄ atomową jednostkę BEZ
 * osobnej granicy commit (np. testy, in-memory). Dla ścieżek z REALNĄ DB-tx
 * (subscriber Path Y 3.3 / workflowy E4) UŻYJ `wireEntitlementTransitionPersisted`
 * w tx + `emitTransitionEventAfterCommit` PO commit — patrz KONTRAKT ATOMOWOŚCI
 * powyżej (AI-Review-3): wewnętrzny emit TUTAJ jest PRZED commitem callera, więc
 * rollback po zwrocie zostawiłby phantom-event.
 *
 * Kolejność: (0) fail-closed guard → (1) koperty → (2) audit → (3) posting hook
 * → (4) emit best-effort. Fail emitu NIE blokuje tranzycji (`emitFailed=true`).
 */
export async function wireEntitlementTransition(
  deps: TransitionWiringDeps,
  input: TransitionInput
): Promise<TransitionWiringResult> {
  const { event, audit, posting } = await wireEntitlementTransitionPersisted(
    deps,
    input
  )

  // (4) EVENT best-effort — w tej kompozycji PRZED ewentualnym commitem callera
  //     (patrz KONTRAKT ATOMOWOŚCI: ścieżki z DB-tx mają wołać emit PO commit).
  const emitFailed = await emitTransitionEventAfterCommit(deps.emitEvent, event)

  return { event, audit, posting, emitFailed }
}

/**
 * Best-effort emit z jednym retry. Zwraca `true` gdy OBA próby zawiodły
 * (`emitFailed`). NIE rzuca — emit jest best-effort i NIE może zablokować
 * tranzycji (ADR-139 D2: kompletność przy 2× fail = reconciliation-inwariant 2.6).
 */
async function emitBestEffort(
  emit: (event: TransitionEventEnvelope) => Promise<void>,
  event: TransitionEventEnvelope
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await emit(event)
      return false
    } catch {
      // swallow — best-effort; po 2× fail zwracamy emitFailed=true.
    }
  }
  return true
}

// ──────────────────────────────────────────────────────────────────────────
// Geneza ISSUED (Path Y live-issue 3.3) — builder wejścia okablowania
// ──────────────────────────────────────────────────────────────────────────

/** Argumenty genezy ISSUED dla okablowania (Path Y live-issue, AI-Review-1). */
export type GenesisIssuedArgs = {
  entitlement_id: string
  scope: TransitionScope
  /** Domyślnie `"system"` (subscriber Path Y). */
  actor?: TransitionActor
  actor_hint?: string
  /** Czas wystąpienia (PSP/issue). Domyślnie `now` w builderze kopert. */
  occurred_at?: string
  /**
   * Dyskryminator wystąpienia (cykl-safe key, AI-Review-2). Dla genezy unikalny
   * per entitlement (np. `entitlement_dedupe_key`) — geneza jest jednorazowa, ale
   * dyskryminator gwarantuje stabilny, nie-kolidujący klucz korelacji.
   */
  transition_seq?: string | number
  /**
   * Payload postingu ISSUED. Gdy obecny ⇒ posting hook policzy `transaction_id`
   * i (przy `runtime_enabled=false`) zwróci audit-only no-op (WYWOŁANY, inert).
   * Gdy brak ⇒ hook `attempted:false` (geneza bez kompletu danych finansowych).
   */
  posting?: TransitionPostingPayload
}

/**
 * Buduje `TransitionInput` dla GENEZY ISSUED (Path Y live-issue → ISSUED, 3.3).
 * `from = ENTITLEMENT_GENESIS`, `to = ISSUED` (jedyna legalna geneza, fail-closed
 * w `assertWiringTransition`). To JEDYNY punkt, przez który ścieżka live wystawia
 * ISSUED do okablowania (event + audit + posting hook) — AC1 zrealizowane w runtime.
 */
export function buildGenesisIssuedTransition(
  args: GenesisIssuedArgs
): TransitionInput {
  return {
    from: ENTITLEMENT_GENESIS,
    to: EntitlementInstanceState.ISSUED,
    entitlement_id: args.entitlement_id,
    scope: args.scope,
    actor: args.actor ?? "system",
    ...(args.actor_hint ? { actor_hint: args.actor_hint } : {}),
    ...(args.occurred_at ? { occurred_at: args.occurred_at } : {}),
    ...(args.transition_seq != null ? { transition_seq: args.transition_seq } : {}),
    ...(args.posting ? { posting: args.posting } : {}),
  }
}

// ──────────────────────────────────────────────────────────────────────────
// KONTRAKT EGZEKWOWANIA `runtime_enabled` (AI-Review-4) — gdzie żyje bramka
// ──────────────────────────────────────────────────────────────────────────
//
// Bramka aktywacji postingu (`runtime_enabled` + per-market) jest egzekwowana w
// WARSTWIE CALLER (`runTransitionPostingHook`), zgodnie z ADR-139 D5 (governed
// activation = warstwa caller/E3). Writer 2.6 (`ledger-writer.ts`) NIE czyta
// `runtime_enabled` — jego kontraktem jest WYŁĄCZNIE idempotentny, balansujący
// zapis (separacja odpowiedzialności: writer = "jak zapisać", caller = "czy wolno").
//
// Aby jednowarstwowe egzekwowanie NIE było kruche (ryzyko: przyszły caller woła
// `writer.write` z pominięciem hooka), dispersja jest EGZEKWOWANA STATYCZNIE przez
// checker `entitlement-transition-routing.ts` (test AC1/AI-Review-4): jedynym
// nie-testowym call-site `…ledgerWriter.write(` / `new VoucherLedgerWriter` w
// produkcji jest TEN moduł okablowania. Nowy posting call-site ⇒ czerwony checker
// (świadoma zmiana allow-listy = gate review), NIE ciche obejście bramki. To
// kontraktowa „druga bariera" bez duplikowania gatingu w writerze (defense bez
// rozjazdu odpowiedzialności). Patrz `assertLedgerWriterRoutedThroughWiring`.
