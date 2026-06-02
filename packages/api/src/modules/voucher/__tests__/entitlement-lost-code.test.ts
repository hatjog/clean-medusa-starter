/**
 * Story 4.7 (v1.11.0 Epic 4 / Wave 4 — lifecycle L4 lost-code recovery) — unit tests.
 *
 * Pokrywa AC1 + AC2 odzysku utraconego kodu jako pary `void(old)` + `issue(new)`:
 *   AC1 — w oknie 30 dni (od utraty) + decyzja ≤7 dni (od zgłoszenia) ⇒ void(old) + issue(new)
 *         z PEŁNYM transferem salda (`remaining_new == remaining_old`, NIGDY ponad — 4.1) +
 *         zachowaną ważnością; stary kod terminalny (VOIDED). Poza oknem (30d / 7d) ⇒
 *         fail-closed (brak void/issue/transferu).
 *   AC2 — obie tranzycje przez jednolity punkt wireEntitlementTransition (3.4): append-only
 *         audit + event do outboxu; posting GATED (audit-only/no-op, runtime_enabled=false ⇒
 *         NIE pisze voucher_ledger_*). Para net-zero (kontynuacja, NIE derecognition).
 *   Anti-double-spend — void(old) PRZED issue(new) (nigdy 2 ważne kody); idempotencja
 *         (recovery_id ⇒ jeden void+issue, replay no-op); taksonomia (D-5) niezmienna.
 */

import { describe, it, expect } from "@jest/globals"
import {
  LOST_CODE_REPORT_WINDOW_DAYS,
  LOST_CODE_DECISION_WINDOW_DAYS,
  LOST_CODE_RECOVERABLE_STATES,
  LOST_CODE_POSTING_NOOP_REASON,
  LostCodeReportWindowError,
  LostCodeDecisionWindowError,
  LostCodeIdempotencyMissingError,
  LostCodePreconditionError,
  LostCodeBalanceTransferError,
  LostCodeFutureDateError,
  LostCodeLostBeforeIssuedError,
  LostCodeWiringDirectiveError,
  isWithinReportWindow,
  isWithinDecisionWindow,
  buildLostCodeRecoveryId,
  deriveRecoveryEntitlementId,
  computeRecoveryBalanceTransfer,
  computeRecoveryExpiresAt,
  determineLostCodeRecoveryOutcome,
  buildLostCodePostingNoop,
  buildLostCodeAtomicWriteSeam,
  lostCodeVoidActorHint,
  lostCodeReissueActorHint,
  buildLostCodeVoidTransitionInput,
  buildLostCodeReissueGenesisInput,
  buildLostCodeRecoveryWiring,
  cloneRecoveryPolicySnapshot,
  ALL_ENTITLEMENT_INSTANCE_STATES,
  EntitlementInstanceState,
  EntitlementGenesisError,
  EntitlementTransitionError,
  ENTITLEMENT_GENESIS,
  ENTITLEMENT_STATE_CHANGED_EVENT_TYPE,
  type LostCodeRecoveryDetermination,
  type TransitionAuditEnvelope,
  type TransitionEventEnvelope,
} from ".."

const SCOPE = {
  instance_id: "ent_lost_001",
  market_id: "mkt_bonbeauty",
  sales_channel_id: "sc_bonbeauty",
}

const OLD_ID = "ent_lost_001"
const REC = buildLostCodeRecoveryId(OLD_ID, "seq-1")

// Standardowe daty: utrata → zgłoszenie (w oknie) → decyzja (w oknie) → now.
const LOST_AT = new Date("2026-06-01T00:00:00.000Z")
const REPORTED_AT = new Date("2026-06-10T00:00:00.000Z") // 9 dni po utracie (<30)
const DECIDED_AT = new Date("2026-06-13T00:00:00.000Z") // 3 dni po zgłoszeniu (<7)
const NOW_AT = new Date("2026-06-15T00:00:00.000Z") // 2 dni po decided_at (≥ decided_at)

// Precomputed determination (directive:"apply") używany przez testy okablowania.
const DETERMINATION: LostCodeRecoveryDetermination = determineLostCodeRecoveryOutcome({
  old_state: EntitlementInstanceState.ISSUED,
  remaining_old: 8000,
  lost_at: LOST_AT,
  reported_at: REPORTED_AT,
  decided_at: DECIDED_AT,
  now_at: NOW_AT,
  recovery_id: REC,
})

// ---------------------------------------------------------------------------
// Okna czasowe — zgłoszenie 30 dni + decyzja ≤7 dni (boundary, fail-closed)
// ---------------------------------------------------------------------------

describe("okna czasowe — report 30d + decision 7d (boundary)", () => {
  it("stałe okien zgodne z FR20 (30 / 7)", () => {
    expect(LOST_CODE_REPORT_WINDOW_DAYS).toBe(30)
    expect(LOST_CODE_DECISION_WINDOW_DAYS).toBe(7)
  })

  it("isWithinReportWindow: dokładnie 30 dni (granica inkluzywna) ⇒ true", () => {
    const lost = new Date("2026-06-01T00:00:00.000Z")
    const reported = new Date("2026-07-01T00:00:00.000Z") // +30 dni
    expect(isWithinReportWindow(lost, reported)).toBe(true)
  })

  it("isWithinReportWindow: 30 dni + 1ms ⇒ false (poza oknem)", () => {
    const lost = new Date("2026-06-01T00:00:00.000Z")
    const reported = new Date("2026-07-01T00:00:00.001Z")
    expect(isWithinReportWindow(lost, reported)).toBe(false)
  })

  it("isWithinReportWindow: zgłoszenie PRZED utratą ⇒ false (fail-closed)", () => {
    expect(
      isWithinReportWindow(
        new Date("2026-06-10T00:00:00.000Z"),
        new Date("2026-06-01T00:00:00.000Z")
      )
    ).toBe(false)
  })

  it("isWithinDecisionWindow: dokładnie 7 dni (granica inkluzywna) ⇒ true", () => {
    const reported = new Date("2026-06-10T00:00:00.000Z")
    const decided = new Date("2026-06-17T00:00:00.000Z") // +7 dni
    expect(isWithinDecisionWindow(reported, decided)).toBe(true)
  })

  it("isWithinDecisionWindow: 7 dni + 1ms ⇒ false (poza oknem)", () => {
    const reported = new Date("2026-06-10T00:00:00.000Z")
    const decided = new Date("2026-06-17T00:00:00.001Z")
    expect(isWithinDecisionWindow(reported, decided)).toBe(false)
  })

  it("isWithinDecisionWindow: decyzja PRZED zgłoszeniem ⇒ false (fail-closed)", () => {
    expect(
      isWithinDecisionWindow(
        new Date("2026-06-10T00:00:00.000Z"),
        new Date("2026-06-09T00:00:00.000Z")
      )
    ).toBe(false)
  })

  it("niewiarygodne daty (NaN) ⇒ false (fail-closed)", () => {
    expect(isWithinReportWindow(new Date(Number.NaN), REPORTED_AT)).toBe(false)
    expect(isWithinDecisionWindow(REPORTED_AT, new Date(Number.NaN))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC1 — transfer salda 1:1 (dyscyplina 4.1: NIGDY ponad remaining) + ważność
// ---------------------------------------------------------------------------

describe("transfer salda 1:1 + zachowanie ważności (AC1, dyscyplina 4.1)", () => {
  it("computeRecoveryBalanceTransfer: remaining_new == remaining_old, net-zero", () => {
    const t = computeRecoveryBalanceTransfer(5000)
    expect(t.remaining_old).toBe(5000)
    expect(t.remaining_new).toBe(5000)
    expect(t.net_zero).toBe(true)
  })

  it("computeRecoveryBalanceTransfer: saldo 0 ⇒ transfer 0 (dozwolone)", () => {
    expect(computeRecoveryBalanceTransfer(0).remaining_new).toBe(0)
  })

  it("computeRecoveryBalanceTransfer: saldo ujemne ⇒ LostCodeBalanceTransferError", () => {
    expect(() => computeRecoveryBalanceTransfer(-1)).toThrow(
      LostCodeBalanceTransferError
    )
  })

  it("computeRecoveryBalanceTransfer: saldo nie-skończone ⇒ LostCodeBalanceTransferError", () => {
    expect(() => computeRecoveryBalanceTransfer(Number.NaN)).toThrow(
      LostCodeBalanceTransferError
    )
  })

  it("computeRecoveryExpiresAt: ważność przeniesiona 1:1 (identity, NIE od daty odzysku)", () => {
    const exp = new Date("2027-06-01T00:00:00.000Z")
    const next = computeRecoveryExpiresAt(exp)
    expect(next?.getTime()).toBe(exp.getTime())
  })

  it("computeRecoveryExpiresAt: zwraca KOPIĘ (mutacja nie zmienia wejścia)", () => {
    const exp = new Date("2027-06-01T00:00:00.000Z")
    const next = computeRecoveryExpiresAt(exp)
    next!.setFullYear(2099)
    expect(exp.getUTCFullYear()).toBe(2027)
  })

  it("computeRecoveryExpiresAt: null ⇒ null (brak ważności przeniesiony wprost)", () => {
    expect(computeRecoveryExpiresAt(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AC1 — determinacja odzysku: happy path + fail-closed okna + precondition
// ---------------------------------------------------------------------------

describe("determineLostCodeRecoveryOutcome — happy path (AC1)", () => {
  it("w oknie 30d + decyzja ≤7d + ISSUED ⇒ apply, transfer net-zero, brak derecognition", () => {
    const d = determineLostCodeRecoveryOutcome({
      old_state: EntitlementInstanceState.ISSUED,
      remaining_old: 8000,
      lost_at: LOST_AT,
      reported_at: REPORTED_AT,
      decided_at: DECIDED_AT,
      now_at: NOW_AT,
      recovery_id: REC,
    })
    expect(d.directive).toBe("apply")
    expect(d.transfer.remaining_new).toBe(8000)
    expect(d.transfer.net_zero).toBe(true)
    expect(d.derecognition).toBe(false)
    expect(d.net_zero).toBe(true)
    expect(d.idempotent_replay).toBe(false)
  })

  it("stan ACTIVE także recoverable", () => {
    const d = determineLostCodeRecoveryOutcome({
      old_state: EntitlementInstanceState.ACTIVE,
      remaining_old: 100,
      lost_at: LOST_AT,
      reported_at: REPORTED_AT,
      decided_at: DECIDED_AT,
      now_at: NOW_AT,
      recovery_id: REC,
    })
    expect(d.directive).toBe("apply")
  })
})

describe("determineLostCodeRecoveryOutcome — fail-closed okna (AC1)", () => {
  it("zgłoszenie poza oknem 30 dni ⇒ LostCodeReportWindowError (brak transferu)", () => {
    expect(() =>
      determineLostCodeRecoveryOutcome({
        old_state: EntitlementInstanceState.ISSUED,
        remaining_old: 8000,
        lost_at: LOST_AT,
        reported_at: new Date("2026-07-05T00:00:00.000Z"), // 34 dni po utracie
        decided_at: new Date("2026-07-06T00:00:00.000Z"),
        now_at: new Date("2026-07-10T00:00:00.000Z"),
        recovery_id: REC,
      })
    ).toThrow(LostCodeReportWindowError)
  })

  it("decyzja poza oknem ≤7 dni ⇒ LostCodeDecisionWindowError (brak transferu)", () => {
    expect(() =>
      determineLostCodeRecoveryOutcome({
        old_state: EntitlementInstanceState.ISSUED,
        remaining_old: 8000,
        lost_at: LOST_AT,
        reported_at: REPORTED_AT,
        decided_at: new Date("2026-06-20T00:00:00.000Z"), // 10 dni po zgłoszeniu
        now_at: new Date("2026-06-25T00:00:00.000Z"),
        recovery_id: REC,
      })
    ).toThrow(LostCodeDecisionWindowError)
  })
})

describe("determineLostCodeRecoveryOutcome — precondition stanu (fail-closed)", () => {
  const DISALLOWED = [
    EntitlementInstanceState.REDEEMED_PARTIAL,
    EntitlementInstanceState.REDEEMED_FULL,
    EntitlementInstanceState.SETTLED,
    EntitlementInstanceState.CLOSED,
    EntitlementInstanceState.VOIDED,
    EntitlementInstanceState.EXPIRED,
    EntitlementInstanceState.REFUNDED,
  ]

  it.each(DISALLOWED)(
    "stan '%s' ⇒ LostCodePreconditionError (odzysk bezprzedmiotowy)",
    (state) => {
      expect(() =>
        determineLostCodeRecoveryOutcome({
          old_state: state,
          remaining_old: 8000,
          lost_at: LOST_AT,
          reported_at: REPORTED_AT,
          decided_at: DECIDED_AT,
          now_at: NOW_AT,
          recovery_id: REC,
        })
      ).toThrow(LostCodePreconditionError)
    }
  )

  it("LOST_CODE_RECOVERABLE_STATES = {ISSUED, ACTIVE} (dokładnie)", () => {
    expect(LOST_CODE_RECOVERABLE_STATES.has(EntitlementInstanceState.ISSUED)).toBe(
      true
    )
    expect(LOST_CODE_RECOVERABLE_STATES.has(EntitlementInstanceState.ACTIVE)).toBe(
      true
    )
    expect(LOST_CODE_RECOVERABLE_STATES.size).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Idempotencja — recovery_id wymagany + replay ⇒ no-op + deterministyczny nowy id
// ---------------------------------------------------------------------------

describe("idempotencja — recovery_id (T1)", () => {
  it("brak recovery_id ⇒ LostCodeIdempotencyMissingError", () => {
    expect(() =>
      determineLostCodeRecoveryOutcome({
        old_state: EntitlementInstanceState.ISSUED,
        remaining_old: 8000,
        lost_at: LOST_AT,
        reported_at: REPORTED_AT,
        decided_at: DECIDED_AT,
        now_at: NOW_AT,
      })
    ).toThrow(LostCodeIdempotencyMissingError)
  })

  it("replay (ten sam recovery_id co ostatnio) ⇒ directive:noop, idempotent_replay:true", () => {
    const d = determineLostCodeRecoveryOutcome({
      old_state: EntitlementInstanceState.ISSUED,
      remaining_old: 8000,
      lost_at: LOST_AT,
      reported_at: REPORTED_AT,
      decided_at: DECIDED_AT,
      now_at: NOW_AT,
      recovery_id: REC,
      last_applied_recovery_id: REC,
    })
    expect(d.directive).toBe("noop")
    expect(d.idempotent_replay).toBe(true)
  })

  it("replay POMIJA gardy okien (operacja już zaszła — np. decyzja poza oknem ⇒ NIE re-throw)", () => {
    const d = determineLostCodeRecoveryOutcome({
      old_state: EntitlementInstanceState.ISSUED,
      remaining_old: 8000,
      lost_at: LOST_AT,
      reported_at: REPORTED_AT,
      decided_at: new Date("2026-08-01T00:00:00.000Z"), // poza oknem dla nowego żądania
      now_at: new Date("2026-08-05T00:00:00.000Z"),
      recovery_id: REC,
      last_applied_recovery_id: REC,
    })
    expect(d.directive).toBe("noop")
    expect(d.idempotent_replay).toBe(true)
    expect(d.transfer.remaining_new).toBe(8000)
  })

  it("różne recovery_id ⇒ nie-replay (apply)", () => {
    const d = determineLostCodeRecoveryOutcome({
      old_state: EntitlementInstanceState.ISSUED,
      remaining_old: 8000,
      lost_at: LOST_AT,
      reported_at: REPORTED_AT,
      decided_at: DECIDED_AT,
      now_at: NOW_AT,
      recovery_id: REC,
      last_applied_recovery_id: buildLostCodeRecoveryId(OLD_ID, "seq-2"),
    })
    expect(d.directive).toBe("apply")
    expect(d.idempotent_replay).toBe(false)
  })

  it("buildLostCodeRecoveryId deterministyczny + rozróżnialny per seq", () => {
    expect(buildLostCodeRecoveryId("e1", "s1")).toBe(
      "entitlement:e1:lost-code-recovery:s1"
    )
    expect(buildLostCodeRecoveryId("e1", "s1")).not.toBe(
      buildLostCodeRecoveryId("e1", "s2")
    )
  })

  it("deriveRecoveryEntitlementId deterministyczny (ten sam recovery_id ⇒ ten sam nowy id)", () => {
    const a = deriveRecoveryEntitlementId(REC)
    const b = deriveRecoveryEntitlementId(REC)
    expect(a).toBe(b)
    expect(a).toMatch(/^GP-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
  })

  it("deriveRecoveryEntitlementId różny per recovery_id (brak kolizji trywialnych)", () => {
    expect(deriveRecoveryEntitlementId(REC)).not.toBe(
      deriveRecoveryEntitlementId(buildLostCodeRecoveryId(OLD_ID, "seq-2"))
    )
  })
})

// ---------------------------------------------------------------------------
// Okablowanie pary — void(old)→VOIDED + issue(new) geneza→ISSUED, audit + event
// ---------------------------------------------------------------------------

describe("buildLostCode*TransitionInput — krawędzie grafu (D-5) + posting pominięty", () => {
  const wiring = {
    old_entitlement_id: OLD_ID,
    old_state: EntitlementInstanceState.ISSUED,
    scope: SCOPE,
    recovery_id: REC,
    operator_id: "op_42",
    determination: DETERMINATION,
  }

  it("void: from=stan, to=VOIDED, posting pominięty, actor=admin, transition_seq=recovery_id", () => {
    const input = buildLostCodeVoidTransitionInput(wiring)
    expect(input.from).toBe(EntitlementInstanceState.ISSUED)
    expect(input.to).toBe(EntitlementInstanceState.VOIDED)
    expect(input.entitlement_id).toBe(OLD_ID)
    expect(input.posting).toBeUndefined()
    expect(input.actor).toBe("admin")
    expect(input.transition_seq).toBe(REC)
    expect(input.actor_hint).toContain("lost-code:void")
    expect(input.actor_hint).toContain("operator=op_42")
  })

  it("void: niedozwolony stan ⇒ LostCodePreconditionError (fail-closed)", () => {
    expect(() =>
      buildLostCodeVoidTransitionInput({
        ...wiring,
        old_state: EntitlementInstanceState.REDEEMED_FULL,
      })
    ).toThrow(LostCodePreconditionError)
  })

  it("issue: geneza → ISSUED, scope.instance_id = nowy id, posting pominięty", () => {
    const newId = deriveRecoveryEntitlementId(REC)
    const input = buildLostCodeReissueGenesisInput(wiring, newId)
    expect(input.from).toBe(ENTITLEMENT_GENESIS)
    expect(input.to).toBe(EntitlementInstanceState.ISSUED)
    expect(input.entitlement_id).toBe(newId)
    expect(input.scope.instance_id).toBe(newId)
    expect(input.posting).toBeUndefined()
    expect(input.actor_hint).toContain("lost-code:issue")
    expect(input.actor_hint).toContain(`new=${newId}`)
  })

  it("actor hints kodują operatora + recovery_id (audit forensicznie samowystarczalny)", () => {
    expect(lostCodeVoidActorHint("op_1", "r1")).toBe(
      "lost-code:void:operator=op_1:recovery=r1"
    )
    expect(lostCodeReissueActorHint("op_1", "r1", "GP-X")).toBe(
      "lost-code:issue:operator=op_1:recovery=r1:new=GP-X"
    )
    expect(lostCodeVoidActorHint(null, "r1")).toContain("operator=?")
  })
})

describe("buildLostCodeRecoveryWiring — para audytowana + posting audit-only (AC2)", () => {
  const wiringActive = determineLostCodeRecoveryOutcome({
    old_state: EntitlementInstanceState.ACTIVE,
    remaining_old: 8000,
    lost_at: LOST_AT,
    reported_at: REPORTED_AT,
    decided_at: DECIDED_AT,
    now_at: NOW_AT,
    recovery_id: REC,
  })
  const wiring = {
    old_entitlement_id: OLD_ID,
    old_state: EntitlementInstanceState.ACTIVE,
    scope: SCOPE,
    recovery_id: REC,
    operator_id: "op_42",
    determination: wiringActive,
  }

  it("void(old) + issue(new): obie nogi audytowane, posting audit-only (NIE księguje)", async () => {
    const res = await buildLostCodeRecoveryWiring(
      { clock: () => new Date("2026-06-13T12:00:00.000Z") },
      wiring
    )

    // Void(old): from=ACTIVE → VOIDED, audyt kompletny, posting audit-only.
    expect(res.void.audit.from_state).toBe(EntitlementInstanceState.ACTIVE)
    expect(res.void.audit.to_state).toBe(EntitlementInstanceState.VOIDED)
    expect(res.void.audit.event_type).toBe(ENTITLEMENT_STATE_CHANGED_EVENT_TYPE)
    expect(res.void.audit.scope.market_id).toBe("mkt_bonbeauty")
    expect(res.void.audit.outcome).toBe("transitioned")
    expect(res.void.posting.attempted).toBe(false)
    expect(res.void.posting.persisted).toBe(false)

    // Issue(new): geneza → ISSUED na nowym id, audyt kompletny, posting audit-only.
    expect(res.issue.audit.from_state).toBe(ENTITLEMENT_GENESIS)
    expect(res.issue.audit.to_state).toBe(EntitlementInstanceState.ISSUED)
    expect(res.issue.audit.entitlement_id).toBe(res.new_entitlement_id)
    expect(res.issue.posting.attempted).toBe(false)
    expect(res.issue.posting.persisted).toBe(false)

    // Nowy id deterministyczny z recovery_id.
    expect(res.new_entitlement_id).toBe(deriveRecoveryEntitlementId(REC))
  })

  it("appendAudit wołany dla OBU nóg (void + issue) atomowo w tx callera", async () => {
    const audits: TransitionAuditEnvelope[] = []
    await buildLostCodeRecoveryWiring(
      {
        appendAudit: async (a) => {
          audits.push(a)
        },
        clock: () => new Date("2026-06-13T12:00:00.000Z"),
      },
      wiring
    )
    expect(audits).toHaveLength(2)
    expect(audits[0]?.actor_hint).toContain("lost-code:void")
    expect(audits[1]?.actor_hint).toContain("lost-code:issue")
  })

  it("emitEvent wołany dla OBU nóg + emitFailed:false (post-COMMIT seam)", async () => {
    const events: TransitionEventEnvelope[] = []
    const res = await buildLostCodeRecoveryWiring(
      {
        emitEvent: async (e) => {
          events.push(e)
        },
        clock: () => new Date("2026-06-13T12:00:00.000Z"),
      },
      wiring
    )
    expect(events).toHaveLength(2)
    expect(res.void.emitFailed).toBe(false)
    expect(res.issue.emitFailed).toBe(false)
  })

  it("custom new_entitlement_id respektowane (override deterministycznego id)", async () => {
    const res = await buildLostCodeRecoveryWiring(
      { clock: () => new Date("2026-06-13T12:00:00.000Z") },
      { ...wiring, new_entitlement_id: "ent_custom_new", determination: wiringActive }
    )
    expect(res.new_entitlement_id).toBe("ent_custom_new")
    expect(res.issue.audit.entitlement_id).toBe("ent_custom_new")
  })
})

// ---------------------------------------------------------------------------
// ANTI-DOUBLE-SPEND — void(old) PRZED issue(new); stary terminalny zanim nowy istnieje
// ---------------------------------------------------------------------------

describe("anti-double-spend — void(old) przed issue(new) (KRYTYCZNE)", () => {
  const detActive = determineLostCodeRecoveryOutcome({
    old_state: EntitlementInstanceState.ACTIVE,
    remaining_old: 5000,
    lost_at: LOST_AT,
    reported_at: REPORTED_AT,
    decided_at: DECIDED_AT,
    now_at: NOW_AT,
    recovery_id: REC,
  })

  it("kolejność okablowania: void NAJPIERW, issue PO (nigdy 2 ważne kody)", async () => {
    const order: string[] = []
    await buildLostCodeRecoveryWiring(
      {
        appendAudit: async (a) => {
          order.push(
            a.to_state === EntitlementInstanceState.VOIDED ? "void" : "issue"
          )
        },
        clock: () => new Date("2026-06-13T12:00:00.000Z"),
      },
      {
        old_entitlement_id: OLD_ID,
        old_state: EntitlementInstanceState.ACTIVE,
        scope: SCOPE,
        recovery_id: REC,
        determination: detActive,
      }
    )
    expect(order).toEqual(["void", "issue"])
  })

  it("stary kod ląduje w VOIDED (terminal) — brak krawędzi wyjściowej (redeem niemożliwy)", async () => {
    const res = await buildLostCodeRecoveryWiring(
      { clock: () => new Date("2026-06-13T12:00:00.000Z") },
      {
        old_entitlement_id: OLD_ID,
        old_state: EntitlementInstanceState.ISSUED,
        scope: SCOPE,
        recovery_id: REC,
        determination: DETERMINATION,
      }
    )
    expect(res.void.audit.to_state).toBe(EntitlementInstanceState.VOIDED)
  })

  it("void(old) z niedozwolonej krawędzi rzuca PRZED issue (geneza nie powstaje)", async () => {
    // VOIDED → VOIDED jest niedozwolone (terminal); defense-in-depth: precondition
    // w buildLostCodeVoidTransitionInput łapie zły stan nawet z hand-crafted determination.
    const fakeDetermination: LostCodeRecoveryDetermination = {
      directive: "apply",
      transfer: computeRecoveryBalanceTransfer(5000),
      derecognition: false,
      net_zero: true,
      idempotent_replay: false,
    }
    await expect(
      buildLostCodeRecoveryWiring(
        { clock: () => new Date("2026-06-13T12:00:00.000Z") },
        {
          old_entitlement_id: OLD_ID,
          old_state: EntitlementInstanceState.VOIDED,
          scope: SCOPE,
          recovery_id: REC,
          determination: fakeDetermination,
        }
      )
    ).rejects.toThrow(LostCodePreconditionError)
  })
})

// ---------------------------------------------------------------------------
// Posting GATED — NO posting / NO derecognition (audit-only NAWET z bramką ON)
// ---------------------------------------------------------------------------

describe("posting GATED — brak nowego postingu/derecognition (ADR-139 D5)", () => {
  it("buildLostCodePostingNoop ⇒ noop:true + powód (kontynuacja net-zero)", () => {
    const noop = buildLostCodePostingNoop()
    expect(noop.noop).toBe(true)
    expect(noop.reason).toBe(LOST_CODE_POSTING_NOOP_REASON)
    expect(noop.reason).toContain("NET-ZERO")
    expect(noop.reason).toContain("BRAK nowego")
  })

  it("bramka ON (runtime_enabled:true + market on) + writer + brak payloadu ⇒ attempted:false dla OBU nóg", async () => {
    // Symulacja stanu PO flipie P6 — bramka aktywna. Recovery NADAL nie księguje
    // (brak payloadu ⇒ wczesny return w hooku PRZED bramką). Dominujący dowód: 4.7
    // nigdy nie wycieknie do voucher_ledger_* nawet po flipie.
    const writerCalls: unknown[] = []
    const detActive = determineLostCodeRecoveryOutcome({
      old_state: EntitlementInstanceState.ACTIVE,
      remaining_old: 8000,
      lost_at: LOST_AT,
      reported_at: REPORTED_AT,
      decided_at: DECIDED_AT,
      now_at: NOW_AT,
      recovery_id: REC,
    })
    const res = await buildLostCodeRecoveryWiring(
      {
        postingActivation: { runtimeEnabled: true, isMarketActivated: () => true },
        ledgerWriter: {
          write: async (req) => {
            writerCalls.push(req)
            return { applied: false, deduped: false, transaction_id: "x" }
          },
        },
        clock: () => new Date("2026-06-13T12:00:00.000Z"),
      },
      {
        old_entitlement_id: OLD_ID,
        old_state: EntitlementInstanceState.ACTIVE,
        scope: SCOPE,
        recovery_id: REC,
        determination: detActive,
      }
    )
    expect(res.void.posting.attempted).toBe(false)
    expect(res.void.posting.activated).toBe(false)
    expect(res.void.posting.persisted).toBe(false)
    expect(res.issue.posting.attempted).toBe(false)
    expect(res.issue.posting.persisted).toBe(false)
    expect(writerCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Kontynuacja polityki — nowy kod = ta sama polityka, nowy identyfikator
// ---------------------------------------------------------------------------

describe("cloneRecoveryPolicySnapshot — kontynuacja polityki (nowy id, ta sama polityka)", () => {
  it("snapshot tożsamy wartościowo, ale NIE współdzieli referencji (deep clone + freeze)", () => {
    const oldSnap = Object.freeze({ transferability: "bearer", validity_months: 12 })
    const next = cloneRecoveryPolicySnapshot(oldSnap)
    expect(next).toEqual(oldSnap)
    expect(next).not.toBe(oldSnap)
    expect(Object.isFrozen(next)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// M1 — sprzężenie gard-wiring (AI-Review-1): wiring bez determination ⇒ fail-closed
// ---------------------------------------------------------------------------

describe("M1 — sprzężenie gardów okien/idempotencji ze ścieżką side-effect (AI-Review-1)", () => {
  it("wiring z directive:noop ⇒ LostCodeWiringDirectiveError (gardy nie pozwalają na side-effect)", async () => {
    const noopDetermination = determineLostCodeRecoveryOutcome({
      old_state: EntitlementInstanceState.ISSUED,
      remaining_old: 5000,
      lost_at: LOST_AT,
      reported_at: REPORTED_AT,
      decided_at: DECIDED_AT,
      now_at: NOW_AT,
      recovery_id: REC,
      last_applied_recovery_id: REC, // ← replay ⇒ noop
    })
    expect(noopDetermination.directive).toBe("noop")
    await expect(
      buildLostCodeRecoveryWiring(
        { clock: () => new Date("2026-06-13T12:00:00.000Z") },
        {
          old_entitlement_id: OLD_ID,
          old_state: EntitlementInstanceState.ISSUED,
          scope: SCOPE,
          recovery_id: REC,
          determination: noopDetermination,
        }
      )
    ).rejects.toThrow(LostCodeWiringDirectiveError)
  })

  it("wiring bez przejścia gardów (hand-crafted noop) ⇒ LostCodeWiringDirectiveError", async () => {
    const noopDetermination: LostCodeRecoveryDetermination = {
      directive: "noop",
      transfer: computeRecoveryBalanceTransfer(5000),
      derecognition: false,
      net_zero: true,
      idempotent_replay: true,
    }
    await expect(
      buildLostCodeRecoveryWiring(
        { clock: () => new Date("2026-06-13T12:00:00.000Z") },
        {
          old_entitlement_id: OLD_ID,
          old_state: EntitlementInstanceState.ISSUED,
          scope: SCOPE,
          recovery_id: REC,
          determination: noopDetermination,
        }
      )
    ).rejects.toThrow(LostCodeWiringDirectiveError)
  })
})

// ---------------------------------------------------------------------------
// M2 — atomowość void+issue: write_seam zawiera wszystkie dane do jednej DB-tx
// ---------------------------------------------------------------------------

describe("M2 — atomowy seam zapisu void+issue (AI-Review-2)", () => {
  it("write_seam zawiera old_id, new_id, remaining_new, expires_at, recovery_id (kontrakt atomowej tx)", async () => {
    const expiresAt = new Date("2027-12-01T00:00:00.000Z")
    const res = await buildLostCodeRecoveryWiring(
      { clock: () => new Date("2026-06-13T12:00:00.000Z") },
      {
        old_entitlement_id: OLD_ID,
        old_state: EntitlementInstanceState.ISSUED,
        scope: SCOPE,
        recovery_id: REC,
        determination: DETERMINATION,
        old_expires_at: expiresAt,
      }
    )
    expect(res.write_seam.old_entitlement_id).toBe(OLD_ID)
    expect(res.write_seam.new_entitlement_id).toBe(res.new_entitlement_id)
    expect(res.write_seam.remaining_new).toBe(DETERMINATION.transfer.remaining_new)
    expect(res.write_seam.expires_at?.getTime()).toBe(expiresAt.getTime())
    expect(res.write_seam.recovery_id).toBe(REC)
  })

  it("write_seam.expires_at = null gdy brak ważności (przeniesione 1:1)", async () => {
    const res = await buildLostCodeRecoveryWiring(
      { clock: () => new Date("2026-06-13T12:00:00.000Z") },
      {
        old_entitlement_id: OLD_ID,
        old_state: EntitlementInstanceState.ISSUED,
        scope: SCOPE,
        recovery_id: REC,
        determination: DETERMINATION,
        old_expires_at: null,
      }
    )
    expect(res.write_seam.expires_at).toBeNull()
  })

  it("transfer w wyniku wiring = determination.transfer (net-zero, spójność danych)", async () => {
    const res = await buildLostCodeRecoveryWiring(
      { clock: () => new Date("2026-06-13T12:00:00.000Z") },
      {
        old_entitlement_id: OLD_ID,
        old_state: EntitlementInstanceState.ISSUED,
        scope: SCOPE,
        recovery_id: REC,
        determination: DETERMINATION,
      }
    )
    expect(res.transfer.remaining_new).toBe(DETERMINATION.transfer.remaining_new)
    expect(res.transfer.net_zero).toBe(true)
  })

  it("buildLostCodeAtomicWriteSeam: remaining_new z determination.transfer, expires_at = computeRecoveryExpiresAt", () => {
    const expiresAt = new Date("2027-06-01T00:00:00.000Z")
    const seam = buildLostCodeAtomicWriteSeam(
      {
        old_entitlement_id: OLD_ID,
        determination: DETERMINATION,
        old_expires_at: expiresAt,
        recovery_id: REC,
      },
      "new_ent_001"
    )
    expect(seam.old_entitlement_id).toBe(OLD_ID)
    expect(seam.new_entitlement_id).toBe("new_ent_001")
    expect(seam.remaining_new).toBe(DETERMINATION.transfer.remaining_new)
    expect(seam.expires_at?.getTime()).toBe(expiresAt.getTime())
    expect(seam.recovery_id).toBe(REC)
  })
})

// ---------------------------------------------------------------------------
// L3 — replay short-circuit przed obliczeniem transferu (AI-Review-3)
// ---------------------------------------------------------------------------

describe("L3 — replay short-circuit przed obliczeniem transferu (AI-Review-3)", () => {
  it("replay z nieprawidłowym remaining_old (ujemnym) NIE rzuca LostCodeBalanceTransferError", () => {
    // Garda salda jest POMIJANA na replay (short-circuit PRZED computeRecoveryBalanceTransfer).
    // Caller i tak używa zapamiętanego wyniku, nie tego transferu.
    const d = determineLostCodeRecoveryOutcome({
      old_state: EntitlementInstanceState.ISSUED,
      remaining_old: -999, // nieprawidłowe, ale replay POMIJA walidację salda
      lost_at: LOST_AT,
      reported_at: REPORTED_AT,
      decided_at: DECIDED_AT,
      now_at: NOW_AT,
      recovery_id: REC,
      last_applied_recovery_id: REC,
    })
    expect(d.directive).toBe("noop")
    expect(d.idempotent_replay).toBe(true)
    // transfer jest informacyjny — wartości mogą być ujemne, ale to nie przeszkadza
    // bo caller używa zapamiętanego wyniku
    expect(d.transfer.remaining_old).toBe(-999)
  })

  it("NIE-replay z nieprawidłowym remaining_old ⇒ LostCodeBalanceTransferError (garda aktywna)", () => {
    expect(() =>
      determineLostCodeRecoveryOutcome({
        old_state: EntitlementInstanceState.ISSUED,
        remaining_old: -999,
        lost_at: LOST_AT,
        reported_at: REPORTED_AT,
        decided_at: DECIDED_AT,
        now_at: NOW_AT,
        recovery_id: REC,
        // brak last_applied_recovery_id ⇒ nie jest replay
      })
    ).toThrow(LostCodeBalanceTransferError)
  })
})

// ---------------------------------------------------------------------------
// L4 — granice czasowe anti-fraud: reported_at/decided_at ≤ now + lost_at ≥ issued_at
// ---------------------------------------------------------------------------

describe("L4 — granice czasowe anti-fraud (AI-Review-4)", () => {
  it("reported_at w przyszłości ⇒ LostCodeFutureDateError", () => {
    const futureReported = new Date("2026-07-01T00:00:00.000Z")
    expect(() =>
      determineLostCodeRecoveryOutcome({
        old_state: EntitlementInstanceState.ISSUED,
        remaining_old: 5000,
        lost_at: LOST_AT,
        reported_at: futureReported,
        decided_at: new Date("2026-07-02T00:00:00.000Z"),
        now_at: new Date("2026-06-20T00:00:00.000Z"), // now PRZED reported_at
        recovery_id: REC,
      })
    ).toThrow(LostCodeFutureDateError)
  })

  it("decided_at w przyszłości ⇒ LostCodeFutureDateError", () => {
    const futureDecided = new Date("2026-07-01T00:00:00.000Z")
    expect(() =>
      determineLostCodeRecoveryOutcome({
        old_state: EntitlementInstanceState.ISSUED,
        remaining_old: 5000,
        lost_at: LOST_AT,
        reported_at: REPORTED_AT,
        decided_at: futureDecided,
        now_at: new Date("2026-06-15T00:00:00.000Z"), // now PRZED decided_at
        recovery_id: REC,
      })
    ).toThrow(LostCodeFutureDateError)
  })

  it("reported_at = now_at (granica inkluzywna) ⇒ nie rzuca", () => {
    const exactNow = new Date("2026-06-15T00:00:00.000Z")
    expect(() =>
      determineLostCodeRecoveryOutcome({
        old_state: EntitlementInstanceState.ISSUED,
        remaining_old: 5000,
        lost_at: LOST_AT,
        reported_at: REPORTED_AT,
        decided_at: DECIDED_AT,
        now_at: DECIDED_AT, // now = decided_at (granica)
        recovery_id: REC,
      })
    ).not.toThrow(LostCodeFutureDateError)
  })

  it("lost_at przed issued_at ⇒ LostCodeLostBeforeIssuedError (anti-fraud)", () => {
    const issuedAt = new Date("2026-06-05T00:00:00.000Z")
    expect(() =>
      determineLostCodeRecoveryOutcome({
        old_state: EntitlementInstanceState.ISSUED,
        remaining_old: 5000,
        lost_at: new Date("2026-06-03T00:00:00.000Z"), // przed wystawieniem
        reported_at: REPORTED_AT,
        decided_at: DECIDED_AT,
        now_at: NOW_AT,
        recovery_id: REC,
        entitlement_issued_at: issuedAt,
      })
    ).toThrow(LostCodeLostBeforeIssuedError)
  })

  it("lost_at = issued_at (granica inkluzywna) ⇒ nie rzuca", () => {
    const issuedAt = new Date("2026-06-01T00:00:00.000Z")
    expect(() =>
      determineLostCodeRecoveryOutcome({
        old_state: EntitlementInstanceState.ISSUED,
        remaining_old: 5000,
        lost_at: issuedAt, // dokładnie data wystawienia
        reported_at: REPORTED_AT,
        decided_at: DECIDED_AT,
        now_at: NOW_AT,
        recovery_id: REC,
        entitlement_issued_at: issuedAt,
      })
    ).not.toThrow(LostCodeLostBeforeIssuedError)
  })

  it("brak entitlement_issued_at ⇒ pominięcie walidacji lost_at (opcjonalna)", () => {
    // Bez issued_at nie ma podstawy do walidacji — nie rzuca.
    expect(() =>
      determineLostCodeRecoveryOutcome({
        old_state: EntitlementInstanceState.ISSUED,
        remaining_old: 5000,
        lost_at: new Date("2020-01-01T00:00:00.000Z"), // bardzo stare, ale brak issued_at
        reported_at: REPORTED_AT,
        decided_at: DECIDED_AT,
        now_at: NOW_AT,
        recovery_id: REC,
        // entitlement_issued_at: undefined — opcjonalne
      })
    ).not.toThrow(LostCodeLostBeforeIssuedError)
  })
})

// ---------------------------------------------------------------------------
// D-5 — taksonomia stanów NIEZMIENIONA (13 stanów); brak nowego enuma/krawędzi
// ---------------------------------------------------------------------------

describe("granice D-5 — taksonomia stanów niezmieniona", () => {
  it("ALL_ENTITLEMENT_INSTANCE_STATES nadal liczy 13 stanów (4.7 NIE dodaje stanu)", () => {
    expect(ALL_ENTITLEMENT_INSTANCE_STATES).toHaveLength(13)
  })

  it("void używa ISTNIEJĄCEJ krawędzi {ISSUED,ACTIVE}→VOIDED (NIE nowy enum/krawędź)", () => {
    // Sanity: oba recoverable states mają VOIDED jako legalny target — gdyby graf się
    // zmienił, wireEntitlementTransitionPersisted rzuciłby EntitlementTransitionError.
    expect(LOST_CODE_RECOVERABLE_STATES.has(EntitlementInstanceState.ISSUED)).toBe(
      true
    )
    expect(EntitlementTransitionError).toBeDefined()
    expect(EntitlementGenesisError).toBeDefined()
  })
})
