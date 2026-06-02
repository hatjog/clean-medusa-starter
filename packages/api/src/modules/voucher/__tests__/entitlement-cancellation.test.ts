/**
 * Story 4.6 (v1.11.0 Epic 4 / Wave 4 — lifecycle L4 cancellation / no-show) — unit tests.
 *
 * Pokrywa AC1 + AC2 polityki/okablowania anulacji/no-show/rebook:
 *   AC1 — anulacja ≥24h (cutoff ≥12h) ⇒ voucher W PEŁNI AKTYWNY (`remaining`/`expires_at`
 *         niezmienione, tier=full_active, brak derecognition); tranzycja audytowana przez
 *         jednolity punkt (audit envelope + posting hook audit-only).
 *   AC2 — anulacja <24h / no-show ⇒ WARTOŚĆ ZACHOWANA + rebook (tier=value_preserved);
 *         INWARIANT UX-DR-14 M-5: rebook NIE skraca `expires_at` (regresja
 *         `expires_at_after == expires_at_before`); copy NIGDY „przepadnie".
 *   CUTOFF — jawna anulacja <12h przed terminem ⇒ fail-closed (CancellationCutoffError);
 *            no-show NIE podlega cutoffowi (wartość zachowana).
 *   T3  — idempotencja (replay ⇒ no-op, idempotency_key wymagany fail-closed); posting
 *         GATED (audit-only/no-op, runtime_enabled=false); taksonomia (D-5) niezmienna.
 */

import { describe, it, expect } from "@jest/globals"
import {
  CANCELLATION_CUTOFF_HOURS,
  CANCELLATION_ACTIVE_THRESHOLD_HOURS,
  CancellationCutoffError,
  CancellationIdempotencyMissingError,
  CancellationHoursInvalidError,
  RebookExpiryShorteningError,
  ForfeitureCopyError,
  determineCancellationOutcome,
  determineNoShowOutcome,
  computeRebookExpiresAt,
  assertRebookPreservesExpiry,
  buildCancellationIdempotencyKey,
  buildRebookIdempotencyKey,
  defaultCancellationMessage,
  defaultRebookMessage,
  assertCancellationCopySafe,
  buildCancellationPostingNoop,
  cancellationActorHint,
  buildCancellationTransitionInput,
  buildCancellationWiring,
  ALL_ENTITLEMENT_INSTANCE_STATES,
  EntitlementInstanceState,
  ENTITLEMENT_STATE_CHANGED_EVENT_TYPE,
  type TransitionAuditEnvelope,
  type TransitionEventEnvelope,
} from ".."

const SCOPE = {
  instance_id: "ent_cancel_001",
  market_id: "mkt_bonbeauty",
  sales_channel_id: "sc_bonbeauty",
}

const KEY = buildCancellationIdempotencyKey("ent_cancel_001", "seq-1")

// ---------------------------------------------------------------------------
// AC1 — anulacja ≥24h (cutoff ≥12h) ⇒ voucher w pełni aktywny
// ---------------------------------------------------------------------------

describe("determineCancellationOutcome — (AC1) ≥24h ⇒ full_active", () => {
  it("48h przed terminem ⇒ tier=full_active, wartość/saldo/expiry niezmienione, brak derecognition", () => {
    const d = determineCancellationOutcome({
      hours_before_appointment: 48,
      idempotency_key: KEY,
    })
    expect(d.tier).toBe("full_active")
    expect(d.value_preserved).toBe(true)
    expect(d.derecognition).toBe(false)
    expect(d.remaining_changed).toBe(false)
    expect(d.expires_at_changed).toBe(false)
    expect(d.idempotent_replay).toBe(false)
  })

  it("dokładnie 24h (granica progu) ⇒ full_active (>= threshold)", () => {
    const d = determineCancellationOutcome({
      hours_before_appointment: CANCELLATION_ACTIVE_THRESHOLD_HOURS,
      idempotency_key: KEY,
    })
    expect(d.tier).toBe("full_active")
  })
})

// ---------------------------------------------------------------------------
// AC2 — anulacja <24h ⇒ wartość zachowana + rebook
// ---------------------------------------------------------------------------

describe("determineCancellationOutcome — (AC2) <24h ⇒ value_preserved + rebook", () => {
  it("18h przed terminem (≥cutoff, <24h) ⇒ tier=value_preserved, rebookable, wartość zachowana", () => {
    const d = determineCancellationOutcome({
      hours_before_appointment: 18,
      idempotency_key: KEY,
    })
    expect(d.tier).toBe("value_preserved")
    expect(d.value_preserved).toBe(true)
    expect(d.rebookable).toBe(true)
    expect(d.derecognition).toBe(false)
    expect(d.remaining_changed).toBe(false)
    expect(d.expires_at_changed).toBe(false)
  })

  it("dokładnie 23.99h (tuż poniżej progu) ⇒ value_preserved", () => {
    const d = determineCancellationOutcome({
      hours_before_appointment: 23.99,
      idempotency_key: KEY,
    })
    expect(d.tier).toBe("value_preserved")
  })
})

// ---------------------------------------------------------------------------
// CUTOFF — fail-closed po cutoff (jawna anulacja <12h przed terminem)
// ---------------------------------------------------------------------------

describe("determineCancellationOutcome — CUTOFF 12h fail-closed", () => {
  it("dokładnie 12h (granica cutoffu) ⇒ DOZWOLONE (value_preserved, >= cutoff)", () => {
    const d = determineCancellationOutcome({
      hours_before_appointment: CANCELLATION_CUTOFF_HOURS,
      idempotency_key: KEY,
    })
    expect(d.tier).toBe("value_preserved")
  })

  it("11h przed terminem (PO cutoff, <12h) ⇒ CancellationCutoffError (fail-closed)", () => {
    expect(() =>
      determineCancellationOutcome({
        hours_before_appointment: 11,
        idempotency_key: KEY,
      })
    ).toThrow(CancellationCutoffError)
  })

  it("1h przed terminem ⇒ fail-closed (anulacja odrzucona)", () => {
    expect(() =>
      determineCancellationOutcome({
        hours_before_appointment: 1,
        idempotency_key: KEY,
      })
    ).toThrow(CancellationCutoffError)
  })

  it("custom cutoff/threshold respektowane (np. cutoff=6, threshold=12)", () => {
    const ok = determineCancellationOutcome({
      hours_before_appointment: 8,
      cutoff_hours: 6,
      active_threshold_hours: 12,
      idempotency_key: KEY,
    })
    expect(ok.tier).toBe("value_preserved")
    expect(() =>
      determineCancellationOutcome({
        hours_before_appointment: 4,
        cutoff_hours: 6,
        active_threshold_hours: 12,
        idempotency_key: KEY,
      })
    ).toThrow(CancellationCutoffError)
  })

  it("hours_before nie-skończone ⇒ CancellationHoursInvalidError (fail-closed)", () => {
    expect(() =>
      determineCancellationOutcome({
        hours_before_appointment: Number.NaN,
        idempotency_key: KEY,
      })
    ).toThrow(CancellationHoursInvalidError)
  })
})

// ---------------------------------------------------------------------------
// No-show — wartość zachowana, brak cutoffu (termin minął)
// ---------------------------------------------------------------------------

describe("determineNoShowOutcome — wartość zachowana + rebook (AC2)", () => {
  it("no-show ⇒ tier=value_preserved, rebookable, brak derecognition, wartość zachowana", () => {
    const d = determineNoShowOutcome({ idempotency_key: KEY })
    expect(d.kind).toBe("no_show")
    expect(d.tier).toBe("value_preserved")
    expect(d.value_preserved).toBe(true)
    expect(d.rebookable).toBe(true)
    expect(d.derecognition).toBe(false)
    expect(d.remaining_changed).toBe(false)
    expect(d.expires_at_changed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// REBOOK — INWARIANT „NIE skraca expires_at" (UX-DR-14 M-5)
// ---------------------------------------------------------------------------

describe("rebook — expires_at niezmienione (UX-DR-14 M-5)", () => {
  it("computeRebookExpiresAt jest identity: expires_at_after == expires_at_before (regresja)", () => {
    const before = new Date("2027-05-16T12:00:00.000Z")
    const after = computeRebookExpiresAt(before)
    expect(after.getTime()).toBe(before.getTime())
  })

  it("computeRebookExpiresAt zwraca KOPIĘ (mutacja wyniku nie zmienia wejścia)", () => {
    const before = new Date("2027-05-16T12:00:00.000Z")
    const after = computeRebookExpiresAt(before)
    after.setFullYear(2030)
    expect(before.getUTCFullYear()).toBe(2027)
  })

  it("assertRebookPreservesExpiry: równość OK", () => {
    const d = new Date("2027-05-16T12:00:00.000Z")
    expect(() => assertRebookPreservesExpiry(d, new Date(d.getTime()))).not.toThrow()
  })

  it("assertRebookPreservesExpiry: wydłużenie OK (nie forfeiture)", () => {
    const before = new Date("2027-05-16T12:00:00.000Z")
    const after = new Date("2027-08-16T12:00:00.000Z")
    expect(() => assertRebookPreservesExpiry(before, after)).not.toThrow()
  })

  it("assertRebookPreservesExpiry: SKRÓCENIE ⇒ RebookExpiryShorteningError (defense-in-depth)", () => {
    const before = new Date("2027-05-16T12:00:00.000Z")
    const shorter = new Date("2027-05-15T12:00:00.000Z")
    expect(() => assertRebookPreservesExpiry(before, shorter)).toThrow(
      RebookExpiryShorteningError
    )
  })
})

// ---------------------------------------------------------------------------
// T3 — idempotencja (replay ⇒ no-op; idempotency_key wymagany fail-closed)
// ---------------------------------------------------------------------------

describe("idempotencja — replay ⇒ no-op, klucz wymagany (T3)", () => {
  it("cancellation bez idempotency_key ⇒ CancellationIdempotencyMissingError", () => {
    expect(() =>
      determineCancellationOutcome({ hours_before_appointment: 48 })
    ).toThrow(CancellationIdempotencyMissingError)
  })

  it("no-show bez idempotency_key ⇒ CancellationIdempotencyMissingError", () => {
    expect(() => determineNoShowOutcome({})).toThrow(
      CancellationIdempotencyMissingError
    )
  })

  it("replay (ten sam klucz co ostatnio zastosowany) ⇒ idempotent_replay:true", () => {
    const d = determineCancellationOutcome({
      hours_before_appointment: 48,
      idempotency_key: KEY,
      last_applied_idempotency_key: KEY,
    })
    expect(d.idempotent_replay).toBe(true)
  })

  it("replay POMIJA gate cutoffu (operacja już raz zaszła ⇒ no-op, NIE re-throw)", () => {
    // 11h byłoby po cutoff, ale replay już zastosowanej operacji NIE rzuca.
    const d = determineCancellationOutcome({
      hours_before_appointment: 11,
      idempotency_key: KEY,
      last_applied_idempotency_key: KEY,
    })
    expect(d.idempotent_replay).toBe(true)
    expect(d.value_preserved).toBe(true)
  })

  it("różne klucze ⇒ nie-replay (idempotent_replay:false)", () => {
    const d = determineCancellationOutcome({
      hours_before_appointment: 48,
      idempotency_key: KEY,
      last_applied_idempotency_key: buildCancellationIdempotencyKey(
        "ent_cancel_001",
        "seq-2"
      ),
    })
    expect(d.idempotent_replay).toBe(false)
  })

  it("klucze deterministyczne i rozróżnialne (cancellation vs rebook)", () => {
    expect(buildCancellationIdempotencyKey("e1", "s1")).toBe(
      "entitlement:e1:cancellation:s1"
    )
    expect(buildRebookIdempotencyKey("e1", "s1")).toBe("entitlement:e1:rebook:s1")
    expect(buildCancellationIdempotencyKey("e1", "s1")).not.toBe(
      buildRebookIdempotencyKey("e1", "s1")
    )
  })
})

// ---------------------------------------------------------------------------
// Copy — anti-forfeiture (egzekwowane mechanicznie, AC2 / Anti-patterns)
// ---------------------------------------------------------------------------

describe("copy — anti-forfeiture (NIGDY „przepadnie”)", () => {
  it("domyślne komunikaty anulacji przechodzą gate (oba progi)", () => {
    expect(() =>
      assertCancellationCopySafe(defaultCancellationMessage("full_active"))
    ).not.toThrow()
    expect(() =>
      assertCancellationCopySafe(defaultCancellationMessage("value_preserved"))
    ).not.toThrow()
  })

  it("domyślny komunikat rebooku przechodzi gate", () => {
    expect(() => assertCancellationCopySafe(defaultRebookMessage())).not.toThrow()
  })

  it("copy z „przepadnie” ⇒ ForfeitureCopyError (reuse gate 4.2)", () => {
    expect(() =>
      assertCancellationCopySafe("Twój voucher przepadnie po terminie.")
    ).toThrow(ForfeitureCopyError)
  })

  it("copy z „utrata” ⇒ ForfeitureCopyError", () => {
    expect(() =>
      assertCancellationCopySafe("Anulacja oznacza utratę wartości vouchera.")
    ).toThrow(ForfeitureCopyError)
  })
})

// ---------------------------------------------------------------------------
// Posting GATED — anulacja/no-show/rebook = NO posting (audit-only)
// ---------------------------------------------------------------------------

describe("posting no-op marker (ADR-139 D5)", () => {
  it("buildCancellationPostingNoop ⇒ noop:true + powód (liability bez zmiany)", () => {
    const noop = buildCancellationPostingNoop()
    expect(noop.noop).toBe(true)
    expect(noop.reason).toContain("BEZ ZMIANY")
    expect(noop.reason).toContain("BRAK postingu")
  })
})

// ---------------------------------------------------------------------------
// Okablowanie tranzycji — jednolity punkt (3.4), audit-only, from===to (D-5)
// ---------------------------------------------------------------------------

describe("buildCancellationTransitionInput — from===to (D-5) + brak posting", () => {
  it("cancellation: from===to (NIE zmienia stanu) + posting pominięty + actor_hint", () => {
    const input = buildCancellationTransitionInput({
      entitlement_id: "ent_cancel_001",
      state: EntitlementInstanceState.ACTIVE,
      scope: SCOPE,
      kind: "cancellation",
      tier: "full_active",
      cancellation_seq: "seq-1",
    })
    expect(input.from).toBe(EntitlementInstanceState.ACTIVE)
    expect(input.to).toBe(EntitlementInstanceState.ACTIVE)
    expect(input.posting).toBeUndefined()
    expect(input.actor_hint).toBe("cancellation:full_active")
    expect(input.transition_seq).toBe("seq-1")
  })

  it("cancellationActorHint koduje tryb (+ próg gdy podany)", () => {
    expect(cancellationActorHint("no_show")).toBe("no_show")
    expect(cancellationActorHint("cancellation", "value_preserved")).toBe(
      "cancellation:value_preserved"
    )
    expect(cancellationActorHint("rebook")).toBe("rebook")
  })
})

describe("buildCancellationWiring — audit envelope + posting audit-only (AC1/T3)", () => {
  it("produkuje audit (kto/co/kiedy/scope/wynik) + posting audit-only (NIE księguje)", async () => {
    const res = await buildCancellationWiring(
      {
        // brak ledgerWriter / postingActivation ⇒ domyślna bramka (runtime_enabled=false)
        clock: () => new Date("2026-06-02T12:00:00.000Z"),
      },
      {
        entitlement_id: "ent_cancel_001",
        state: EntitlementInstanceState.ACTIVE,
        scope: SCOPE,
        kind: "cancellation",
        tier: "full_active",
        cancellation_seq: "seq-1",
      }
    )
    expect(res.audit.actor).toBe("customer")
    expect(res.audit.actor_hint).toBe("cancellation:full_active")
    expect(res.audit.event_type).toBe(ENTITLEMENT_STATE_CHANGED_EVENT_TYPE)
    expect(res.audit.scope.market_id).toBe("mkt_bonbeauty")
    expect(res.audit.outcome).toBe("transitioned")
    expect(res.audit.occurred_at).toBe("2026-06-02T12:00:00.000Z")
    expect(res.audit.from_state).toBe(EntitlementInstanceState.ACTIVE)
    expect(res.audit.to_state).toBe(EntitlementInstanceState.ACTIVE)
    // KRYTYCZNE: brak payloadu postingu ⇒ audit-only (NIE pisze do voucher_ledger_*).
    expect(res.posting.attempted).toBe(false)
    expect(res.posting.activated).toBe(false)
    expect(res.posting.persisted).toBe(false)
  })

  it("no-show: actor_hint koduje tryb, NADAL audit-only", async () => {
    const res = await buildCancellationWiring(
      { clock: () => new Date("2026-06-02T12:00:00.000Z") },
      {
        entitlement_id: "ent_cancel_001",
        state: EntitlementInstanceState.ACTIVE,
        scope: SCOPE,
        kind: "no_show",
        cancellation_seq: "seq-ns",
      }
    )
    expect(res.audit.actor_hint).toBe("no_show")
    expect(res.posting.attempted).toBe(false)
    expect(res.posting.persisted).toBe(false)
  })

  it("appendAudit wołany gdy podany (audit faktycznie persystowany w tx callera)", async () => {
    const audits: TransitionAuditEnvelope[] = []
    await buildCancellationWiring(
      {
        appendAudit: async (a) => {
          audits.push(a)
        },
        clock: () => new Date("2026-06-02T12:00:00.000Z"),
      },
      {
        entitlement_id: "ent_cancel_001",
        state: EntitlementInstanceState.ACTIVE,
        scope: SCOPE,
        kind: "rebook",
        cancellation_seq: "seq-rb",
      }
    )
    expect(audits).toHaveLength(1)
    expect(audits[0]?.actor_hint).toBe("rebook")
  })

  it("emitEvent wołany gdy podany + emitFailed:false (posting nadal audit-only)", async () => {
    const events: TransitionEventEnvelope[] = []
    const res = await buildCancellationWiring(
      {
        emitEvent: async (e) => {
          events.push(e)
        },
        clock: () => new Date("2026-06-02T12:00:00.000Z"),
      },
      {
        entitlement_id: "ent_cancel_001",
        state: EntitlementInstanceState.ACTIVE,
        scope: SCOPE,
        kind: "cancellation",
        tier: "value_preserved",
        cancellation_seq: "seq-1",
      }
    )
    expect(events).toHaveLength(1)
    expect(res.emitFailed).toBe(false)
    expect(res.posting.attempted).toBe(false)
  })

  it("emitFailed:false gdy emitEvent niepodany", async () => {
    const res = await buildCancellationWiring(
      { clock: () => new Date("2026-06-02T12:00:00.000Z") },
      {
        entitlement_id: "ent_cancel_001",
        state: EntitlementInstanceState.ACTIVE,
        scope: SCOPE,
        kind: "cancellation",
        tier: "full_active",
        cancellation_seq: "seq-1",
      }
    )
    expect(res.emitFailed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// D-5 — taksonomia stanów NIEZMIENIONA (13 stanów)
// ---------------------------------------------------------------------------

describe("granice D-5 — taksonomia stanów niezmieniona", () => {
  it("ALL_ENTITLEMENT_INSTANCE_STATES nadal liczy 13 stanów (4.6 NIE dodaje stanu)", () => {
    expect(ALL_ENTITLEMENT_INSTANCE_STATES).toHaveLength(13)
  })
})
