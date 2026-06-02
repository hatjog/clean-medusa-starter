/**
 * expire-entitlement.ts — Story 4.2 (v1.11.0 Epic 4 / Wave 4 — lifecycle).
 *
 * Operacja DEFENSYWNEGO EXPIRY → BREAKAGE (derecognition niewykorzystanego
 * zobowiązania) na voucherze KWOTOWYM, otwarta po redeem/partial (4.1). Realizuje
 * filar AC2 Story 4.2 oraz idempotentny expiry sweep + pre-expiry powiadomienie:
 *
 *   AC2 — tranzycja `<source> → EXPIRED` (z `remaining > 0`) routuje derecognition
 *         przez `wireEntitlementTransitionPersisted` (3.4) → posting hook →
 *         `generateVoucherPosting()` BREAKAGE (2.3) → `ledger-writer` (2.6). Posting
 *         hook RESPEKTUJE `runtime_enabled` guard (`false` ⇒ audit-only/no-op, NIE
 *         pisze `voucher_ledger_*`). SPV = VAT już rozpoznany przy emisji; **MPV
 *         unused = bez VAT (art. 73a)**. Status klienta = „Ważność minęła — sprawdź
 *         opcje zwrotu" (UX §8). Idempotentna (replay ⇒ no-op) + audytowalna.
 *
 *   SWEEP — idempotentny: re-run NIE podwaja breakage postingu. Dwie bariery:
 *         (a) DOMENA — guard stanu źródłowego (`EXPIRED` ⇒ no-op; tranzycja
 *             jednokierunkowa, terminalny stan jest markerem dedupe);
 *         (b) LEDGER — deterministyczny `transaction_id` writera (EXPIRED
 *             dyskryminator = `entitlement_id ‖ remaining_gross_snapshot`, ADR-139 D3;
 *             replay ⇒ ON CONFLICT no-op).
 *
 *   PRE-EXPIRY — powiadomienie (extend ‖ bezpłatny zwrot salda, anti-forfeiture
 *         copy z `entitlement-expiry.ts`) wysyłane RAZ per okno (dedup po
 *         `idempotency_key = entitlement:<id>:pre_expiry:<expires_at>`). Re-run
 *         sweepu NIE duplikuje powiadomienia.
 *
 * GRANICA (D-5 / ADR-139 D5) — HOOK ≠ AKTYWACJA POSTINGU:
 *   Posting breakage jest PODPIĘTY i WOŁANY przez okablowanie 3.4, ale
 *   `runtime_enabled` zostaje `false` ⇒ posting hook jest audit-only / no-op (NIE
 *   pisze `voucher_ledger_*`). Tranzycja, audit, status klienta i powiadomienia
 *   działają NIEZALEŻNIE od flagi. Operacja NIE flipuje `runtime_enabled`, NIE
 *   deklaruje finance sign-off, NIE zmienia statusu ADR. Aktywacja = osobny P6
 *   finance gate (E6/P6 + per-market signoff D-59).
 *
 * GRANICE ZAKRESU (E4): operacja KONSUMUJE istniejące okablowanie (3.4), writer
 * (2.6) i generator (2.3). NIE reimplementuje posting/VAT logiki (MPV art. 73a /
 * SPV liczy generator 2.3). NIE zmienia taksonomii stanów (krawędzie `*→EXPIRED`
 * istnieją w `ALLOWED_ENTITLEMENT_TRANSITIONS`; operacja dodaje WYŁĄCZNIE nowego
 * callera okablowania). NIE mutuje `remaining` (saldo zachowane dla recovery
 * refund 4.3 / extend 4.4 — defensywny expiry). NIE rusza hard-gate'ów MPV/SUBSCRIPTION.
 *
 * Podstawa normatywna (NFR4 — referencja, NIE autorstwo): ADR-136 (defensywny
 * expiry / art. 385¹ KC), ADR-133 (separacja entitlement↔money, breakage konta),
 * ADR-139 (D3 posting hook = wołanie writera, D5 governed activation dwuwarstwowa).
 */

import { Modules } from "@medusajs/framework/utils"

import {
  EntitlementInstanceState,
  EntitlementType,
  ALLOWED_ENTITLEMENT_TRANSITIONS,
  snapshotPolicy,
  type EntitlementPolicySnapshot,
} from "../models/entitlement"
import type { VatClassification } from "../vat-resolver"
import {
  wireEntitlementTransitionPersisted,
  emitTransitionEventAfterCommit,
  defaultPostingActivationGate,
  type TransitionScope,
  type TransitionActor,
  type TransitionAuditEnvelope,
  type TransitionEventEnvelope,
  type TransitionPostingResult,
  type TransitionLedgerWriter,
  type PostingActivationGate,
} from "../entitlement-transition-wiring"
import { deriveLedgerTransactionId } from "../ledger-writer"
import {
  EXPIRED_CUSTOMER_STATUS,
  buildPreExpiryNotification,
  type PreExpiryNotification,
} from "../entitlement-expiry"

// ──────────────────────────────────────────────────────────────────────────
// Stany źródłowe legalne dla tranzycji → EXPIRED (z grafu, NIE hardcode)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Stany, z których `→ EXPIRED` jest legalną krawędzią `ALLOWED_ENTITLEMENT_
 * TRANSITIONS` (D-5: ISSUED, ACTIVE). Derywowane z grafu (NIE hardcode), więc
 * operacja NIGDY nie zapisze nielegalnej tranzycji i pozostaje spójna ze
 * spójnym SSOT taksonomii — dryf grafu automatycznie zwęża/rozszerza zbiór.
 * (Stany z saldem po częściowym redeem — `REDEEMED_PARTIAL` — NIE mają krawędzi
 * `→EXPIRED` w grafie L4; ich wygaśnięcie biegnie innymi ścieżkami lifecycle.)
 */
export const EXPIRY_SOURCE_STATES: ReadonlySet<EntitlementInstanceState> =
  new Set(
    (
      Object.keys(ALLOWED_ENTITLEMENT_TRANSITIONS) as EntitlementInstanceState[]
    ).filter((from) =>
      ALLOWED_ENTITLEMENT_TRANSITIONS[from].includes(
        EntitlementInstanceState.EXPIRED
      )
    )
  )

// ──────────────────────────────────────────────────────────────────────────
// Błędy fail-closed
// ──────────────────────────────────────────────────────────────────────────

export class ExpireEntitlementNotFoundError extends Error {
  constructor(id: string) {
    super(`entitlement_instance ${id} was not found`)
    this.name = "ExpireEntitlementNotFoundError"
  }
}

/** Rzucany gdy entitlement nie jest w stanie/typie zdolnym do EXPIRED (fail-closed). */
export class EntitlementNotExpirableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EntitlementNotExpirableError"
  }
}

/** Rzucany gdy wejście breakage jest niespójne (remaining > brutto vouchera). */
export class ExpireAmountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExpireAmountError"
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Kontrakty wejścia / wyjścia
// ──────────────────────────────────────────────────────────────────────────

export type ExpireEntitlementInput = {
  entitlement_id: string
  /**
   * Netto (ex-VAT) CAŁEGO vouchera przy emisji, minor units (payload generatora 2.3).
   * Opcjonalne gdy sweep nie dysponuje kwotami emisji (routing audit-only/no-op ok
   * przy runtime_enabled=false). WYMAGANE gdy posting aktywowany (fail-closed, AI-Review-1).
   * Cross-walidowane z `voucher_redemption.issued_gross_minor` gdy dostępne (AI-Review-5).
   */
  voucher_net_minor?: number
  /**
   * VAT CAŁEGO vouchera przy emisji, minor units (payload generatora 2.3). Opcjonalne
   * — patrz `voucher_net_minor`. WYMAGANE gdy posting aktywowany (AI-Review-1).
   */
  voucher_vat_minor?: number
  /**
   * Klasyfikacja VAT (SPV/MPV). KONSUMOWANA ze snapshotu entitlementu / resolvera
   * 2.2, NIE reklasyfikowana tutaj. MPV unused ⇒ bez VAT (art. 73a); SPV ⇒ VAT
   * rozpoznany przy emisji. Jawny override ma priorytet, inaczej z kolumny.
   * Brak/null ⇒ fail-closed (EntitlementNotExpirableError, AI-Review-3).
   */
  vat_classification?: VatClassification
  /** Waluta payloadu postingu + currency guard writera. Domyślnie PLN. */
  currency?: string
  /**
   * Ontologia scope (FK 3.2). Brak market_id ⇒ fail-loud (EntitlementNotExpirableError,
   * NFR3 izolacja per-market, AI-Review-4).
   */
  market_id?: string | null
  sales_channel_id?: string | null
  vendor_id?: string | null
  location_id?: string | null
  /** Aktor tranzycji (envelope.v1). Domyślnie `system` (sweep). */
  actor?: TransitionActor
  actor_hint?: string
  /**
   * Gdy `true` (domyślnie): wymaga `expires_at <= now` (defensywny expiry —
   * wygaszamy WYŁĄCZNIE przeterminowane). Sweep przekazuje wiersze już przefiltrowane.
   * `false` ⇒ pomija guard należności (np. administracyjne wygaszenie).
   */
  require_due?: boolean
  now?: Date
}

export type ExpireEntitlementResult = {
  entitlement_id: string
  new_state: EntitlementInstanceState.EXPIRED
  /** Pozostałe (niewykorzystane) saldo na moment wygaśnięcia, minor units. */
  remaining_minor: number
  /** true ⇒ `remaining > 0` ⇒ breakage (derecognition niewykorzystanego salda). */
  breakage: boolean
  /** Status klienta (UX §8) — recovery-as-care, NIGDY „przepadło". */
  customer_status: typeof EXPIRED_CUSTOMER_STATUS
  /** Wynik posting hooka (breakage). Bramkowany: audit-only/no-op gdy off. */
  posting: TransitionPostingResult
  /** true ⇒ replay (stan był już EXPIRED) — ZERO ponownego postingu/eventu. */
  idempotent: boolean
  /** true ⇒ 2× emit eventu zawiódł (best-effort; reconciliation 2.6). */
  emit_failed: boolean
}

/** Wiersz entitlementu potrzebny operacji EXPIRED (podzbiór `entitlement_instance`). */
export type ExpirableEntitlement = {
  id: string
  entitlement_type: EntitlementType
  state: EntitlementInstanceState
  remaining_amount: number | null
  policy_snapshot: EntitlementPolicySnapshot
  vat_classification: VatClassification | null
  issued_amount_currency?: string | null
  expires_at: Date | null
  market_id: string | null
  sales_channel_id: string | null
  vendor_id?: string | null
  location_id?: string | null
}

// ──────────────────────────────────────────────────────────────────────────
// Store / tx — granica persystencji (wzorzec redeem-partial 4.1)
// ──────────────────────────────────────────────────────────────────────────

export interface ExpireEntitlementTx {
  getEntitlementForUpdate(id: string): Promise<ExpirableEntitlement | null>
  /** Zmiana stanu (bez salda) `<source> → EXPIRED`. Saldo NIE jest mutowane. */
  updateEntitlementState(
    id: string,
    fromState: EntitlementInstanceState,
    toState: EntitlementInstanceState,
    now: Date
  ): Promise<void>
  /** Append-only audit (w obrębie tej tx — atomowy ze zmianą stanu). */
  appendAudit(audit: TransitionAuditEnvelope): Promise<void>
  /**
   * Cross-walidacja: pobiera `issued_gross_minor` z `voucher_redemption` (AI-Review-5).
   * Zwraca null gdy brak rekordów (nowy voucher bez redempcji → pomiń cross-check).
   */
  findIssuedGross(entitlementId: string): Promise<number | null>
}

export interface ExpireEntitlementStore {
  withTransaction<T>(fn: (tx: ExpireEntitlementTx) => Promise<T>): Promise<T>
}

export type ExpireEntitlementEventEmitter = {
  emit: (event: TransitionEventEnvelope) => Promise<void>
}

export type ExpireEntitlementDeps = {
  store: ExpireEntitlementStore
  events: ExpireEntitlementEventEmitter
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
// Operacja EXPIRED → BREAKAGE (idempotentna, gated)
// ──────────────────────────────────────────────────────────────────────────

export class ExpireEntitlementOperation {
  constructor(private readonly deps: ExpireEntitlementDeps) {}

  async expire(
    input: ExpireEntitlementInput
  ): Promise<ExpireEntitlementResult> {
    const now = input.now ?? this.deps.clock?.() ?? new Date()
    const currency = input.currency ?? "PLN"
    const requireDue = input.require_due !== false

    const txOut = await this.deps.store.withTransaction(async (tx) => {
      const ent = await tx.getEntitlementForUpdate(input.entitlement_id)
      if (!ent) throw new ExpireEntitlementNotFoundError(input.entitlement_id)

      // ── Bariera DOMENY idempotencji (sweep re-run) ─────────────────────────
      // EXPIRED jest stanem markerem: replay sweepu widzi EXPIRED ⇒ no-op
      // (ZERO ponownej tranzycji/postingu/eventu). Tranzycja jest jednokierunkowa.
      if (ent.state === EntitlementInstanceState.EXPIRED) {
        return { kind: "replay" as const, ent }
      }

      // Scope: voucher KWOTOWY z saldem `remaining` (breakage liczone od salda).
      if (ent.entitlement_type !== EntitlementType.VOUCHER_AMOUNT) {
        throw new EntitlementNotExpirableError(
          `expire: entitlement ${ent.id} nie jest VOUCHER_AMOUNT ` +
            `(typ=${ent.entitlement_type}); breakage kwotowy poza zakresem`
        )
      }
      // Tylko legalne krawędzie grafu `<source> → EXPIRED` (D-5, fail-closed).
      if (!EXPIRY_SOURCE_STATES.has(ent.state)) {
        throw new EntitlementNotExpirableError(
          `expire: entitlement ${ent.id} w stanie ${ent.state} nie ma legalnej ` +
            `krawędzi → EXPIRED (dozwolone źródła: ${[...EXPIRY_SOURCE_STATES].join(", ")})`
        )
      }
      // Defensywny expiry: wygaszamy WYŁĄCZNIE przeterminowane (deterministyczny termin).
      if (requireDue) {
        if (ent.expires_at == null) {
          throw new EntitlementNotExpirableError(
            `expire: entitlement ${ent.id} nie ma expires_at — brak deterministycznego ` +
              `terminu, nie można wygasić (require_due)`
          )
        }
        if (ent.expires_at.getTime() > now.getTime()) {
          throw new EntitlementNotExpirableError(
            `expire: entitlement ${ent.id} jeszcze nie wygasł ` +
              `(expires_at=${ent.expires_at.toISOString()} > now=${now.toISOString()})`
          )
        }
      }

      // ── AI-Review-4: fail-loud na brakującym market_id (NFR3 per-market izolacja) ─
      const resolvedMarketId = input.market_id ?? ent.market_id
      if (resolvedMarketId == null || resolvedMarketId === "") {
        throw new EntitlementNotExpirableError(
          `expire: entitlement ${ent.id} — brak market_id; wymagane jawne market_id ` +
            `dla izolacji per-market (NFR3, fail-loud, AI-Review-4). ` +
            `Uzupełnij market_id w wierszu entitlementu lub przekaż przez caller.`
        )
      }

      // ── AI-Review-3: fail-closed na braku klasyfikacji VAT (finansowo materialne) ─
      const vatClassification = input.vat_classification ?? ent.vat_classification
      if (vatClassification == null) {
        throw new EntitlementNotExpirableError(
          `expire: entitlement ${ent.id} — brak klasyfikacji VAT (vat_classification ` +
            `null/undefined); wymagana jawna SPV/MPV ze snapshotu emisji (resolver 2.2); ` +
            `domyślne MPV niedozwolone (fail-closed, finansowo materialne, AI-Review-3)`
        )
      }

      // ── Saldo (4.1) + spójność breakage ───────────────────────────────────
      const remaining = Math.max(0, ent.remaining_amount ?? 0)

      // AI-Review-1: net/vat opcjonalne gdy sweep nie dysponuje kwotami emisji.
      // Przy runtime_enabled=false posting jest no-op → proxy gross (remaining) bezpieczny.
      // Przy runtime_enabled=true: wymagane (fail-closed poniżej).
      const netMinorProvided =
        input.voucher_net_minor != null && input.voucher_vat_minor != null
      const netMinor = input.voucher_net_minor ?? remaining
      const vatMinor = input.voucher_vat_minor ?? 0
      const totalGross = netMinor + vatMinor

      // AI-Review-1: fail-closed gdy posting aktywowany a kwoty niejawne.
      if (!netMinorProvided) {
        const gate = this.deps.postingActivation ?? defaultPostingActivationGate()
        if (gate.runtimeEnabled) {
          throw new EntitlementNotExpirableError(
            `expire: entitlement ${ent.id} — voucher_net_minor/vat_minor wymagane gdy ` +
              `runtime_enabled=true; ustaw kwoty emisji przed flip E6/P6 lub przekaż ` +
              `przez caller (fail-closed, AI-Review-1)`
          )
        }
      }

      if (remaining > totalGross) {
        throw new ExpireAmountError(
          `expire: remaining (${remaining}) > brutto vouchera (${totalGross}); ` +
            `payload net/vat niespójny z saldem (fail-closed)`
        )
      }

      // AI-Review-5: cross-walidacja net+vat vs issued_gross z redemption (jak 4.1 L3).
      // Gdy caller podał jawne kwoty ORAZ istnieje rekord redemption (↔ issued_gross
      // przechowywany) — sprawdź spójność. Brak rekordu = nowy voucher/sweep → pomiń.
      if (netMinorProvided) {
        const issuedGross = await tx.findIssuedGross(ent.id)
        if (issuedGross != null && totalGross !== issuedGross) {
          throw new ExpireAmountError(
            `expire: entitlement ${ent.id} — voucher_net_minor+vat_minor (${totalGross}) ≠ ` +
              `issued_gross z poprzednich rat (${issuedGross}); niespójność kwot emisji ` +
              `(fail-closed, AI-Review-5). Przekaż spójne kwoty ze snapshotu emisji.`
          )
        }
      }

      // redeemed-to-date PRZED wygaśnięciem (VER-H1, rezydualny VAT) = brutto − remaining.
      const priorRedeemedGross = totalGross - remaining

      const scope: TransitionScope = {
        instance_id: ent.id,
        market_id: resolvedMarketId,
        sales_channel_id: input.sales_channel_id ?? ent.sales_channel_id ?? null,
        vendor_id: input.vendor_id ?? ent.vendor_id ?? null,
        location_id: input.location_id ?? ent.location_id ?? null,
      }
      const actor: TransitionActor = input.actor ?? "system"
      const actorHint = input.actor_hint ?? "system:expiry-sweep"
      const occurredAt = now.toISOString()

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

      // ── Krok 1: marker DOMENY (dedupe-first) — `<source> → EXPIRED` ─────────
      // Stan EXPIRED utrwalony PRZED postingiem: replay (gdyby rollback) NIE
      // zostawia stanu źródłowego z zaksięgowanym breakage (anti state↔ledger drift).
      // Saldo `remaining` NIE jest mutowane — zachowane dla recovery (refund 4.3 /
      // extend 4.4), defensywny expiry (anti-forfeiture).
      await tx.updateEntitlementState(
        ent.id,
        ent.state,
        EntitlementInstanceState.EXPIRED,
        now
      )

      // ── Krok 2: tranzycja przez JEDEN punkt okablowania (3.4) — BREAKAGE ────
      // Reużycie wiring jako nowy CALLER (anti-dispersja R1). Posting hook woła
      // generateVoucherPosting() EXPIRED (2.3) → ledger-writer (2.6). Bramkowany:
      // runtime_enabled=false ⇒ audit-only/no-op (ZERO zapisu ledger). SPV VAT
      // już rozpoznany / MPV unused = bez VAT (art. 73a) — liczy generator 2.3.
      //
      // AI-Review-6 — KNOWN-LIMITATION (atomowość state↔ledger, dziedziczone 3.4/2.6):
      // `PostgresExpireEntitlementStore.withTransaction` prowadzi BEGIN/COMMIT na jednym
      // kliencie PG; `VoucherLedgerWriter` (post-aktywacji) używa INNEGO połączenia/tx.
      // Jeśli outer COMMIT zawiedzie PO zapisie ledgera ⇒ stan wiersza ≠ ledger.
      // Backstop: reconciliation 2.6 + deterministyczny transaction_id (ADR-139 D3).
      // Przy runtime_enabled=false: brak zapisu ledgera → brak ryzyka.
      // Cross-ref: 3.4 AI-3 (ta sama właściwość w okablowaniu 3.4); E6/P6 caller MUSI
      // zagwarantować brak rollbacku po zwrocie z hooka (warunek integracji).
      const wired = await wireEntitlementTransitionPersisted(wiringDeps, {
        from: ent.state,
        to: EntitlementInstanceState.EXPIRED,
        entitlement_id: ent.id,
        scope,
        actor,
        actor_hint: actorHint,
        occurred_at: occurredAt,
        transition_seq: `${ent.id}:expired`,
        posting: {
          lifecycle_event: "EXPIRED",
          vat_classification: vatClassification,
          net_minor: netMinor,
          vat_minor: vatMinor,
          remaining_gross_minor: remaining,
          redeemed_gross_to_date_minor: priorRedeemedGross,
          // EXPIRED dyskryminator deterministycznego transaction_id (ADR-139 D3).
          remaining_gross_snapshot: remaining,
          currency,
          expected_currency: ent.issued_amount_currency ?? currency,
        },
      })

      return {
        kind: "applied" as const,
        remaining,
        posting: wired.posting,
        event: wired.event,
      }
    })

    if (txOut.kind === "replay") {
      // Replay domeny: stan był już EXPIRED ⇒ ZERO ponownego postingu/eventu.
      const remaining = Math.max(0, txOut.ent.remaining_amount ?? 0)
      const txId = deriveLedgerTransactionId({
        entitlement_id: txOut.ent.id,
        lifecycle_event: "EXPIRED",
        remaining_gross_snapshot: remaining,
      })
      return {
        entitlement_id: txOut.ent.id,
        new_state: EntitlementInstanceState.EXPIRED,
        remaining_minor: remaining,
        breakage: remaining > 0,
        customer_status: EXPIRED_CUSTOMER_STATUS,
        posting: {
          attempted: false,
          activated: false,
          persisted: false,
          deduped: true,
          transaction_id: txId,
          // AI-Review-1: nie twierdzimy o postingu z nieznanej ścieżki wygaszenia.
          // Entitlement EXPIRED może być wygaszony przez routowaną operację (z
          // bookingiem) LUB przez legacy bulk-flip cron (bez postingu). Replay NIE
          // może zakładać, że breakage już zaksięgowany — to proweniencja nieznana.
          reason:
            "domain replay — entitlement już EXPIRED (ścieżka wygaszenia nieznana: " +
            "routowana operacja lub legacy bulk-flip cron); breakage posting mógł NIE " +
            "zaistnieć; idempotentny, sweep bezpieczny",
        },
        idempotent: true,
        emit_failed: false,
      }
    }

    // Applied: emit eventu best-effort PO COMMIT (reconciliation-inwariant 2.6).
    const emitFailed = await emitTransitionEventAfterCommit(
      this.deps.events.emit,
      txOut.event
    )

    return {
      entitlement_id: input.entitlement_id,
      new_state: EntitlementInstanceState.EXPIRED,
      remaining_minor: txOut.remaining,
      breakage: txOut.remaining > 0,
      customer_status: EXPIRED_CUSTOMER_STATUS,
      posting: txOut.posting,
      idempotent: false,
      emit_failed: emitFailed,
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Pre-expiry notifier (dedup — powiadomienie RAZ per okno) — AC1
// ──────────────────────────────────────────────────────────────────────────

/** Sink wysyłki powiadomienia (kanał messaging/email per istniejąca infra). */
export type PreExpiryNotificationSink = {
  send: (notification: PreExpiryNotification) => Promise<void>
}

/**
 * Idempotentny zapis faktu wysłania powiadomienia (ON CONFLICT DO NOTHING).
 * `inserted:false` ⇒ powiadomienie dla tego okna już wysłane ⇒ no-op (dedup).
 */
export type PreExpiryDedupeStore = {
  recordSent: (
    notification: PreExpiryNotification
  ) => Promise<{ inserted: boolean }>
}

export type PreExpiryNotifierDeps = {
  sink: PreExpiryNotificationSink
  dedupe: PreExpiryDedupeStore
}

export type PreExpiryNotifyInput = {
  entitlement_id: string
  expires_at: Date
  remaining_minor: number
  currency?: string
  paid_extend?: boolean
}

export type PreExpiryNotifyResult = {
  notification: PreExpiryNotification
  /** true ⇒ wysłane teraz; false ⇒ dedup (już wysłane dla tego okna). */
  sent: boolean
}

/**
 * Wysyła pre-expiry powiadomienie (per entitlement + termin). AI-Review-2:
 * SEND-THEN-RECORD — sink wołany PRZED zapisem dedup. Dzięki temu awaria sinka
 * NIE oznacza notyfikacji jako wysłanej ⇒ ponowny sweep retryuje (NIE cicha utrata).
 * Brak sinka / undefined eventBus ⇒ fail-loud (NIE silent no-op, AI-Review-2).
 * Konsekwencja: równoczesne sweepy mogą wysłać duplikat (consumer idempotentny).
 * Copy anti-forfeiture egzekwowane mechanicznie w `buildPreExpiryNotification`.
 */
export class PreExpiryNotifier {
  constructor(private readonly deps: PreExpiryNotifierDeps) {}

  async notify(input: PreExpiryNotifyInput): Promise<PreExpiryNotifyResult> {
    const notification = buildPreExpiryNotification({
      entitlement_id: input.entitlement_id,
      expires_at: input.expires_at,
      remaining_minor: input.remaining_minor,
      ...(input.currency ? { currency: input.currency } : {}),
      ...(input.paid_extend !== undefined
        ? { paid_extend: input.paid_extend }
        : {}),
    })
    // AI-Review-2: send-then-record. Awaria sinka ⇒ rzucamy (NIE zapisujemy dedup)
    // ⇒ ponowny sweep retryuje wysyłkę (NIE cicha utrata powiadomienia anti-forfeiture).
    await this.deps.sink.send(notification)
    // Record po potwierdzonej wysyłce (ON CONFLICT DO NOTHING — idempotentny).
    await this.deps.dedupe.recordSent(notification)
    return { notification, sent: true }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Postgres store (production wiring) — EXPIRED operacja
// ──────────────────────────────────────────────────────────────────────────

type QueryResult<T> = Promise<{ rows: T[]; rowCount?: number | null }>
type PgClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>
  ) => QueryResult<T>
  release: () => void
}
type PgPool = { connect: () => Promise<PgClient> }

function mapExpirableRow(row: Record<string, unknown>): ExpirableEntitlement {
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
  const expiresRaw = row.expires_at
  return {
    id: row.id as string,
    entitlement_type: row.entitlement_type as EntitlementType,
    state: row.state as EntitlementInstanceState,
    remaining_amount:
      row.remaining_amount != null ? Number(row.remaining_amount) : null,
    policy_snapshot: snapshotPolicy(snap),
    vat_classification:
      (row.vat_classification ?? null) as VatClassification | null,
    issued_amount_currency:
      typeof snap.currency_code === "string" ? snap.currency_code : null,
    expires_at:
      expiresRaw == null
        ? null
        : expiresRaw instanceof Date
          ? expiresRaw
          : new Date(String(expiresRaw)),
    market_id: (row.market_id ?? null) as string | null,
    sales_channel_id: (row.sales_channel_id ?? null) as string | null,
    vendor_id: (row.vendor_id ?? null) as string | null,
    location_id: (row.location_id ?? null) as string | null,
  }
}

export class PostgresExpireEntitlementStore implements ExpireEntitlementStore {
  constructor(private readonly pool: PgPool) {}

  async withTransaction<T>(
    fn: (tx: ExpireEntitlementTx) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const result = await fn(new PostgresExpireEntitlementTx(client))
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

class PostgresExpireEntitlementTx implements ExpireEntitlementTx {
  constructor(private readonly client: PgClient) {}

  async getEntitlementForUpdate(
    id: string
  ): Promise<ExpirableEntitlement | null> {
    const res = await this.client.query<Record<string, unknown>>(
      `SELECT id, entitlement_type, state, remaining_amount, policy_snapshot,
              vat_classification, expires_at, market_id, sales_channel_id,
              vendor_id, location_id
         FROM entitlement_instance
        WHERE id = $1
        FOR UPDATE`,
      [id]
    )
    const row = res.rows[0]
    if (!row) return null
    return mapExpirableRow(row)
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

  async appendAudit(audit: TransitionAuditEnvelope): Promise<void> {
    // Append-only audit envelope (niemutowalny ślad) do voucher_event, spójnie z
    // emiterami service.ts / redeem-partial (id, voucher_code NULL, entitlement_id,
    // event_type, payload jsonb). Atomowy ze zmianą stanu (ta sama tx).
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

  async findIssuedGross(entitlementId: string): Promise<number | null> {
    // AI-Review-5: cross-walidacja net+vat vs issued_gross z voucher_redemption.
    // Pobiera issued_gross_minor (imm.) z pierwszego rekordu redempcji (wszystkie
    // raty współdzielą tę samą wartość — walidacja VER-H1 z 4.1 gwarantuje spójność).
    const res = await this.client.query<{ issued_gross_minor: string }>(
      `SELECT issued_gross_minor
         FROM voucher_redemption
        WHERE entitlement_id = $1
        LIMIT 1`,
      [entitlementId]
    )
    const row = res.rows[0]
    return row ? Number(row.issued_gross_minor) : null
  }
}

/**
 * Postgres dedup store pre-expiry powiadomień — reużywa append-only `voucher_event`
 * z `ON CONFLICT (id) DO NOTHING` (id = deterministyczny `idempotency_key` okna).
 * NIE wymaga nowej migracji (CHECK enum event_type zdjęty w 1778925265229).
 */
export class PostgresPreExpiryDedupeStore implements PreExpiryDedupeStore {
  constructor(private readonly pool: PgPool) {}

  async recordSent(
    notification: PreExpiryNotification
  ): Promise<{ inserted: boolean }> {
    const client = await this.pool.connect()
    try {
      const res = await client.query(
        `INSERT INTO voucher_event (id, voucher_code, entitlement_id, event_type, payload, occurred_at, created_at)
         VALUES ($1, NULL, $2, $3, $4::jsonb, $5, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [
          notification.idempotency_key,
          notification.entitlement_id,
          notification.event_type,
          JSON.stringify(notification),
          notification.expires_at,
        ]
      )
      return { inserted: (res.rowCount ?? 0) === 1 }
    } finally {
      client.release()
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// In-memory store (testing) — mirror semantyki PG
// ──────────────────────────────────────────────────────────────────────────

export class InMemoryExpireEntitlementStore implements ExpireEntitlementStore {
  private rows: Map<string, ExpirableEntitlement>
  private audits: TransitionAuditEnvelope[]

  constructor(rows: ExpirableEntitlement[] = []) {
    this.rows = new Map(rows.map((r) => [r.id, { ...r }]))
    this.audits = []
  }

  get(id: string): ExpirableEntitlement | undefined {
    return this.rows.get(id)
  }

  /** Append-only audyty utrwalone (po COMMIT) — do asercji AC2 w testach. */
  listAudits(): TransitionAuditEnvelope[] {
    return [...this.audits]
  }

  async withTransaction<T>(
    fn: (tx: ExpireEntitlementTx) => Promise<T>
  ): Promise<T> {
    const rowsSnapshot = new Map(
      [...this.rows.entries()].map(([id, r]) => [id, { ...r }])
    )
    const auditsLen = this.audits.length
    try {
      return await fn(new InMemoryExpireEntitlementTx(this.rows, this.audits))
    } catch (err) {
      // Rollback: przywróć migawkę + odetnij audyty tej tx (fail-closed).
      this.rows = rowsSnapshot
      this.audits.length = auditsLen
      throw err
    }
  }
}

class InMemoryExpireEntitlementTx implements ExpireEntitlementTx {
  constructor(
    private readonly rows: Map<string, ExpirableEntitlement>,
    private readonly audits: TransitionAuditEnvelope[]
  ) {}

  async getEntitlementForUpdate(
    id: string
  ): Promise<ExpirableEntitlement | null> {
    const row = this.rows.get(id)
    if (!row) return null
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

  async appendAudit(audit: TransitionAuditEnvelope): Promise<void> {
    this.audits.push(audit)
  }

  async findIssuedGross(_entitlementId: string): Promise<number | null> {
    // Testy in-memory: brak rekordu redemption → pomiń cross-walidację (null).
    // Testy cross-walidacji używają osobnych mocków/fake store.
    return null
  }
}

/** In-memory dedup store pre-expiry powiadomień (mirror ON CONFLICT DO NOTHING). */
export class InMemoryPreExpiryDedupeStore implements PreExpiryDedupeStore {
  private readonly sent = new Set<string>()

  listSent(): string[] {
    return [...this.sent]
  }

  async recordSent(
    notification: PreExpiryNotification
  ): Promise<{ inserted: boolean }> {
    if (this.sent.has(notification.idempotency_key)) {
      return { inserted: false }
    }
    this.sent.add(notification.idempotency_key)
    return { inserted: true }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Factory (production container wiring)
// ──────────────────────────────────────────────────────────────────────────

type EventBusLike = {
  emit?: (message: {
    name: string
    data: TransitionEventEnvelope | PreExpiryNotification
  }) => Promise<unknown>
}

/**
 * Buduje operację EXPIRED z kontenera. KRYTYCZNE: bramka aktywacji NIE jest
 * wstrzykiwana ⇒ używana jest `defaultPostingActivationGate()` (czyta REALNĄ
 * `runtime_enabled` = false). Posting breakage jest WIĘC audit-only/no-op w
 * produkcji do czasu ręcznej aktywacji P6/E6 (NIE flipujemy tu nic).
 */
export function createExpireEntitlementOperationFromScope(scope: {
  resolve: (key: string) => unknown
}): ExpireEntitlementOperation {
  const pool = scope.resolve("__pg_pool__") as PgPool
  let eventBus: EventBusLike | undefined
  try {
    eventBus = scope.resolve(Modules.EVENT_BUS) as EventBusLike
  } catch {
    eventBus = undefined
  }
  return new ExpireEntitlementOperation({
    store: new PostgresExpireEntitlementStore(pool),
    events: {
      async emit(event) {
        await eventBus?.emit?.({ name: event.event_type, data: event })
      },
    },
    // ledgerWriter celowo niepodpięty domyślnie: posting hook inert przy
    // runtime_enabled=false (audit-only). Podpięcie writera = krok aktywacji E6/P6.
  })
}

/**
 * Buduje pre-expiry notifier z kontenera. Sink emituje event powiadomienia do
 * istniejącej infry eventów (messaging/email konsumują w warstwie subscriber).
 * Dedup przez append-only `voucher_event` (ON CONFLICT id). AI-Review-2:
 * brak eventBus (resolve w catch) ⇒ sink rzuca (fail-loud, NIE silent no-op).
 */
export function createPreExpiryNotifierFromScope(scope: {
  resolve: (key: string) => unknown
}): PreExpiryNotifier {
  const pool = scope.resolve("__pg_pool__") as PgPool
  let eventBus: EventBusLike | undefined
  try {
    eventBus = scope.resolve(Modules.EVENT_BUS) as EventBusLike
  } catch {
    eventBus = undefined
  }
  return new PreExpiryNotifier({
    sink: {
      async send(notification) {
        // AI-Review-2: fail-loud gdy brak event busu — NIE silent no-op.
        // Brak dostarczenia powiadomienia anti-forfeiture jest materialny konsumencko.
        if (eventBus == null || typeof eventBus.emit !== "function") {
          throw new Error(
            `pre-expiry notifier: event bus niedostępny — nie można dostarczyć ` +
              `powiadomienia anti-forfeiture dla entitlement ${notification.entitlement_id} ` +
              `(fail-loud, AI-Review-2). Sprawdź rejestrację EVENT_BUS w kontenerze.`
          )
        }
        await eventBus.emit({
          name: notification.event_type,
          data: notification,
        })
      },
    },
    dedupe: new PostgresPreExpiryDedupeStore(pool),
  })
}
