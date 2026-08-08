/**
 * v1.15.0 Story 5.9 (FR-12, AD-17, SM-7) — unieważnienie stanu kodu vouchera.
 *
 * Te testy mierzą REGUŁĘ i OKABLOWANIE. Atomowość na realnym Postgresie 17
 * (zwrot → commit, wstrzyknięta porażka → ROLLBACK, kontrola przeciwna
 * rozdzielająca zapisy na dwie transakcje) leży w
 * `_bmad-output/releases/v1.15.0/implementation-artifacts/evidence/5-9/atomicity.out`
 * — bo transakcyjności nie da się udowodnić bez transakcji, a test z własnym
 * DDL świecił już zielono przy błędnym typie kolumny (ADR-166).
 */

import { describe, it, expect } from "@jest/globals"

import {
  EntitlementInstanceState,
  EntitlementType,
} from "../models/entitlement"
import type { VoucherStatus } from "../models/types"
import {
  CODE_INVALIDATION_SOURCE_STATES_BY_TARGET,
  codeInvalidationSourceStates,
  INVALIDATED_VOUCHER_STATUSES,
  SUPERSEDING_VOUCHER_STATUS,
  VOUCHER_BACKED_ENTITLEMENT_TYPES,
  INVALIDATING_ENTITLEMENT_STATES,
  INVALIDATING_ENTITLEMENT_STATE_TO_VOUCHER_STATUS,
  NotAnInvalidatingStateError,
  VoucherCodeBridgeMissingError,
  VoucherCodeNotInvalidatableError,
  decideVoucherCodeInvalidation,
  isInvalidatingEntitlementState,
} from "../voucher-code-state"
import {
  MissingVoucherCodeInvalidatorError,
  wireEntitlementTransitionPersisted,
} from "../entitlement-transition-wiring"
import { resolveRedeemRefusalReason } from "../service"

const BASE = {
  entitlement_id: "ent_1",
  entitlement_type: "VOUCHER_AMOUNT",
  voucher_code: "GP-TEST-0001",
}

describe("Story 5.9 — mapa unieważnień pochodzi z kontraktu", () => {
  it("wiąże każde przejście unieważniające ze stanem kodu", () => {
    expect(INVALIDATING_ENTITLEMENT_STATE_TO_VOUCHER_STATUS).toEqual({
      [EntitlementInstanceState.REFUNDED]: "refunded",
      [EntitlementInstanceState.EXPIRED]: "expired",
      [EntitlementInstanceState.VOIDED]: "withdrawn",
    })
  })

  it("zbiór stanów jest DERYWOWANY z mapy, nie wypisany drugi raz", () => {
    expect([...INVALIDATING_ENTITLEMENT_STATES].sort()).toEqual(
      Object.keys(INVALIDATING_ENTITLEMENT_STATE_TO_VOUCHER_STATUS).sort()
    )
    expect(isInvalidatingEntitlementState(EntitlementInstanceState.REFUNDED)).toBe(true)
    expect(isInvalidatingEntitlementState(EntitlementInstanceState.ACTIVE)).toBe(false)
  })

  it("stan spoza mapy jest odmową, nie domysłem", () => {
    expect(() =>
      decideVoucherCodeInvalidation({
        ...BASE,
        current_status: "idle",
        to_state: EntitlementInstanceState.ACTIVE,
      })
    ).toThrow(NotAnInvalidatingStateError)
  })
})

describe("Story 5.9 — reguła unieważnienia (allow-lista, idempotencja, fail-closed)", () => {
  it("przejście z allow-listy unieważnia kod zgodnie z mapowaniem", () => {
    for (const [state, expected] of [
      [EntitlementInstanceState.REFUNDED, "refunded"],
      [EntitlementInstanceState.EXPIRED, "expired"],
      [EntitlementInstanceState.VOIDED, "withdrawn"],
    ] as const) {
      const d = decideVoucherCodeInvalidation({
        ...BASE,
        current_status: "idle",
        to_state: state,
      })
      expect(d.outcome).toBe("invalidated")
      expect(d.target_status).toBe(expected)
    }
  })

  it("`claimed` JEST źródłem dla ZWROTU — zwrot po realizacji unieważnia kod", () => {
    expect(codeInvalidationSourceStates("refunded").has("claimed")).toBe(true)
    const d = decideVoucherCodeInvalidation({
      ...BASE,
      current_status: "claimed",
      to_state: EntitlementInstanceState.REFUNDED,
    })
    expect(d.outcome).toBe("invalidated")
  })

  // ── review-fix cyklu 2 (C2-MEDIUM-4) ─────────────────────────────────────
  // Allow-lista stanów źródłowych ZALEŻY OD CELU. Jeden zbiór dla wszystkich
  // celów pozwalał sweeperowi przestawić kod ZREALIZOWANY na `expired`, przez
  // co panel zwracał „wygasł"/410 zamiast „już zrealizowany"/409.
  it("`claimed` NIE jest źródłem dla `expired`/`withdrawn` — kod zrealizowany nie wygasa", () => {
    expect(codeInvalidationSourceStates("expired").has("claimed")).toBe(false)
    expect(codeInvalidationSourceStates("withdrawn").has("claimed")).toBe(false)

    for (const state of [
      EntitlementInstanceState.EXPIRED,
      EntitlementInstanceState.VOIDED,
    ] as const) {
      const d = decideVoucherCodeInvalidation({
        ...BASE,
        current_status: "claimed",
        to_state: state,
      })
      // NAZWANY wynik, nie rzut: rzut przewracałby transakcję sweepera
      // i uprawnienie w ogóle by nie wygasło.
      expect(d.outcome).toBe("already_redeemed_code")
      expect(d.prior_status).toBe("claimed")
    }
  })

  it("rekord stanów źródłowych jest WYCZERPUJĄCY po `VoucherStatus`", () => {
    // Dopisanie stanu kodu bez decyzji, z czego wolno w niego wejść, ma być
    // błędem kompilacji — a tu dodatkowo błędem asercji, gdyby ktoś rekord
    // rozluźnił.
    expect(Object.keys(CODE_INVALIDATION_SOURCE_STATES_BY_TARGET).sort()).toEqual([
      "claimed",
      "consent_pending",
      "expired",
      "idle",
      "refunded",
      "withdrawn",
    ])
  })

  it("powtórzenie jest no-opem z NAZWANYM wynikiem, nie błędem", () => {
    const d = decideVoucherCodeInvalidation({
      ...BASE,
      current_status: "refunded",
      to_state: EntitlementInstanceState.REFUNDED,
    })
    expect(d.outcome).toBe("already_invalidated")
    expect(d.prior_status).toBe("refunded")
  })

  it("stan spoza allow-listy i spoza zbioru unieważnionych jest fail-closed", () => {
    // review-fix 5.9: ten test BADAŁ `withdrawn → refunded`, czyli świecił
    // zielono na zachowaniu, które wywracało zwrot (patrz opis precedencji).
    // Guard allow-listy zostaje — od czego jest, widać dopiero na stanie
    // DOPISANYM do CHECK-a bazy bez dopisania go do którejkolwiek z list.
    expect(() =>
      decideVoucherCodeInvalidation({
        ...BASE,
        current_status: "reserved_by_drift" as VoucherStatus,
        to_state: EntitlementInstanceState.REFUNDED,
      })
    ).toThrow(VoucherCodeNotInvalidatableError)
  })

  describe("precedencja stanów unieważnionych (review-fix 5.9)", () => {
    it("`refunded` NADPISUJE `expired` — zwrot wygasłego uprawnienia przechodzi", () => {
      // Ścieżka legalna w grafie: EXPIRED → REFUND_REQUESTED → REFUNDED.
      // Przed fixem producent rzucał, a leżąc w transakcji wołającego
      // przewracał CAŁY zwrot.
      const d = decideVoucherCodeInvalidation({
        ...BASE,
        current_status: "expired",
        to_state: EntitlementInstanceState.REFUNDED,
      })
      expect(d.outcome).toBe("invalidated")
      expect(d.prior_status).toBe("expired")
      expect(d.target_status).toBe("refunded")
    })

    it("`refunded` NADPISUJE `withdrawn` z tego samego powodu", () => {
      const d = decideVoucherCodeInvalidation({
        ...BASE,
        current_status: "withdrawn",
        to_state: EntitlementInstanceState.REFUNDED,
      })
      expect(d.outcome).toBe("invalidated")
      expect(d.target_status).toBe("refunded")
    })

    it("reguła NIE działa w drugą stronę: `expired` nie nadpisuje `refunded`", () => {
      const d = decideVoucherCodeInvalidation({
        ...BASE,
        current_status: "refunded",
        to_state: EntitlementInstanceState.EXPIRED,
      })
      expect(d.outcome).toBe("already_invalidated_other")
      expect(d.prior_status).toBe("refunded")
      // Kod pozostaje nierealizowalny — SM-7 nie jest zagrożony.
      expect(d.target_status).toBe("expired")
    })

    it("`withdrawn` przy kodzie `expired` też jest nazwanym no-opem, nie błędem", () => {
      const d = decideVoucherCodeInvalidation({
        ...BASE,
        current_status: "expired",
        to_state: EntitlementInstanceState.VOIDED,
      })
      expect(d.outcome).toBe("already_invalidated_other")
    })

    it("nadpisujący stan jest LUSTREM kontraktu, nie stałą wpisaną w regule", () => {
      expect(SUPERSEDING_VOUCHER_STATUS).toBe("refunded")
      expect(
        [...INVALIDATED_VOUCHER_STATUSES].sort()
      ).toEqual(["expired", "refunded", "withdrawn"])
      expect(INVALIDATED_VOUCHER_STATUSES.has(SUPERSEDING_VOUCHER_STATUS)).toBe(true)
    })
  })

  it("typ voucherowy jest derywowany z taksonomii, nie z listy literałów", () => {
    // review-fix 5.9: dopisanie wariantu do `EntitlementType` bez decyzji
    // „czy niesie kod" ma nie kompilować się, a nie cicho dawać `no_voucher_code`.
    expect([...VOUCHER_BACKED_ENTITLEMENT_TYPES].sort()).toEqual([
      EntitlementType.VOUCHER_AMOUNT,
      EntitlementType.VOUCHER_SERVICE,
    ])
  })

  it("brak mostu przy uprawnieniu VOUCHEROWYM = fail-closed, NIE cichy no-op", () => {
    expect(() =>
      decideVoucherCodeInvalidation({
        ...BASE,
        voucher_code: null,
        current_status: null,
        to_state: EntitlementInstanceState.REFUNDED,
      })
    ).toThrow(VoucherCodeBridgeMissingError)
  })

  it("kod wskazany przez most, którego nie ma w tabeli = fail-closed", () => {
    expect(() =>
      decideVoucherCodeInvalidation({
        ...BASE,
        current_status: null,
        to_state: EntitlementInstanceState.REFUNDED,
      })
    ).toThrow(VoucherCodeBridgeMissingError)
  })

  it("uprawnienie NIEwspierane kodem daje wynik nazwany, a nie wyjątek", () => {
    const d = decideVoucherCodeInvalidation({
      ...BASE,
      entitlement_type: "CREDIT_PACK",
      voucher_code: null,
      current_status: null,
      to_state: EntitlementInstanceState.VOIDED,
    })
    expect(d.outcome).toBe("no_voucher_code")
    expect(d.target_status).toBe("withdrawn")
  })
})

describe("Story 5.9 — okablowanie tranzycji jest FAIL-CLOSED bez producenta", () => {
  // Krawędź LEGALNA w grafie L4 — guard grafu jest sprawdzany PRZED guardem
  // unieważnienia, więc nielegalna krawędź mierzyłaby nie ten mechanizm.
  const input = {
    from: EntitlementInstanceState.REFUND_REQUESTED,
    to: EntitlementInstanceState.REFUNDED,
    entitlement_id: "ent_1",
    scope: { instance_id: "ent_1", market_id: "bonbeauty" },
    actor: "customer" as const,
    actor_hint: "test",
    occurred_at: "2026-08-08T00:00:00.000Z",
    transition_seq: "seq-1",
  }

  it("tranzycja unieważniająca BEZ `invalidateVoucherCode` rzuca przed efektami", async () => {
    const audits: unknown[] = []
    await expect(
      wireEntitlementTransitionPersisted(
        { appendAudit: async (a) => void audits.push(a) },
        input
      )
    ).rejects.toBeInstanceOf(MissingVoucherCodeInvalidatorError)
    // "przed efektami" mierzone SKUTKIEM: audyt nie powstał.
    expect(audits).toHaveLength(0)
  })

  it("tranzycja unieważniająca Z producentem woła go i zwraca jego wynik", async () => {
    const calls: Array<{ entitlement_id: string; to_state: string }> = []
    const wired = await wireEntitlementTransitionPersisted(
      {
        appendAudit: async () => {},
        invalidateVoucherCode: async (i) => {
          calls.push({ entitlement_id: i.entitlement_id, to_state: i.to_state })
          return {
            outcome: "invalidated" as const,
            entitlement_id: i.entitlement_id,
            voucher_code: "GP-TEST-0001",
            prior_status: "idle" as const,
            target_status: "refunded" as const,
          }
        },
      },
      input
    )
    expect(calls).toEqual([{ entitlement_id: "ent_1", to_state: "REFUNDED" }])
    expect(wired.invalidation?.outcome).toBe("invalidated")
  })

  it("tranzycja NIEunieważniająca nie wymaga producenta i nie woła go", async () => {
    const wired = await wireEntitlementTransitionPersisted(
      { appendAudit: async () => {} },
      {
        ...input,
        from: EntitlementInstanceState.ACTIVE,
        to: EntitlementInstanceState.REDEMPTION_REQUESTED,
      }
    )
    expect(wired.invalidation).toBeNull()
  })
})

describe("Story 5.9 — powód odmowy „zwrócony” (AC4)", () => {
  const now = new Date("2026-08-08T12:00:00.000Z")

  it("jest ROZŁĄCZNY z „zrealizowany” i „wygasły”", () => {
    expect(resolveRedeemRefusalReason("refunded", null, now)).toBe("refunded")
    expect(resolveRedeemRefusalReason("claimed", null, now)).toBe("already_redeemed")
    expect(resolveRedeemRefusalReason("expired", null, now)).toBe("expired")
    expect(resolveRedeemRefusalReason("withdrawn", null, now)).toBe("withdrawn")
  })

  it("wygrywa z gałęzią czasu — zwrócony voucher po terminie to wciąż „zwrócony”", () => {
    const past = new Date("2026-01-01T00:00:00.000Z")
    expect(resolveRedeemRefusalReason("refunded", past, now)).toBe("refunded")
  })

  it("stany z allow-listy wejściowej NADAL przechodzą (kontrola przeciwna)", () => {
    expect(resolveRedeemRefusalReason("idle", null, now)).toBeNull()
    expect(resolveRedeemRefusalReason("consent_pending", null, now)).toBeNull()
  })
})
