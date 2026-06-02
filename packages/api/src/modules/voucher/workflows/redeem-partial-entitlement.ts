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

// ──────────────────────────────────────────────────────────────────────────
// Stany redeemowalne (źródło tranzycji) — voucher kwotowy z saldem
// ──────────────────────────────────────────────────────────────────────────

/**
 * Stany, z których redeem może wystartować: `ACTIVE` (pierwszy redeem) oraz
 * `REDEEMED_PARTIAL` (kolejna rata multi-installment — saldo wciąż dostępne).
 * Graf (3.4) prowadzi OBA przez `REDEMPTION_REQUESTED` → `REDEEMED_PARTIAL`/
 * `REDEEMED_FULL` (krawędzie istnieją; NIE zmieniamy taksonomii, D-5).
 */
const REDEEMABLE_SOURCE_STATES: ReadonlySet<EntitlementInstanceState> = new Set([
  EntitlementInstanceState.ACTIVE,
  EntitlementInstanceState.REDEEMED_PARTIAL,
])

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
 * Deterministyczny `redemption_id` z pary (`entitlement_id`, `idempotency_key`).
 * Stabilny przy replay (ta sama para ⇒ ten sam id) i UNIKALNY per rata
 * (różny `idempotency_key` ⇒ różny `redemption_id` ⇒ N postingów dla N rat
 * multi-installment). Jest dyskryminatorem deterministycznego `transaction_id`
 * writera (ADR-139 D3, multi-installment-safe) — druga bariera idempotencji.
 */
export function buildRedemptionId(
  entitlementId: string,
  idempotencyKey: string
): string {
  const digest = createHash("sha256")
    .update(`${entitlementId}‖${idempotencyKey}`)
    .digest("hex")
    .toUpperCase()
  return `RDM-${digest.slice(0, 12)}`
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

// ──────────────────────────────────────────────────────────────────────────
// Kontrakty wejścia / wyjścia
// ──────────────────────────────────────────────────────────────────────────

export type RedeemPartialInput = {
  entitlement_id: string
  /** Zrealizowane brutto w tym evencie (minor units). 1 ≤ amount ≤ remaining. */
  amount_minor: number
  /** Klucz idempotencji operacji domeny (z `entitlement_id` = klucz dedupe AC2). */
  idempotency_key: string
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
   */
  voucher_net_minor: number
  /** VAT CAŁEGO vouchera przy emisji, minor units (payload generatora 2.3). */
  voucher_vat_minor: number
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

export type RedeemPartialResult = {
  entitlement_id: string
  redemption_id: string
  outcome: RedeemOutcome
  new_state: RedeemOutcome
  amount_minor: number
  remaining_before_minor: number
  remaining_after_minor: number
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
  resulting_state: RedeemOutcome
  remaining_after_minor: number
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

// ──────────────────────────────────────────────────────────────────────────
// Store / tx — granica persystencji (wzorzec InMemory*/Postgres* z workflows/)
// ──────────────────────────────────────────────────────────────────────────

export interface RedeemPartialTx {
  getEntitlementForUpdate(
    id: string
  ): Promise<RedeemableAmountEntitlement | null>
  /** Warstwa domeny idempotencji: zwraca istniejący record (replay) lub null. */
  findRedemption(
    entitlementId: string,
    idempotencyKey: string
  ): Promise<RedemptionRecord | null>
  /**
   * Zwraca DOWOLNY istniejący record dla danego entitlementu (pierwsza rata
   * multi-installment). Używany do walidacji spójności net/vat (L3, VER-H1).
   * Wywołanie TYLKO gdy `findRedemption` zwróciło null (poza ścieżką replay).
   */
  findAnyRedemptionByEntitlementId(
    entitlementId: string
  ): Promise<RedemptionRecord | null>
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
  /** Append-only audit (w obrębie tej tx — atomowy ze zmianą stanu). */
  appendAudit(audit: TransitionAuditEnvelope): Promise<void>
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
  clock?: () => Date
}

// ──────────────────────────────────────────────────────────────────────────
// Operacja redeem (partial + full) idempotentna
// ──────────────────────────────────────────────────────────────────────────

export class RedeemPartialEntitlementOperation {
  constructor(private readonly deps: RedeemPartialDeps) {}

  async redeem(input: RedeemPartialInput): Promise<RedeemPartialResult> {
    const now = input.now ?? this.deps.clock?.() ?? new Date()
    const currency = input.currency ?? "PLN"
    const idempotencyKey = input.idempotency_key
    if (!idempotencyKey) {
      throw new RedeemAmountError(
        "redeem: idempotency_key wymagany (klucz idempotencji domeny, AC2)",
        input.amount_minor,
        0
      )
    }
    const redemptionId = buildRedemptionId(input.entitlement_id, idempotencyKey)

    const txOut = await this.deps.store.withTransaction(async (tx) => {
      const ent = await tx.getEntitlementForUpdate(input.entitlement_id)
      if (!ent) throw new RedeemEntitlementNotFoundError(input.entitlement_id)

      // ── Warstwa DOMENY idempotencji (AC2, wiążąca / fail-closed) ───────────
      // Replay tej samej pary (idempotency_key+entitlement_id) ⇒ NIE obniża
      // salda ponownie; zwraca skutek pierwszego redeemu deterministycznie.
      const prior = await tx.findRedemption(input.entitlement_id, idempotencyKey)
      if (prior) {
        // L6: wykryj dryf parametrów — reużyty idempotency_key z innym amount_minor
        // to sygnał błędu po stronie callera (fail-loud, NIE cichy pierwszy-skutek).
        if (prior.amount_minor !== input.amount_minor) {
          throw new RedeemAmountError(
            `redeem: param drift — idempotency_key=${idempotencyKey} już użyty z ` +
              `amount_minor=${prior.amount_minor}, teraz podano ${input.amount_minor} ` +
              `(dryf parametrów; fail-closed, AC2)`,
            input.amount_minor,
            prior.remaining_after_minor + prior.amount_minor
          )
        }
        return { kind: "replay" as const, record: prior }
      }

      // ── Inwarianty redeemowalności (fail-closed) ──────────────────────────
      // Scope: voucher KWOTOWY (VOUCHER_AMOUNT) z saldem `remaining`.
      if (ent.entitlement_type !== EntitlementType.VOUCHER_AMOUNT) {
        throw new RedeemNotRedeemableError(
          `redeem: entitlement ${ent.id} nie jest VOUCHER_AMOUNT ` +
            `(typ=${ent.entitlement_type}); redeem kwotowy poza zakresem`
        )
      }
      if (!REDEEMABLE_SOURCE_STATES.has(ent.state)) {
        throw new RedeemNotRedeemableError(
          `redeem: entitlement ${ent.id} w stanie ${ent.state} nie jest ` +
            `redeemowalny (dozwolone: ACTIVE / REDEEMED_PARTIAL)`
        )
      }
      const remainingBefore = ent.remaining_amount
      if (remainingBefore == null || remainingBefore <= 0) {
        throw new RedeemNotRedeemableError(
          `redeem: entitlement ${ent.id} ma remaining=${remainingBefore} ` +
            `(brak salda do realizacji)`
        )
      }

      // ── Inwariant zakresu kwoty (AC1) — NIGDY > remaining, NIE ujemne ──────
      const amount = input.amount_minor
      if (!Number.isInteger(amount) || amount < 1) {
        throw new RedeemAmountError(
          `redeem: amount_minor musi być dodatnią liczbą całkowitą (otrzymano ${amount})`,
          amount,
          remainingBefore
        )
      }
      if (amount > remainingBefore) {
        throw new RedeemAmountError(
          `redeem: amount_minor (${amount}) > remaining (${remainingBefore}) — ` +
            `over-redeem odrzucony fail-closed (brak częściowego skutku, NIE reissue)`,
          amount,
          remainingBefore
        )
      }

      // ── Transferability (regulamin § 12 — snapshot, NIE live profile) ──────
      const redeemCtx: RedeemContext = {
        customer_id: input.redeeming_customer_id ?? null,
        recipient_customer_id: ent.recipient_customer_id ?? null,
      }
      assertTransferabilityAllowed(ent.policy_snapshot, redeemCtx)

      // ── Dyskryminacja wyniku: full (remaining→0) vs partial (saldo > 0) ────
      const remainingAfter = remainingBefore - amount
      const outcome: RedeemOutcome =
        remainingAfter === 0
          ? EntitlementInstanceState.REDEEMED_FULL
          : EntitlementInstanceState.REDEEMED_PARTIAL

      // Redeemed-to-date PRZED tym eventem (VER-H1, kumulatywny VAT). Saldo brutto
      // śledzi zrealizowane brutto: prior = totalGross − remainingBefore.
      const totalGross = input.voucher_net_minor + input.voucher_vat_minor

      // L3: walidacja spójności net/vat między ratami multi-installment (VER-H1).
      // Sprawdź czy issued_gross_minor z poprzedniej raty zgadza się z totalGross.
      // Niespójność (caller zmienił net/vat między ratami) ⇒ fail-closed.
      const anyPriorRedemption = await tx.findAnyRedemptionByEntitlementId(
        input.entitlement_id
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

      const priorRedeemedGross = totalGross - remainingBefore
      if (priorRedeemedGross < 0) {
        throw new RedeemAmountError(
          `redeem: niespójne wejście — remaining (${remainingBefore}) > brutto ` +
            `vouchera (${totalGross}); payload net/vat nie zgadza się z saldem`,
          amount,
          remainingBefore
        )
      }

      // L4: scope postingu dziedziczy vendor_id/location_id z entitlement_instance
      // (nie tylko z inputu callera). Zapis entitlementu jest źródłem prawdy.
      const scope: TransitionScope = {
        instance_id: ent.id,
        market_id: (input.market_id ?? ent.market_id) ?? "unknown",
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
      const record: RedemptionRecord = {
        entitlement_id: ent.id,
        idempotency_key: idempotencyKey,
        redemption_id: redemptionId,
        amount_minor: amount,
        resulting_state: outcome,
        remaining_after_minor: remainingAfter,
        issued_gross_minor: totalGross,
        created_at: now.getTime(),
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
      await tx.updateEntitlementRemainingAndState(
        ent.id,
        EntitlementInstanceState.REDEMPTION_REQUESTED,
        outcome,
        remainingAfter,
        now
      )

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
          lifecycle_event: "REDEEMED",
          vat_classification: vatClassification,
          net_minor: input.voucher_net_minor,
          vat_minor: input.voucher_vat_minor,
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
      withdrawal_right_extinguished: isWithdrawalRightExtinguished(
        rec.resulting_state
      ),
      posting: txOut.posting,
      idempotent: false,
      emit_failed: emitFailed,
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Postgres store (production wiring)
// ──────────────────────────────────────────────────────────────────────────

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
  }
}

type QueryResult<T> = Promise<{ rows: T[]; rowCount?: number | null }>
type PgClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>
  ) => QueryResult<T>
  release: () => void
}
type PgPool = { connect: () => Promise<PgClient> }

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
  constructor(private readonly client: PgClient) {}

  async getEntitlementForUpdate(
    id: string
  ): Promise<RedeemableAmountEntitlement | null> {
    // L4: SELECT zawiera vendor_id/location_id (dziedziczone do scope postingu).
    const res = await this.client.query<Record<string, unknown>>(
      `SELECT id, entitlement_type, state, remaining_amount, policy_snapshot,
              vat_classification, market_id, sales_channel_id,
              vendor_id, location_id, recipient_customer_id
         FROM entitlement_instance
        WHERE id = $1
        FOR UPDATE`,
      [id]
    )
    const row = res.rows[0]
    if (!row) return null
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
      recipient_customer_id: (row.recipient_customer_id ?? null) as
        | string
        | null,
    }
  }

  async findRedemption(
    entitlementId: string,
    idempotencyKey: string
  ): Promise<RedemptionRecord | null> {
    const res = await this.client.query<Record<string, unknown>>(
      `SELECT entitlement_id, idempotency_key, redemption_id, amount_minor,
              resulting_state, remaining_after_minor, issued_gross_minor, created_at
         FROM ${VOUCHER_REDEMPTION_TABLE}
        WHERE entitlement_id = $1 AND idempotency_key = $2`,
      [entitlementId, idempotencyKey]
    )
    const row = res.rows[0]
    if (!row) return null
    return mapRedemptionRow(row)
  }

  async findAnyRedemptionByEntitlementId(
    entitlementId: string
  ): Promise<RedemptionRecord | null> {
    const res = await this.client.query<Record<string, unknown>>(
      `SELECT entitlement_id, idempotency_key, redemption_id, amount_minor,
              resulting_state, remaining_after_minor, issued_gross_minor, created_at
         FROM ${VOUCHER_REDEMPTION_TABLE}
        WHERE entitlement_id = $1
        LIMIT 1`,
      [entitlementId]
    )
    const row = res.rows[0]
    if (!row) return null
    return mapRedemptionRow(row)
  }

  async insertRedemption(
    record: RedemptionRecord
  ): Promise<{ inserted: boolean }> {
    const res = await this.client.query(
      `INSERT INTO ${VOUCHER_REDEMPTION_TABLE}
         (entitlement_id, idempotency_key, redemption_id, amount_minor,
          resulting_state, remaining_after_minor, issued_gross_minor, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (entitlement_id, idempotency_key) DO NOTHING`,
      [
        record.entitlement_id,
        record.idempotency_key,
        record.redemption_id,
        record.amount_minor,
        record.resulting_state,
        record.remaining_after_minor,
        record.issued_gross_minor,
        record.created_at,
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
}

// ──────────────────────────────────────────────────────────────────────────
// In-memory store (testing) — mirror semantyki PG (ON CONFLICT DO NOTHING)
// ──────────────────────────────────────────────────────────────────────────

function inMemoryRedemptionKey(
  entitlementId: string,
  idempotencyKey: string
): string {
  return JSON.stringify([entitlementId, idempotencyKey])
}

export class InMemoryRedeemPartialStore implements RedeemPartialStore {
  private rows: Map<string, RedeemableAmountEntitlement>
  private redemptions: Map<string, RedemptionRecord>
  private audits: TransitionAuditEnvelope[]

  constructor(rows: RedeemableAmountEntitlement[] = []) {
    this.rows = new Map(rows.map((r) => [r.id, { ...r }]))
    this.redemptions = new Map()
    this.audits = []
  }

  get(id: string): RedeemableAmountEntitlement | undefined {
    return this.rows.get(id)
  }

  listRedemptions(): RedemptionRecord[] {
    return [...this.redemptions.values()]
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
    const auditsLen = this.audits.length
    try {
      return await fn(
        new InMemoryRedeemPartialTx(this.rows, this.redemptions, this.audits)
      )
    } catch (err) {
      // Rollback: przywróć migawki + odetnij audyty tej tx (fail-closed — ZERO
      // efektów ubocznych na odrzuconej ścieżce, AC2).
      this.rows = rowsSnapshot
      this.redemptions = redemptionsSnapshot
      this.audits.length = auditsLen
      throw err
    }
  }
}

class InMemoryRedeemPartialTx implements RedeemPartialTx {
  constructor(
    private readonly rows: Map<string, RedeemableAmountEntitlement>,
    private readonly redemptions: Map<string, RedemptionRecord>,
    private readonly audits: TransitionAuditEnvelope[]
  ) {}

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

  async findRedemption(
    entitlementId: string,
    idempotencyKey: string
  ): Promise<RedemptionRecord | null> {
    const r = this.redemptions.get(
      inMemoryRedemptionKey(entitlementId, idempotencyKey)
    )
    return r ? { ...r } : null
  }

  async findAnyRedemptionByEntitlementId(
    entitlementId: string
  ): Promise<RedemptionRecord | null> {
    for (const record of this.redemptions.values()) {
      if (record.entitlement_id === entitlementId) return { ...record }
    }
    return null
  }

  async insertRedemption(
    record: RedemptionRecord
  ): Promise<{ inserted: boolean }> {
    const key = inMemoryRedemptionKey(
      record.entitlement_id,
      record.idempotency_key
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
