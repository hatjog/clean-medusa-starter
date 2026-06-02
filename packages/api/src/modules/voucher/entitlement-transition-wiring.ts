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

/** Aktor envelope.v1 (`actor` enum — zgodnie z envelope.v1.schema.json). */
export type TransitionActor = "system" | "customer" | "vendor" | "admin"

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
  actor: TransitionActor
  scope: TransitionScope
  idempotency_key: string
  payload: {
    entitlement_id: string
    from_state: EntitlementInstanceState
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
  from_state: EntitlementInstanceState
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
  from: EntitlementInstanceState
  to: EntitlementInstanceState
  entitlement_id: string
  scope: TransitionScope
  actor: TransitionActor
  actor_hint?: string
  /** Domyślnie `now`. */
  occurred_at?: string
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
 * Deterministyczny idempotency_key tranzycji (stabilny przy replay). Pozwala
 * sinkowi audytu/eventu deduplikować ten sam ślad. Posting idempotentny osobno
 * przez deterministyczny `transaction_id` writera (ADR-139 D3).
 */
function buildTransitionIdempotencyKey(
  entitlementId: string,
  from: EntitlementInstanceState,
  to: EntitlementInstanceState
): string {
  return `entitlement:${entitlementId}:transition:${from}->${to}`
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
  const idempotencyKey = buildTransitionIdempotencyKey(
    input.entitlement_id,
    input.from,
    input.to
  )
  const scope: TransitionScope = {
    instance_id: input.scope.instance_id,
    market_id: input.scope.market_id,
    sales_channel_id: input.scope.sales_channel_id ?? null,
    vendor_id: input.scope.vendor_id ?? null,
    location_id: input.scope.location_id ?? null,
  }

  const event: TransitionEventEnvelope = {
    schema_version: "1",
    event_type: ENTITLEMENT_STATE_CHANGED_EVENT_TYPE,
    occurred_at: occurredAt,
    actor: input.actor,
    scope,
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
    scope,
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
 * Okablowuje JEDNĄ dozwoloną tranzycję L4 → event + audit + posting hook
 * (deterministyczna, jednolita ścieżka — AC1). Kolejność:
 *
 *   0. `assertTransition(from, to)` — FAIL-CLOSED. Niedozwolona tranzycja rzuca
 *      `EntitlementTransitionError` ZANIM powstanie KTÓRYKOLWIEK efekt uboczny
 *      (brak audytu / eventu / postingu na odrzuconej ścieżce — AC2).
 *   1. build kopert (event + audit) — czyste, deterministyczne.
 *   2. AUDIT — append-only, w obrębie tx callera (atomowy ze zmianą stanu).
 *   3. POSTING HOOK — bramkowany dwuwarstwowo; inert gdy runtime_enabled=false.
 *   4. EVENT — best-effort post-COMMIT (1 retry). Fail NIE blokuje tranzycji
 *      (`emitFailed=true`; kompletność = reconciliation-inwariant 2.6, ADR-139 D2).
 *
 * UWAGA tx: audit + posting są pracą w obrębie tx/atomowej jednostki callera
 * (writer 2.6 sam zarządza swoją DB-tx). Emit eventu jest POST-COMMIT — wołać
 * po zatwierdzeniu zmiany stanu (best-effort). Caller (subscriber 3.3 / workflowy
 * E4) decyduje o granicy tx; wiring egzekwuje KOLEJNOŚĆ + BRAMKĘ + KSZTAŁT.
 */
export async function wireEntitlementTransition(
  deps: TransitionWiringDeps,
  input: TransitionInput
): Promise<TransitionWiringResult> {
  const now = deps.clock?.() ?? new Date()

  // (0) FAIL-CLOSED guard — NIC poniżej nie wykona się na niedozwolonej tranzycji.
  assertTransition(input.from, input.to)

  // (1) deterministyczne koperty.
  const { event, audit } = buildTransitionEnvelopes(input, now)

  // (2) AUDIT append-only (niezależny od postingu; działa przy runtime_enabled=false).
  await deps.appendAudit(audit)

  // (3) POSTING HOOK (bramkowany dwuwarstwowo; audit-only no-op gdy off).
  const posting = await runTransitionPostingHook(deps, input, now)

  // (4) EVENT best-effort post-COMMIT (1 retry). Fail NIE blokuje tranzycji.
  const emitFailed = await emitBestEffort(deps.emitEvent, event)

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
