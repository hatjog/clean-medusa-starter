/**
 * refund-entitlement.ts — Story 4.3 (v1.11.0 Epic 4 / Wave 4 — lifecycle L4 refund).
 *
 * Operacja ZWROTU vouchera KWOTOWEGO — DWA rozłączne mechanizmy (po redeem 4.1 +
 * saldo/expiry 4.2), routujące tranzycję `<source> → REFUND_REQUESTED → REFUNDED`
 * przez JEDEN punkt okablowania (`wireEntitlementTransition`, 3.4):
 *
 *   (a) ODSTĄPIENIE 14 dni (AC1) — pełny zwrot niewykorzystanego w oknie ustawowym
 *       (`refund_window_days:14`, `requires_unused_entitlement:true`); prawo
 *       odstąpienia gaśnie WYŁĄCZNIE przy REDEEMED_FULL (reuse 4.1, art. 38 pkt 1).
 *       Po oknie ⇒ FAIL-CLOSED; po jakimkolwiek redeem ⇒ kieruje do (b).
 *   (b) ZWROT SALDA (AC2) — zwracana niewykorzystana część `remaining` (stan ze
 *       Story 4.1), dozwolony także po partial (art. 385¹ KC).
 *
 * Copy rozróżnia (a)/(b) (FR17/UX-DR-14); RODO art. 26 carry-forward przez istniejący
 * kontrakt DSAR (AC3, ADR-069) — patrz `entitlement-refund.ts` (czysta logika).
 *
 * KRYTYCZNE — posting derecognition FAIL-CLOSED (ADR-139 §Granice):
 *   posting profile `voucher_liability_only_v1` NIE zna `REFUNDED` (lifecycle =
 *   ISSUED/REDEEMED/EXPIRED→BREAKAGE). Refund derecognition = **NO posting + alarm,
 *   wymaga OSOBNEGO ADR**. Operacja NIE przekazuje payloadu postingu do hooka —
 *   tranzycja → REFUNDED przechodzi przez okablowanie 3.4 dla EVENT + AUDIT (gated,
 *   audit-only/no-op), a derecognition finansowy jest DEFEROWANY architektonicznie
 *   (`RefundPostingDeferral` — emitowany jako alarm + utrwalony w audycie). NIE
 *   wymyślamy księgowania (task §KRYTYCZNA GRANICA).
 *
 * IDEMPOTENCJA: `REFUNDED` jest terminalnym stanem-markerem (replay ⇒ no-op, ZERO
 * podwójnego zwrotu / podwójnej tranzycji). `refund_id` jest dyskryminatorem audytu
 * refundu (ON CONFLICT DO NOTHING) i seamem idempotencji zwrotu płatności
 * (`buildPaymentRefundIdempotencyKey`, Stripe NIE aktywowany — scope window).
 *
 * FAIL-CLOSED: niedozwolona tranzycja refund (nielegalny stan / typ) odrzucona PRZED
 * jakimkolwiek efektem ubocznym (`assertTransition` w okablowaniu 3.4 + guardy tu).
 *
 * GRANICE (E4): refund (extend = 4.4, transfer = 4.5). NIE flipuje `runtime_enabled`
 * (zostaje false, flip = E6/P6). NIE rusza hard-gate'ów MPV/SUBSCRIPTION. NIE buduje
 * cross-vendor wallet ani nowego kanału DSAR.
 *
 * Podstawa normatywna (NFR4 — referencja, NIE autorstwo): ADR-069 (DSAR carry-forward),
 * ADR-139 (§Granice refund-after-redeem fail-closed; D5 governed activation), ADR-133
 * (separacja entitlement↔money), ADR-134/136 (hard-gate'y MPV/SUBSCRIPTION — off).
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
import type { RefundChannel } from "../entitlement-boundary"
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
import {
  determineRefundMechanism,
  resolveRefundChannel,
  resolveRefundWindowDays,
  buildRefundCopy,
  buildDsarCarryForward,
  buildRefundPostingDeferral,
  buildPaymentRefundIdempotencyKey,
  type RefundMechanism,
  type RefundCopy,
  type DsarCarryForward,
  type RefundPostingDeferral,
} from "../entitlement-refund"

// ──────────────────────────────────────────────────────────────────────────
// Stany źródłowe legalne dla ścieżki refund (z grafu, NIE hardcode)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Stany, z których `→ REFUND_REQUESTED` jest legalną krawędzią (D-5: ACTIVE,
 * REDEEMED_PARTIAL, REDEEMED_FULL, SETTLED, EXPIRED) PLUS sam `REFUND_REQUESTED`
 * (gdy refund już zażądany — finalizacja → REFUNDED). Derywowane z grafu (dryf
 * taksonomii automatycznie zwęża/rozszerza zbiór; NIGDY nielegalna tranzycja).
 */
export const REFUND_SOURCE_STATES: ReadonlySet<EntitlementInstanceState> =
  new Set([
    ...(
      Object.keys(ALLOWED_ENTITLEMENT_TRANSITIONS) as EntitlementInstanceState[]
    ).filter((from) =>
      ALLOWED_ENTITLEMENT_TRANSITIONS[from].includes(
        EntitlementInstanceState.REFUND_REQUESTED
      )
    ),
    EntitlementInstanceState.REFUND_REQUESTED,
  ])

/** Event type tranzycji refund (rich payload: mechanizm/kanał/DSAR/deferral). */
export const ENTITLEMENT_REFUNDED_EVENT_TYPE =
  "gp.entitlements.entitlement_refunded.v1" as const

// ──────────────────────────────────────────────────────────────────────────
// Błędy fail-closed
// ──────────────────────────────────────────────────────────────────────────

export class RefundEntitlementNotFoundError extends Error {
  constructor(id: string) {
    super(`entitlement_instance ${id} was not found`)
    this.name = "RefundEntitlementNotFoundError"
  }
}

/** Rzucany gdy entitlement nie jest w stanie/typie zdolnym do refundu (fail-closed). */
export class EntitlementNotRefundableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EntitlementNotRefundableError"
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Kontrakty wejścia / wyjścia
// ──────────────────────────────────────────────────────────────────────────

export type RefundEntitlementInput = {
  entitlement_id: string
  /** Klucz idempotencji refundu (dyskryminator audytu + seam zwrotu płatności). */
  refund_id: string
  /** Intencja mechanizmu: (a) `withdrawal` / (b) `balance`. */
  mechanism: RefundMechanism
  /**
   * Brutto CAŁEGO vouchera przy emisji (net+vat, minor units) — do detekcji
   * „niewykorzystany" (mechanizm a). Opcjonalne: gdy brak, czytane z
   * `voucher_redemption.issued_gross_minor` (po partial 4.1), inaczej = `remaining`
   * (voucher bez redempcji ⇒ całkowicie niewykorzystany).
   */
  issued_gross_minor?: number
  /** Waluta zwrotu (copy + seam płatności). Domyślnie PLN (bonbeauty). */
  currency?: string
  /** Moment emisji (start okna 14 dni). Domyślnie `created_at` wiersza. */
  issued_at?: Date
  /** Ontologia scope (FK 3.2). `market_id` wymagany (fail-loud NFR3). */
  market_id?: string | null
  sales_channel_id?: string | null
  vendor_id?: string | null
  location_id?: string | null
  /** Aktor tranzycji (envelope.v1). Domyślnie `customer` (klient inicjuje zwrot). */
  actor?: TransitionActor
  actor_hint?: string
  now?: Date
}

export type RefundEntitlementResult = {
  entitlement_id: string
  refund_id: string
  mechanism: RefundMechanism
  refund_channel: RefundChannel
  refunded_amount_minor: number
  currency: string
  /** true ⇒ voucher całkowicie niewykorzystany (redeemed-to-date = 0). */
  fully_unused: boolean
  /** AC3 4.1: prawo odstąpienia (art. 38 pkt 1) — gaśnie WYŁĄCZNIE przy REDEEMED_FULL. */
  withdrawal_right_extinguished: boolean
  new_state: EntitlementInstanceState.REFUNDED
  /** Copy rozróżniające (a)/(b) — podstawa + kwota NIGDY mylące (UX-DR-14). */
  copy: RefundCopy
  /** RODO art. 26 carry-forward — KONSUMUJE istniejący kontrakt DSAR (AC3). */
  dsar_carry_forward: DsarCarryForward
  /** Wynik posting hooka — `attempted:false` (BRAK payloadu, fail-closed ADR-139). */
  posting: TransitionPostingResult
  /** Marker fail-closed derecognition (ADR-139 §Granice) — wymaga osobnego ADR. */
  posting_deferred: RefundPostingDeferral
  /** Seam idempotencji zwrotu płatności (Stripe NIE aktywowany — scope window). */
  payment_refund_idempotency_key: string
  /** true ⇒ replay (stan był już REFUNDED) — ZERO podwójnego zwrotu/tranzycji. */
  idempotent: boolean
  /** true ⇒ 2× emit eventu zawiódł (best-effort; reconciliation 2.6). */
  emit_failed: boolean
}

/** Rich envelope refundu (audit + event) — mechanizm/kanał/DSAR/deferral. */
export type RefundLifecycleEnvelope = {
  schema_version: "1"
  event_type: typeof ENTITLEMENT_REFUNDED_EVENT_TYPE
  occurred_at: string
  actor: TransitionActor
  idempotency_key: string
  scope: TransitionScope
  payload: {
    entitlement_id: string
    refund_id: string
    mechanism: RefundMechanism
    refund_channel: RefundChannel
    refunded_amount_minor: number
    currency: string
    fully_unused: boolean
    withdrawal_right_extinguished: boolean
    copy: RefundCopy
    dsar_carry_forward: DsarCarryForward
    posting_deferred: RefundPostingDeferral
    payment_refund_idempotency_key: string
  }
}

/** Wiersz entitlementu potrzebny refundowi (podzbiór `entitlement_instance`). */
export type RefundableEntitlement = {
  id: string
  entitlement_type: EntitlementType
  state: EntitlementInstanceState
  remaining_amount: number | null
  policy_snapshot: EntitlementPolicySnapshot
  vat_classification: VatClassification | null
  issued_amount_currency?: string | null
  /** Moment emisji (start okna odstąpienia) — `created_at` lub kolumna emisji. */
  issued_at: Date | null
  market_id: string | null
  sales_channel_id: string | null
  vendor_id?: string | null
  location_id?: string | null
}

// ──────────────────────────────────────────────────────────────────────────
// Store / tx — granica persystencji (wzorzec expire/redeem-partial 4.1/4.2)
// ──────────────────────────────────────────────────────────────────────────

export interface RefundEntitlementTx {
  getEntitlementForUpdate(id: string): Promise<RefundableEntitlement | null>
  /** Brutto emisji z `voucher_redemption` (po partial 4.1). Null ⇒ brak redempcji. */
  findIssuedGross(entitlementId: string): Promise<number | null>
  /** Zmiana stanu (bez salda) — kroki `<source>→REFUND_REQUESTED→REFUNDED`. */
  updateEntitlementState(
    id: string,
    fromState: EntitlementInstanceState,
    toState: EntitlementInstanceState,
    now: Date
  ): Promise<void>
  /** Append-only audit tranzycji (w obrębie tej tx — atomowy ze zmianą stanu). */
  appendAudit(audit: TransitionAuditEnvelope): Promise<void>
  /**
   * Append-only rich audit refundu (ON CONFLICT (id) DO NOTHING — id = refund
   * idempotency_key). `inserted:false` ⇒ refund o tym `refund_id` już utrwalony.
   */
  appendRefundEvent(
    envelope: RefundLifecycleEnvelope
  ): Promise<{ inserted: boolean }>
}

export interface RefundEntitlementStore {
  withTransaction<T>(fn: (tx: RefundEntitlementTx) => Promise<T>): Promise<T>
}

export type RefundEntitlementEventEmitter = {
  emit: (
    event: TransitionEventEnvelope | RefundLifecycleEnvelope
  ) => Promise<void>
}

/** Sink alarmu deferralu refund postingu (ADR-139 §Granice). Best-effort. */
export type RefundPostingDeferralSink = {
  alarm: (deferral: RefundPostingDeferral, ctx: { entitlement_id: string; refund_id: string }) => Promise<void>
}

export type RefundEntitlementDeps = {
  store: RefundEntitlementStore
  events: RefundEntitlementEventEmitter
  /**
   * Bramka aktywacji postingu (ADR-139 D5). Domyślnie `defaultPostingActivationGate()`
   * = REALNA `runtime_enabled` (false). UWAGA: refund NIE przekazuje payloadu
   * postingu (fail-closed ADR-139 §Granice), więc hook jest `attempted:false`
   * NIEZALEŻNIE od bramki — bramka jest tu wyłącznie dla parytetu API z 4.1/4.2.
   */
  postingActivation?: PostingActivationGate
  /** Idempotentny writer ledgera (2.6) — parytet API; refund NIE księguje (deferral). */
  ledgerWriter?: TransitionLedgerWriter
  /** Opcjonalny sink alarmu deferralu (telemetria LNE). Brak ⇒ alarm tylko w wyniku. */
  deferralSink?: RefundPostingDeferralSink
  clock?: () => Date
}

// ──────────────────────────────────────────────────────────────────────────
// Operacja refund (dwa mechanizmy, idempotentna, posting fail-closed)
// ──────────────────────────────────────────────────────────────────────────

export class RefundEntitlementOperation {
  constructor(private readonly deps: RefundEntitlementDeps) {}

  async refund(
    input: RefundEntitlementInput
  ): Promise<RefundEntitlementResult> {
    const now = input.now ?? this.deps.clock?.() ?? new Date()
    const currency = input.currency ?? "PLN"
    if (!input.refund_id) {
      throw new EntitlementNotRefundableError(
        "refund: refund_id wymagany (idempotency key + seam zwrotu płatności)"
      )
    }
    const paymentRefundKey = buildPaymentRefundIdempotencyKey(
      input.entitlement_id,
      input.refund_id
    )

    const txOut = await this.deps.store.withTransaction(async (tx) => {
      const ent = await tx.getEntitlementForUpdate(input.entitlement_id)
      if (!ent) throw new RefundEntitlementNotFoundError(input.entitlement_id)

      // ── Bariera DOMENY idempotencji (replay) ───────────────────────────────
      // REFUNDED jest terminalnym markerem: replay widzi REFUNDED ⇒ no-op (ZERO
      // ponownej tranzycji/eventu/zwrotu). Tranzycja jest jednokierunkowa.
      if (ent.state === EntitlementInstanceState.REFUNDED) {
        return { kind: "replay" as const, ent }
      }

      // Scope: voucher KWOTOWY z saldem `remaining` (spójnie z redeem 4.1 / expire 4.2).
      if (ent.entitlement_type !== EntitlementType.VOUCHER_AMOUNT) {
        throw new EntitlementNotRefundableError(
          `refund: entitlement ${ent.id} nie jest VOUCHER_AMOUNT ` +
            `(typ=${ent.entitlement_type}); refund kwotowy poza zakresem`
        )
      }
      // Tylko legalne źródła ścieżki refund (D-5, fail-closed PRZED efektami).
      if (!REFUND_SOURCE_STATES.has(ent.state)) {
        throw new EntitlementNotRefundableError(
          `refund: entitlement ${ent.id} w stanie ${ent.state} nie ma legalnej ` +
            `ścieżki → REFUND_REQUESTED → REFUNDED (dozwolone źródła: ` +
            `${[...REFUND_SOURCE_STATES].join(", ")})`
        )
      }

      // ── Fail-loud na brakującym market_id (NFR3 per-market izolacja) ───────
      const resolvedMarketId = input.market_id ?? ent.market_id
      if (resolvedMarketId == null || resolvedMarketId === "") {
        throw new EntitlementNotRefundableError(
          `refund: entitlement ${ent.id} — brak market_id; wymagane jawne market_id ` +
            `dla izolacji per-market (NFR3, fail-loud). Uzupełnij w wierszu lub callerze.`
        )
      }

      // ── Kanał zwrotu ze snapshotu (fail-closed unknown; vendor_wallet single-vendor) ─
      const refundChannel = resolveRefundChannel(ent.policy_snapshot)

      // ── Saldo (4.1) + brutto emisji (detekcja „niewykorzystany") ───────────
      const remaining = Math.max(0, ent.remaining_amount ?? 0)
      // issued_gross: jawny override > voucher_redemption (po partial) > remaining.
      const issuedGrossFromRedemption = await tx.findIssuedGross(ent.id)
      const issuedGross =
        input.issued_gross_minor ?? issuedGrossFromRedemption ?? remaining

      const issuedAt = input.issued_at ?? ent.issued_at
      if (issuedAt == null) {
        throw new EntitlementNotRefundableError(
          `refund: entitlement ${ent.id} — brak issued_at (created_at/kolumna emisji); ` +
            `nie można policzyć okna odstąpienia 14 dni (fail-closed dla mechanizmu a)`
        )
      }
      const windowDays = resolveRefundWindowDays(ent.policy_snapshot)

      // ── Determinacja mechanizmu (rozłączne warunki, fail-closed) ───────────
      // Rzuca: RefundMechanismError (a po redeem / wygasłe prawo) / RefundWithdrawal
      // WindowError (a po oknie) / RefundAmountError (b bez salda) — PRZED efektami.
      const determination = determineRefundMechanism({
        requested: input.mechanism,
        state: ent.state,
        remaining_minor: remaining,
        issued_gross_minor: issuedGross,
        issued_at: issuedAt,
        now,
        window_days: windowDays,
      })

      // ── Copy rozróżniające (a)/(b) + anti-forfeiture (UX-DR-14) ────────────
      const copy = buildRefundCopy({
        mechanism: determination.mechanism,
        refunded_amount_minor: determination.refunded_amount_minor,
        currency,
      })

      // ── RODO art. 26 carry-forward (AC3) — KONSUMUJE istniejący kontrakt DSAR ─
      const dsarCarryForward = buildDsarCarryForward({
        market_id: resolvedMarketId,
        sales_channel_id: input.sales_channel_id ?? ent.sales_channel_id ?? null,
      })

      // ── Posting derecognition FAIL-CLOSED (ADR-139 §Granice) — NO posting + alarm ─
      const postingDeferral = buildRefundPostingDeferral({
        mechanism: determination.mechanism,
        unposted_amount_minor: determination.refunded_amount_minor,
        currency,
      })

      const scope: TransitionScope = {
        instance_id: ent.id,
        market_id: resolvedMarketId,
        sales_channel_id: input.sales_channel_id ?? ent.sales_channel_id ?? null,
        vendor_id: input.vendor_id ?? ent.vendor_id ?? null,
        location_id: input.location_id ?? ent.location_id ?? null,
      }
      const actor: TransitionActor = input.actor ?? "customer"
      const actorHint = input.actor_hint ?? `customer:refund:${determination.mechanism}`
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

      const events: TransitionEventEnvelope[] = []

      // ── Krok 1: <source> → REFUND_REQUESTED (niefinansowy, audit-only) ──────
      // Pomijany gdy już w REFUND_REQUESTED (refund zażądany wcześniej). Reużycie
      // JEDNEGO punktu okablowania (3.4) — refund to nowy CALLER (anti-dispersja R1).
      if (ent.state !== EntitlementInstanceState.REFUND_REQUESTED) {
        const step1 = await wireEntitlementTransitionPersisted(wiringDeps, {
          from: ent.state,
          to: EntitlementInstanceState.REFUND_REQUESTED,
          entitlement_id: ent.id,
          scope,
          actor,
          actor_hint: actorHint,
          occurred_at: occurredAt,
          transition_seq: `${input.refund_id}:request`,
        })
        await tx.updateEntitlementState(
          ent.id,
          ent.state,
          EntitlementInstanceState.REFUND_REQUESTED,
          now
        )
        events.push(step1.event)
      }

      // ── Krok 2: REFUND_REQUESTED → REFUNDED ────────────────────────────────
      // FAIL-CLOSED posting (ADR-139 §Granice): BRAK payloadu `posting` → hook
      // jest `attempted:false` (audit-only). Derecognition finansowy DEFEROWANY
      // (postingDeferral) — NIE wymyślamy księgowania REFUNDED w profilu, który go
      // nie zna. Event + audit tranzycji POWSTAJĄ (audytowalność niezależna).
      const step2 = await wireEntitlementTransitionPersisted(wiringDeps, {
        from: EntitlementInstanceState.REFUND_REQUESTED,
        to: EntitlementInstanceState.REFUNDED,
        entitlement_id: ent.id,
        scope,
        actor,
        actor_hint: actorHint,
        occurred_at: occurredAt,
        transition_seq: `${input.refund_id}:refunded`,
        // posting: CELOWO POMINIĘTY (fail-closed, ADR-139 §Granice).
      })
      await tx.updateEntitlementState(
        ent.id,
        EntitlementInstanceState.REFUND_REQUESTED,
        EntitlementInstanceState.REFUNDED,
        now
      )
      events.push(step2.event)

      // ── Rich audit refundu (ON CONFLICT id = refund idempotency_key) ───────
      const refundEnvelope: RefundLifecycleEnvelope = {
        schema_version: "1",
        event_type: ENTITLEMENT_REFUNDED_EVENT_TYPE,
        occurred_at: occurredAt,
        actor,
        idempotency_key: `entitlement:${ent.id}:refunded:${input.refund_id}`,
        scope,
        payload: {
          entitlement_id: ent.id,
          refund_id: input.refund_id,
          mechanism: determination.mechanism,
          refund_channel: refundChannel,
          refunded_amount_minor: determination.refunded_amount_minor,
          currency,
          fully_unused: determination.fully_unused,
          withdrawal_right_extinguished:
            determination.withdrawal_right_extinguished,
          copy,
          dsar_carry_forward: dsarCarryForward,
          posting_deferred: postingDeferral,
          payment_refund_idempotency_key: paymentRefundKey,
        },
      }
      const ins = await tx.appendRefundEvent(refundEnvelope)
      if (!ins.inserted) {
        // Konflikt rich-audit po `refund_id` PRZED commitem (równoległy refund o tym
        // samym refund_id) — fail-closed rollback. Retry trafi w replay (REFUNDED).
        throw new EntitlementNotRefundableError(
          `refund: konflikt idempotencji (entitlement_id=${ent.id}, refund_id=` +
            `${input.refund_id}) — równoległy refund; rollback fail-closed`
        )
      }

      return {
        kind: "applied" as const,
        ent,
        determination,
        refundChannel,
        copy,
        dsarCarryForward,
        postingDeferral,
        posting: step2.posting,
        events,
        refundEnvelope,
      }
    })

    if (txOut.kind === "replay") {
      // Replay domeny: stan był już REFUNDED ⇒ ZERO ponownego zwrotu/tranzycji/eventu.
      const remaining = Math.max(0, txOut.ent.remaining_amount ?? 0)
      const refundChannelReplay = resolveRefundChannel(txOut.ent.policy_snapshot)
      const copyReplay = buildRefundCopy({
        mechanism: input.mechanism,
        refunded_amount_minor: remaining,
        currency,
      })
      const deferralReplay = buildRefundPostingDeferral({
        mechanism: input.mechanism,
        unposted_amount_minor: remaining,
        currency,
      })
      return {
        entitlement_id: txOut.ent.id,
        refund_id: input.refund_id,
        mechanism: input.mechanism,
        refund_channel: refundChannelReplay,
        refunded_amount_minor: remaining,
        currency,
        fully_unused: false,
        withdrawal_right_extinguished: false,
        new_state: EntitlementInstanceState.REFUNDED,
        copy: copyReplay,
        dsar_carry_forward: buildDsarCarryForward({
          market_id: input.market_id ?? txOut.ent.market_id ?? "unknown",
          sales_channel_id:
            input.sales_channel_id ?? txOut.ent.sales_channel_id ?? null,
        }),
        posting: {
          attempted: false,
          activated: false,
          persisted: false,
          deduped: true,
          reason:
            "domain replay — entitlement już REFUNDED; jeden refund (NIE podwaja zwrotu/tranzycji); posting derecognition deferowany (ADR-139 §Granice)",
        },
        posting_deferred: deferralReplay,
        payment_refund_idempotency_key: paymentRefundKey,
        idempotent: true,
        emit_failed: false,
      }
    }

    // Applied: alarm deferralu (best-effort) + emit eventów PO COMMIT.
    if (this.deps.deferralSink) {
      try {
        await this.deps.deferralSink.alarm(txOut.postingDeferral, {
          entitlement_id: txOut.ent.id,
          refund_id: input.refund_id,
        })
      } catch {
        // Alarm best-effort — niepowodzenie NIE wycofuje refundu (deferral i tak w wyniku/audycie).
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
    // Rich refund event best-effort (consumer messaging/RODO/telemetria).
    try {
      await this.deps.events.emit(txOut.refundEnvelope)
    } catch {
      emitFailed = true
    }

    return {
      entitlement_id: txOut.ent.id,
      refund_id: input.refund_id,
      mechanism: txOut.determination.mechanism,
      refund_channel: txOut.refundChannel,
      refunded_amount_minor: txOut.determination.refunded_amount_minor,
      currency,
      fully_unused: txOut.determination.fully_unused,
      withdrawal_right_extinguished:
        txOut.determination.withdrawal_right_extinguished,
      new_state: EntitlementInstanceState.REFUNDED,
      copy: txOut.copy,
      dsar_carry_forward: txOut.dsarCarryForward,
      posting: txOut.posting,
      posting_deferred: txOut.postingDeferral,
      payment_refund_idempotency_key: paymentRefundKey,
      idempotent: false,
      emit_failed: emitFailed,
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Postgres store (production wiring)
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

function mapRefundableRow(row: Record<string, unknown>): RefundableEntitlement {
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
  const issuedRaw = row.created_at
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
    issued_at:
      issuedRaw == null
        ? null
        : issuedRaw instanceof Date
          ? issuedRaw
          : new Date(String(issuedRaw)),
    market_id: (row.market_id ?? null) as string | null,
    sales_channel_id: (row.sales_channel_id ?? null) as string | null,
    vendor_id: (row.vendor_id ?? null) as string | null,
    location_id: (row.location_id ?? null) as string | null,
  }
}

export class PostgresRefundEntitlementStore implements RefundEntitlementStore {
  constructor(private readonly pool: PgPool) {}

  async withTransaction<T>(
    fn: (tx: RefundEntitlementTx) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const result = await fn(new PostgresRefundEntitlementTx(client))
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

class PostgresRefundEntitlementTx implements RefundEntitlementTx {
  constructor(private readonly client: PgClient) {}

  async getEntitlementForUpdate(
    id: string
  ): Promise<RefundableEntitlement | null> {
    const res = await this.client.query<Record<string, unknown>>(
      `SELECT id, entitlement_type, state, remaining_amount, policy_snapshot,
              vat_classification, created_at, market_id, sales_channel_id,
              vendor_id, location_id
         FROM entitlement_instance
        WHERE id = $1
        FOR UPDATE`,
      [id]
    )
    const row = res.rows[0]
    if (!row) return null
    return mapRefundableRow(row)
  }

  async findIssuedGross(entitlementId: string): Promise<number | null> {
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

  async appendRefundEvent(
    envelope: RefundLifecycleEnvelope
  ): Promise<{ inserted: boolean }> {
    const res = await this.client.query(
      `INSERT INTO voucher_event (id, voucher_code, entitlement_id, event_type, payload, occurred_at, created_at)
       VALUES ($1, NULL, $2, $3, $4::jsonb, $5, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        envelope.idempotency_key,
        envelope.payload.entitlement_id,
        envelope.event_type,
        JSON.stringify(envelope),
        envelope.occurred_at,
      ]
    )
    return { inserted: (res.rowCount ?? 0) === 1 }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// In-memory store (testing) — mirror semantyki PG (ON CONFLICT DO NOTHING)
// ──────────────────────────────────────────────────────────────────────────

export class InMemoryRefundEntitlementStore implements RefundEntitlementStore {
  private rows: Map<string, RefundableEntitlement>
  private issuedGross: Map<string, number>
  private audits: TransitionAuditEnvelope[]
  private refundEvents: Map<string, RefundLifecycleEnvelope>

  constructor(
    rows: RefundableEntitlement[] = [],
    issuedGross: Record<string, number> = {}
  ) {
    this.rows = new Map(rows.map((r) => [r.id, { ...r }]))
    this.issuedGross = new Map(Object.entries(issuedGross))
    this.audits = []
    this.refundEvents = new Map()
  }

  get(id: string): RefundableEntitlement | undefined {
    return this.rows.get(id)
  }

  /** Append-only audyty utrwalone (po COMMIT) — do asercji AC1/AC2 w testach. */
  listAudits(): TransitionAuditEnvelope[] {
    return [...this.audits]
  }

  listRefundEvents(): RefundLifecycleEnvelope[] {
    return [...this.refundEvents.values()]
  }

  async withTransaction<T>(
    fn: (tx: RefundEntitlementTx) => Promise<T>
  ): Promise<T> {
    const rowsSnapshot = new Map(
      [...this.rows.entries()].map(([id, r]) => [id, { ...r }])
    )
    const auditsLen = this.audits.length
    const refundEventsSnapshot = new Map(this.refundEvents)
    try {
      return await fn(
        new InMemoryRefundEntitlementTx(
          this.rows,
          this.issuedGross,
          this.audits,
          this.refundEvents
        )
      )
    } catch (err) {
      // Rollback: przywróć migawki + odetnij audyty tej tx (fail-closed, ZERO
      // efektów ubocznych na odrzuconej ścieżce).
      this.rows = rowsSnapshot
      this.audits.length = auditsLen
      this.refundEvents = refundEventsSnapshot
      throw err
    }
  }
}

class InMemoryRefundEntitlementTx implements RefundEntitlementTx {
  constructor(
    private readonly rows: Map<string, RefundableEntitlement>,
    private readonly issuedGross: Map<string, number>,
    private readonly audits: TransitionAuditEnvelope[],
    private readonly refundEvents: Map<string, RefundLifecycleEnvelope>
  ) {}

  async getEntitlementForUpdate(
    id: string
  ): Promise<RefundableEntitlement | null> {
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

  async findIssuedGross(entitlementId: string): Promise<number | null> {
    return this.issuedGross.has(entitlementId)
      ? (this.issuedGross.get(entitlementId) as number)
      : null
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

  async appendRefundEvent(
    envelope: RefundLifecycleEnvelope
  ): Promise<{ inserted: boolean }> {
    if (this.refundEvents.has(envelope.idempotency_key)) {
      return { inserted: false }
    }
    this.refundEvents.set(envelope.idempotency_key, envelope)
    return { inserted: true }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Factory (production container wiring)
// ──────────────────────────────────────────────────────────────────────────

type EventBusLike = {
  emit?: (message: { name: string; data: unknown }) => Promise<unknown>
}

/** Event type alarmu deferralu refund postingu (ADR-139 §Granice). */
export const REFUND_POSTING_DEFERRED_EVENT_TYPE =
  "gp.entitlements.refund_posting_deferred.v1" as const

/**
 * Buduje operację refund z kontenera. KRYTYCZNE: refund NIE przekazuje payloadu
 * postingu (fail-closed ADR-139 §Granice) ⇒ posting hook jest audit-only/no-op
 * NIEZALEŻNIE od bramki; derecognition finansowy DEFEROWANY (wymaga osobnego ADR).
 * Operacja NIE flipuje `runtime_enabled`, NIE księguje refundu, NIE deklaruje
 * finance sign-off (E6/P6).
 */
export function createRefundEntitlementOperationFromScope(scope: {
  resolve: (key: string) => unknown
}): RefundEntitlementOperation {
  const pool = scope.resolve("__pg_pool__") as PgPool
  let eventBus: EventBusLike | undefined
  try {
    eventBus = scope.resolve(Modules.EVENT_BUS) as EventBusLike
  } catch {
    eventBus = undefined
  }
  return new RefundEntitlementOperation({
    store: new PostgresRefundEntitlementStore(pool),
    events: {
      async emit(event) {
        await eventBus?.emit?.({ name: event.event_type, data: event })
      },
    },
    deferralSink: {
      async alarm(deferral, ctx) {
        // Alarm deferralu refund postingu (ADR-139 §Granice) → event bus (telemetria
        // LNE / monitoring). Best-effort; brak busu ⇒ deferral i tak w wyniku/audycie.
        await eventBus?.emit?.({
          name: REFUND_POSTING_DEFERRED_EVENT_TYPE,
          data: {
            event_type: REFUND_POSTING_DEFERRED_EVENT_TYPE,
            entitlement_id: ctx.entitlement_id,
            refund_id: ctx.refund_id,
            deferral,
          },
        })
      },
    },
  })
}
