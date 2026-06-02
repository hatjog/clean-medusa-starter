/**
 * Story 4.4 (v1.11.0 Epic 4 / Wave 4 — lifecycle L4 extend) — unit tests.
 *
 * Pokrywa AC1 + AC2 polityki/okablowania extend:
 *   AC1 — pierwszy extend nieodpłatny dokładnie 1× (licznik 0→1, idempotentny);
 *         przedłużenie `expires_at` w granicach boundary; tranzycja routuje przez
 *         jednolity punkt (audit envelope + posting hook audit-only); 2× free ⇒ odmowa.
 *   AC2 — odpłatny extend 5–15% fail-closed; ZAWSZE z równorzędną bezpłatną opcją
 *         zwrotu salda (parytet); copy NIGDY „przepadnie"/„zapłać albo strać";
 *         profil forfeiture / opłata poza boundary ⇒ zablokowany fail-closed.
 *   T3  — posting GATED (audit-only/no-op, runtime_enabled=false) + taksonomia (D-5)
 *         niezmienna; opłata extendu = money-ledger (deferred).
 */

import { describe, it, expect } from "@jest/globals"
import {
  EXTEND_FEE_PCT_MIN,
  EXTEND_FEE_PCT_MAX,
  MAX_FREE_EXTENDS,
  FreeExtendExhaustedError,
  FreeExtendIdempotencyMissingError,
  ExtendFeeBoundaryError,
  ExtendParityError,
  ExtendCoercionCopyError,
  ExtendProfileError,
  ExtendExtensionMonthsBoundaryError,
  ForfeitureCopyError,
  determineExtendMode,
  computeExtendedExpiresAt,
  buildExtendIdempotencyKey,
  assertExtendCopySafe,
  assertNoCoercionExtendCopy,
  defaultPaidExtendMessage,
  buildPaidExtendOffer,
  assertExtendProfileActivatable,
  buildExtendPostingDeferral,
  buildExtendTransitionInput,
  buildExtendWiring,
  ALL_ENTITLEMENT_INSTANCE_STATES,
  EntitlementInstanceState,
  ENTITLEMENT_STATE_CHANGED_EVENT_TYPE,
  type TransitionAuditEnvelope,
  type TransitionEventEnvelope,
} from ".."

const SCOPE = {
  instance_id: "ent_extend_001",
  market_id: "mkt_bonbeauty",
  sales_channel_id: "sc_bonbeauty",
}

// ---------------------------------------------------------------------------
// AC1 — pierwszy extend NIEODPŁATNY, dokładnie 1× (licznik 0→1, idempotentny)
// ---------------------------------------------------------------------------

describe("determineExtendMode — (1) free extend 1× (AC1)", () => {
  it("first free extend OK: counter 0→1", () => {
    const key = buildExtendIdempotencyKey("ent_extend_001", "seq-first")
    const d = determineExtendMode({
      requested: "free",
      unpaid_extension_count: 0,
      idempotency_key: key,
    })
    expect(d.mode).toBe("free")
    expect(d.fee_pct).toBe(0)
    expect(d.unpaid_extension_count_after).toBe(1)
    expect(d.idempotent_replay).toBe(false)
  })

  it("free extend bez idempotency_key ⇒ FreeExtendIdempotencyMissingError (runtime-backstop L1)", () => {
    expect(() =>
      determineExtendMode({ requested: "free", unpaid_extension_count: 0 })
    ).toThrow(FreeExtendIdempotencyMissingError)
  })

  it("second free extend REJECTED (FreeExtendExhaustedError) — kieruje do trybu odpłatnego", () => {
    const key = buildExtendIdempotencyKey("ent_extend_001", "seq-second")
    expect(() =>
      determineExtendMode({
        requested: "free",
        unpaid_extension_count: MAX_FREE_EXTENDS,
        idempotency_key: key,
      })
    ).toThrow(FreeExtendExhaustedError)
  })

  it("idempotent replay (ten sam idempotency_key) NIE podwaja licznika", () => {
    const key = buildExtendIdempotencyKey("ent_extend_001", "seq-1")
    const d = determineExtendMode({
      requested: "free",
      unpaid_extension_count: 1,
      idempotency_key: key,
      last_applied_idempotency_key: key,
    })
    // Replay: licznik bez zmian (NIE 1→2), mimo że count >= MAX (replay omija fail-closed).
    expect(d.idempotent_replay).toBe(true)
    expect(d.unpaid_extension_count_after).toBe(1)
  })

  it("różny idempotency_key na wyczerpanym liczniku NADAL odrzuca (nie-replay)", () => {
    expect(() =>
      determineExtendMode({
        requested: "free",
        unpaid_extension_count: 1,
        idempotency_key: buildExtendIdempotencyKey("ent_extend_001", "seq-2"),
        last_applied_idempotency_key: buildExtendIdempotencyKey("ent_extend_001", "seq-1"),
      })
    ).toThrow(FreeExtendExhaustedError)
  })
})

// ---------------------------------------------------------------------------
// AC2 — odpłatny extend 5–15% fail-closed
// ---------------------------------------------------------------------------

describe("determineExtendMode — (2) paid extend boundary 5–15% (AC2)", () => {
  it("accepts fee within [5, 15]", () => {
    for (const fee of [EXTEND_FEE_PCT_MIN, 10, EXTEND_FEE_PCT_MAX]) {
      const d = determineExtendMode({
        requested: "paid",
        unpaid_extension_count: 1,
        fee_pct: fee,
      })
      expect(d.mode).toBe("paid")
      expect(d.fee_pct).toBe(fee)
      // Odpłatny extend NIE konsumuje licznika bezpłatnych.
      expect(d.unpaid_extension_count_after).toBe(1)
    }
  })

  it("rejects fee < 5% (fail-closed)", () => {
    expect(() =>
      determineExtendMode({ requested: "paid", unpaid_extension_count: 1, fee_pct: 4 })
    ).toThrow(ExtendFeeBoundaryError)
  })

  it("rejects fee > 15% (fail-closed)", () => {
    expect(() =>
      determineExtendMode({ requested: "paid", unpaid_extension_count: 1, fee_pct: 16 })
    ).toThrow(ExtendFeeBoundaryError)
  })

  it("rejects missing / NaN fee (fail-closed)", () => {
    expect(() =>
      determineExtendMode({ requested: "paid", unpaid_extension_count: 1 })
    ).toThrow(ExtendFeeBoundaryError)
    expect(() =>
      determineExtendMode({ requested: "paid", unpaid_extension_count: 1, fee_pct: NaN })
    ).toThrow(ExtendFeeBoundaryError)
  })
})

// ---------------------------------------------------------------------------
// AC2 — PARYTET: odpłatny extend ZAWSZE z równorzędną bezpłatną opcją zwrotu
// ---------------------------------------------------------------------------

describe("buildPaidExtendOffer — parytet odpłatny ‖ bezpłatny zwrot (AC2)", () => {
  it("oferta zawiera paid_extend ORAZ free_refund_balance (bezpłatny)", () => {
    const offer = buildPaidExtendOffer({
      fee_pct: 10,
      remaining_minor: 5000,
      currency: "PLN",
    })
    const kinds = offer.options.map((o) => o.kind).sort()
    expect(kinds).toEqual(["free_refund_balance", "paid_extend"])
    const free = offer.options.find((o) => o.kind === "free_refund_balance")
    expect(free?.paid).toBe(false)
    const paid = offer.options.find((o) => o.kind === "paid_extend")
    expect(paid?.paid).toBe(true)
    expect(paid?.fee_pct).toBe(10)
  })

  it("fee poza boundary ⇒ ExtendFeeBoundaryError (oferta nie powstaje)", () => {
    expect(() =>
      buildPaidExtendOffer({ fee_pct: 20, remaining_minor: 5000 })
    ).toThrow(ExtendFeeBoundaryError)
  })

  it("copy oferty NIE zawiera sygnału przepadku/przymusu", () => {
    const offer = buildPaidExtendOffer({ fee_pct: 7, remaining_minor: 12300 })
    expect(offer.message.toLowerCase()).not.toContain("przepad")
    expect(offer.message.toLowerCase()).not.toContain("strać")
    // domyślna waluta PLN
    expect(offer.currency).toBe("PLN")
  })
})

// ---------------------------------------------------------------------------
// AC2 — copy NIGDY „przepadnie" / „zapłać albo strać" (anti-coercion/forfeiture)
// ---------------------------------------------------------------------------

describe("assertExtendCopySafe — forbidden copy (AC2)", () => {
  it("rzuca ExtendCoercionCopyError na 'zapłać albo strać'", () => {
    expect(() =>
      assertNoCoercionExtendCopy("Zapłać albo stracisz saldo na zawsze")
    ).toThrow(ExtendCoercionCopyError)
  })

  it("rzuca ForfeitureCopyError na 'przepadnie' (reuse 4.2)", () => {
    expect(() =>
      assertExtendCopySafe("Twoje saldo wkrótce przepadnie — przedłuż za opłatą")
    ).toThrow(ForfeitureCopyError)
  })

  it("przepuszcza copy równorzędności (extend ALBO bezpłatny zwrot)", () => {
    const msg = defaultPaidExtendMessage(10, 5000, "PLN")
    expect(() => assertExtendCopySafe(msg)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// AC2 — blokada profilu forfeiture / opłaty extendu poza boundary (fail-closed)
// ---------------------------------------------------------------------------

describe("assertExtendProfileActivatable — blokada profilu (AC2)", () => {
  it("przepuszcza profil z opłatą extendu w boundary + jawną on_expiry_convert_to", () => {
    expect(() =>
      assertExtendProfileActivatable({
        validity_months: 12,
        extension: { paid: true, fee_pct: 10 },
        on_expiry_convert_to: "extend",
      })
    ).not.toThrow()
  })

  it("blokuje profil z opłatą extendu poza [5,15]% (ExtendProfileError)", () => {
    expect(() =>
      assertExtendProfileActivatable({
        validity_months: 12,
        extension: { paid: true, fee_pct: 30 },
        on_expiry_convert_to: "refund",
      })
    ).toThrow(ExtendProfileError)
  })

  it("blokuje profil z forfeiture on_expiry (ExtendProfileError)", () => {
    expect(() =>
      assertExtendProfileActivatable({
        validity_months: 12,
        on_expiry_convert_to: "forfeit",
      })
    ).toThrow(ExtendProfileError)
  })

  it("blokuje profil bez on_expiry_convert_to (omission — L2 forfeiture coverage)", () => {
    expect(() =>
      assertExtendProfileActivatable({
        validity_months: 12,
        extension: { paid: true, fee_pct: 10 },
        // on_expiry_convert_to nieobecne — brak jawnej deklaracji zachowania po wygaśnięciu
      })
    ).toThrow(ExtendProfileError)
  })
})

// ---------------------------------------------------------------------------
// AC1 — deterministyczny expires_at clamp do boundary (≤ 24 mies. od emisji)
// ---------------------------------------------------------------------------

describe("computeExtendedExpiresAt — clamp do boundary (AC1, FR14)", () => {
  const issued = new Date("2026-01-15T00:00:00.000Z")

  it("przedłuża w granicach (12 mies. ważności + 6 mies. extend ≤ 24)", () => {
    const current = new Date("2027-01-15T00:00:00.000Z") // issue + 12 mies.
    const out = computeExtendedExpiresAt({
      issued_at: issued,
      current_expires_at: current,
      extension_months: 6,
    })
    expect(out.toISOString()).toBe("2027-07-15T00:00:00.000Z")
  })

  it("CLAMP do 24 mies. od emisji (nie poza boundary)", () => {
    const current = new Date("2027-07-15T00:00:00.000Z") // issue + 18 mies.
    const out = computeExtendedExpiresAt({
      issued_at: issued,
      current_expires_at: current,
      extension_months: 12, // 18+12=30 > 24 ⇒ clamp do 24
    })
    // issue + 24 mies. = 2028-01-15
    expect(out.toISOString()).toBe("2028-01-15T00:00:00.000Z")
  })

  it("deterministyczny — ten sam input ⇒ ten sam wynik", () => {
    const current = new Date("2027-01-15T00:00:00.000Z")
    const a = computeExtendedExpiresAt({ issued_at: issued, current_expires_at: current, extension_months: 3 })
    const b = computeExtendedExpiresAt({ issued_at: issued, current_expires_at: current, extension_months: 3 })
    expect(a.toISOString()).toBe(b.toISOString())
  })

  it("NIGDY nie skraca ważności (defense-in-depth)", () => {
    const current = new Date("2028-06-15T00:00:00.000Z") // już > issue + 24
    const out = computeExtendedExpiresAt({
      issued_at: issued,
      current_expires_at: current,
      extension_months: 6,
    })
    expect(out.getTime()).toBeGreaterThanOrEqual(current.getTime())
  })
})

// ---------------------------------------------------------------------------
// AC1 / T3 — tranzycja extend routuje przez jednolity punkt; posting audit-only
// ---------------------------------------------------------------------------

describe("buildExtendWiring — okablowanie jednolite, posting audit-only (AC1/T3)", () => {
  it("produkuje audit envelope (kto/co/kiedy/scope/wynik) + posting audit-only", async () => {
    const audits: unknown[] = []
    const res = await buildExtendWiring(
      {
        // brak ledgerWriter / postingActivation ⇒ domyślna bramka (runtime_enabled=false)
        clock: () => new Date("2026-06-02T12:00:00.000Z"),
      },
      {
        entitlement_id: "ent_extend_001",
        state: EntitlementInstanceState.ACTIVE,
        scope: SCOPE,
        mode: "free",
        extend_seq: "seq-1",
      }
    )
    // audit envelope: pięć osi
    expect(res.audit.actor).toBe("customer")
    expect(res.audit.actor_hint).toBe("extend:free")
    expect(res.audit.event_type).toBe(ENTITLEMENT_STATE_CHANGED_EVENT_TYPE)
    expect(res.audit.scope.market_id).toBe("mkt_bonbeauty")
    expect(res.audit.outcome).toBe("transitioned")
    expect(res.audit.occurred_at).toBe("2026-06-02T12:00:00.000Z")
    // KRYTYCZNE: extend = brak payloadu postingu ⇒ audit-only (NIE księguje).
    expect(res.posting.attempted).toBe(false)
    expect(res.posting.activated).toBe(false)
    expect(res.posting.persisted).toBe(false)
    void audits
  })

  it("paid extend: actor_hint koduje tryb + fee, NADAL audit-only (liability bez zmiany)", async () => {
    const res = await buildExtendWiring(
      { clock: () => new Date("2026-06-02T12:00:00.000Z") },
      {
        entitlement_id: "ent_extend_001",
        state: EntitlementInstanceState.ACTIVE,
        scope: SCOPE,
        mode: "paid",
        fee_pct: 10,
        extend_seq: "seq-2",
      }
    )
    expect(res.audit.actor_hint).toBe("extend:paid:10%")
    expect(res.posting.attempted).toBe(false)
    expect(res.posting.persisted).toBe(false)
  })

  it("buildExtendTransitionInput: from===to (extend NIE zmienia stanu, D-5) + brak posting", () => {
    const input = buildExtendTransitionInput({
      entitlement_id: "ent_extend_001",
      state: EntitlementInstanceState.ACTIVE,
      scope: SCOPE,
      mode: "free",
      extend_seq: "seq-1",
    })
    expect(input.from).toBe(EntitlementInstanceState.ACTIVE)
    expect(input.to).toBe(EntitlementInstanceState.ACTIVE)
    expect(input.posting).toBeUndefined()
    expect(input.transition_seq).toBe("seq-1")
  })
})

// ---------------------------------------------------------------------------
// T3 — posting deferral (opłata = money-ledger) + idempotency key
// ---------------------------------------------------------------------------

describe("extend posting deferral + idempotency", () => {
  it("buildExtendPostingDeferral oznacza deferred + wymaga osobnego ADR", () => {
    const d = buildExtendPostingDeferral({ mode: "paid", unposted_fee_minor: 500, currency: "PLN" })
    expect(d.deferred).toBe(true)
    expect(d.requires_adr).toContain("ADR-required")
    expect(d.unposted_fee_minor).toBe(500)
    expect(d.mode).toBe("paid")
  })

  it("buildExtendIdempotencyKey deterministyczny + stabilny przy replay", () => {
    const a = buildExtendIdempotencyKey("ent_extend_001", "seq-1")
    const b = buildExtendIdempotencyKey("ent_extend_001", "seq-1")
    expect(a).toBe(b)
    expect(a).toBe("entitlement:ent_extend_001:extend:seq-1")
  })
})

// ---------------------------------------------------------------------------
// D-5 — taksonomia stanów NIEZMIENNA (extend zmienia expires_at, NIE stan)
// ---------------------------------------------------------------------------

describe("inwariant taksonomii (D-5)", () => {
  it("ALL_ENTITLEMENT_INSTANCE_STATES = 13 stanów (extend NIE dodaje stanu)", () => {
    expect(ALL_ENTITLEMENT_INSTANCE_STATES).toHaveLength(13)
  })
})

// ---------------------------------------------------------------------------
// M1 — assertExtendCopySafe: synonimy „zapłać albo strać" / przepadek
// ---------------------------------------------------------------------------

describe("assertExtendCopySafe — synonimy przymusu/przepadku (M1)", () => {
  it("rzuca na 'bezpowrotnie' (synonym: nie do odzyskania)", () => {
    expect(() =>
      assertExtendCopySafe("Twoje saldo wygaśnie bezpowrotnie, jeśli nie przedłużysz")
    ).toThrow(ExtendCoercionCopyError)
  })

  it("rzuca na 'ostatnia szansa' (fałszywa pilność)", () => {
    expect(() =>
      assertExtendCopySafe("Ostatnia szansa — przedłuż teraz lub stracisz saldo")
    ).toThrow()
  })

  it("rzuca na 'tylko teraz' (pressure urgency)", () => {
    expect(() =>
      assertExtendCopySafe("Możesz przedłużyć tylko teraz za 10%")
    ).toThrow(ExtendCoercionCopyError)
  })

  it("przepuszcza copy równorzędności (extend ALBO bezpłatny zwrot — bez synonimów)", () => {
    const msg = defaultPaidExtendMessage(10, 5000, "PLN")
    expect(() => assertExtendCopySafe(msg)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// M2 — parytet WALIDOWANY (refund_available jako wejście, ExtendParityError osiągalny)
// ---------------------------------------------------------------------------

describe("buildPaidExtendOffer — parytet walidowany, ExtendParityError osiągalny (M2)", () => {
  it("refund_available:false ⇒ ExtendParityError (brak parytetu — fail-closed AC2)", () => {
    expect(() =>
      buildPaidExtendOffer({ fee_pct: 10, remaining_minor: 5000, refund_available: false })
    ).toThrow(ExtendParityError)
  })

  it("refund_available:true (domyślne) ⇒ oferta z parytetu (paid + free_refund_balance)", () => {
    const offer = buildPaidExtendOffer({
      fee_pct: 10,
      remaining_minor: 5000,
      refund_available: true,
    })
    expect(offer.options.map((o) => o.kind).sort()).toEqual([
      "free_refund_balance",
      "paid_extend",
    ])
  })
})

// ---------------------------------------------------------------------------
// M3 — buildExtendWiring: appendAudit + emitEvent faktycznie wołane
// ---------------------------------------------------------------------------

describe("buildExtendWiring — audit persystowany + event emitowany (M3)", () => {
  it("appendAudit wołany gdy podany (audit faktycznie persystowany)", async () => {
    const auditSink: TransitionAuditEnvelope[] = []
    await buildExtendWiring(
      {
        appendAudit: async (a) => {
          auditSink.push(a)
        },
        clock: () => new Date("2026-06-02T12:00:00.000Z"),
      },
      {
        entitlement_id: "ent_extend_001",
        state: EntitlementInstanceState.ACTIVE,
        scope: SCOPE,
        mode: "free",
        extend_seq: "seq-m3-audit",
      }
    )
    expect(auditSink).toHaveLength(1)
    expect(auditSink[0].actor).toBe("customer")
    expect(auditSink[0].actor_hint).toBe("extend:free")
    expect(auditSink[0].scope.market_id).toBe("mkt_bonbeauty")
  })

  it("emitEvent wołany gdy podany + emitFailed:false (posting nadal audit-only)", async () => {
    const emittedEvents: TransitionEventEnvelope[] = []
    const res = await buildExtendWiring(
      {
        emitEvent: async (e) => {
          emittedEvents.push(e)
        },
        clock: () => new Date("2026-06-02T12:00:00.000Z"),
      },
      {
        entitlement_id: "ent_extend_001",
        state: EntitlementInstanceState.ACTIVE,
        scope: SCOPE,
        mode: "paid",
        fee_pct: 10,
        extend_seq: "seq-m3-event",
      }
    )
    expect(emittedEvents).toHaveLength(1)
    expect(emittedEvents[0].event_type).toBe(ENTITLEMENT_STATE_CHANGED_EVENT_TYPE)
    expect(res.emitFailed).toBe(false)
    expect(res.posting.attempted).toBe(false)
  })

  it("emitFailed:false gdy emitEvent niepodany", async () => {
    const res = await buildExtendWiring(
      { clock: () => new Date("2026-06-02T12:00:00.000Z") },
      {
        entitlement_id: "ent_extend_001",
        state: EntitlementInstanceState.ACTIVE,
        scope: SCOPE,
        mode: "free",
        extend_seq: "seq-m3-noemit",
      }
    )
    expect(res.emitFailed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// L3 — computeExtendedExpiresAt: dolna granica > 0 miesięcy
// ---------------------------------------------------------------------------

describe("computeExtendedExpiresAt — dolna granica extension_months (L3)", () => {
  const issued = new Date("2026-01-15T00:00:00.000Z")
  const current = new Date("2027-01-15T00:00:00.000Z")

  it("0 miesięcy ⇒ ExtendExtensionMonthsBoundaryError (nie konsumuje free extend)", () => {
    expect(() =>
      computeExtendedExpiresAt({ issued_at: issued, current_expires_at: current, extension_months: 0 })
    ).toThrow(ExtendExtensionMonthsBoundaryError)
  })

  it("ujemne miesiące ⇒ ExtendExtensionMonthsBoundaryError (fail-closed)", () => {
    expect(() =>
      computeExtendedExpiresAt({ issued_at: issued, current_expires_at: current, extension_months: -1 })
    ).toThrow(ExtendExtensionMonthsBoundaryError)
  })

  it("NaN ⇒ ExtendExtensionMonthsBoundaryError (fail-closed)", () => {
    expect(() =>
      computeExtendedExpiresAt({ issued_at: issued, current_expires_at: current, extension_months: NaN })
    ).toThrow(ExtendExtensionMonthsBoundaryError)
  })

  it("1 miesiąc (min) ⇒ OK, przedłuża ważność", () => {
    const result = computeExtendedExpiresAt({
      issued_at: issued,
      current_expires_at: current,
      extension_months: 1,
    })
    expect(result.getTime()).toBeGreaterThan(current.getTime())
  })
})
