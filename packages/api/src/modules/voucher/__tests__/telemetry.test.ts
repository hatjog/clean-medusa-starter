import { describe, expect, it } from "@jest/globals"
import {
  LNE_EARLY_WARN_RATIO,
  LNE_THRESHOLD_EUR_MINOR,
  redemptionVelocity,
  rollingVolumeLNE,
} from "../telemetry"
import type { VoucherTelemetryEvent } from "../telemetry"

const PROFILE = "voucher_liability_only_v1"
const OTHER_PROFILE = "legacy_profile"

function issued(
  entitlement_id: string,
  occurred_at: string,
  amount_minor = 10000,
  overrides: Partial<VoucherTelemetryEvent> = {}
): VoucherTelemetryEvent {
  return {
    event_type: "gp.entitlements.entitlement_issued.v1",
    occurred_at,
    posting_profile: PROFILE,
    vat_classification: "MPV",
    payload: {
      entitlement_id,
      currency: "EUR",
      amount_minor,
      is_lne: true,
    },
    ...overrides,
  }
}

function redeemed(
  entitlement_id: string,
  occurred_at: string,
  overrides: Partial<VoucherTelemetryEvent> = {}
): VoucherTelemetryEvent {
  return {
    event_type: "gp.entitlements.entitlement_redeemed.v1",
    occurred_at,
    posting_profile: PROFILE,
    vat_classification: "MPV",
    payload: {
      entitlement_id,
      redeemed_at: occurred_at,
      currency: "EUR",
      amount_minor: 10000,
      remaining_minor_after: 0,
      new_status: "REDEEMED",
    },
    ...overrides,
  }
}

function idsLeak(output: unknown): boolean {
  const text = JSON.stringify(output)
  return [
    "customer_123",
    "buyer@example.com",
    "+48123123123",
    "SECRET-CODE-123",
    "ent_pii",
  ].some((token) => text.includes(token))
}

describe("voucher telemetry redemptionVelocity", () => {
  it("returns deterministic aggregate distribution per posting profile without PII", () => {
    const events: VoucherTelemetryEvent[] = [
      issued("ent_fast", "2026-01-01T00:00:00Z", 10000),
      redeemed("ent_fast", "2026-01-02T00:00:00Z"),
      redeemed("ent_slow", "2026-01-11T00:00:00Z"),
      issued("ent_slow", "2026-01-01T00:00:00Z", 10000, {
        customer_id: "customer_123",
        voucher_code: "SECRET-CODE-123",
        payload: {
          entitlement_id: "ent_slow",
          currency: "EUR",
          amount_minor: 10000,
          is_lne: true,
          customer_email: "buyer@example.com",
          customer_phone: "+48123123123",
        },
      }),
      issued("ent_open", "2026-01-05T00:00:00Z", 10000),
      issued("ent_other", "2026-01-01T00:00:00Z", 10000, {
        posting_profile: OTHER_PROFILE,
      }),
      redeemed("ent_other", "2026-01-03T00:00:00Z", {
        posting_profile: OTHER_PROFILE,
      }),
    ]

    const result = redemptionVelocity(events, { profile: PROFILE })

    expect(result).toMatchObject({
      profile: PROFILE,
      count: 2,
      unredeemed_count: 1,
      min_ms: 24 * 60 * 60 * 1000,
      max_ms: 10 * 24 * 60 * 60 * 1000,
      avg_ms: 5.5 * 24 * 60 * 60 * 1000,
      percentiles_ms: {
        p50: 24 * 60 * 60 * 1000,
        p90: 10 * 24 * 60 * 60 * 1000,
      },
    })
    expect(result.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(2)
    expect(result.buckets.find((bucket) => bucket.label === "<=1d")?.count).toBe(1)
    expect(result.buckets.find((bucket) => bucket.label === "<=30d")?.count).toBe(1)
    expect(idsLeak(result)).toBe(false)
    expect(redemptionVelocity(events, { profile: PROFILE })).toEqual(result)
  })

  it("does not count partial redeem as completed velocity until final redeem arrives", () => {
    const result = redemptionVelocity(
      [
        issued("ent_partial", "2026-01-01T00:00:00Z"),
        redeemed("ent_partial", "2026-01-02T00:00:00Z", {
          payload: {
            entitlement_id: "ent_partial",
            redeemed_at: "2026-01-02T00:00:00Z",
            currency: "EUR",
            amount_minor: 5000,
            remaining_minor_after: 5000,
            new_status: "PARTIALLY_REDEEMED",
          },
        }),
        redeemed("ent_partial", "2026-01-04T00:00:00Z"),
      ],
      { profile: PROFILE }
    )

    expect(result.count).toBe(1)
    expect(result.min_ms).toBe(3 * 24 * 60 * 60 * 1000)
    expect(result.unredeemed_count).toBe(0)
  })
})

describe("voucher telemetry rollingVolumeLNE", () => {
  it("uses a half-open (start, asOf] 12-month UTC rolling window — start exclusive, end inclusive", () => {
    const asOf = "2026-06-01T12:00:00Z"
    const windowStart = "2025-06-01T12:00:00Z"
    const justAfterStart = "2025-06-01T12:00:00.001Z"
    const justAfterAsOf = "2026-06-01T12:00:00.001Z"

    const result = rollingVolumeLNE(
      [
        // start EKSKLUZYWNY: event dokładnie na windowStart NIE jest liczony
        // (eliminuje double-count na granicy między sąsiednimi przebiegami).
        issued("ent_at_start", windowStart, 100_00),
        issued("ent_just_after_start", justAfterStart, 200_00),
        issued("ent_inside", "2026-02-01T00:00:00+01:00", 300_00),
        // koniec INKLUZYWNY: event dokładnie na asOf jest liczony.
        issued("ent_at_asof", asOf, 150_00),
        issued("ent_after", justAfterAsOf, 400_00),
      ],
      { profile: PROFILE, asOf }
    )

    expect(result.window).toEqual({
      start_at: "2025-06-01T12:00:00.000Z",
      start_inclusive: false,
      end_at: "2026-06-01T12:00:00.000Z",
      end_inclusive: true,
    })
    // included = just-after-start (200_00) + inside (300_00) + at-asOf (150_00)
    expect(result.volume).toEqual({ currency: "EUR", minor: 650_00 })
    expect(result.events_included_count).toBe(3)
    expect(result.data_quality.events_outside_window_count).toBe(2)
  })

  it("sets early_warn at 80 percent and alert only above 1M EUR", () => {
    expect(LNE_THRESHOLD_EUR_MINOR).toBe(100_000_000)
    expect(LNE_EARLY_WARN_RATIO).toBe(0.8)

    const asOf = "2026-06-01T00:00:00Z"

    const justBelow = rollingVolumeLNE(
      [issued("ent_below", "2026-05-01T00:00:00Z", LNE_THRESHOLD_EUR_MINOR - 1)],
      { profile: PROFILE, asOf }
    )
    expect(justBelow.volume.minor).toBe(LNE_THRESHOLD_EUR_MINOR - 1)
    expect(justBelow.early_warn).toBe(true)
    expect(justBelow.alert).toBe(false)

    const exactly = rollingVolumeLNE(
      [issued("ent_exact", "2026-05-01T00:00:00Z", LNE_THRESHOLD_EUR_MINOR)],
      { profile: PROFILE, asOf }
    )
    expect(exactly.ratio).toBe(1)
    expect(exactly.early_warn).toBe(true)
    expect(exactly.alert).toBe(false)

    const justAbove = rollingVolumeLNE(
      [issued("ent_above", "2026-05-01T00:00:00Z", LNE_THRESHOLD_EUR_MINOR + 1)],
      { profile: PROFILE, asOf }
    )
    expect(justAbove.early_warn).toBe(true)
    expect(justAbove.alert).toBe(true)
  })

  it("does not early-warn below 80 percent and aggregates only the requested profile", () => {
    const asOf = "2026-06-01T00:00:00Z"

    const result = rollingVolumeLNE(
      [
        issued("ent_target", "2026-05-01T00:00:00Z", 79_999_999),
        issued("ent_other", "2026-05-01T00:00:00Z", LNE_THRESHOLD_EUR_MINOR + 1, {
          posting_profile: OTHER_PROFILE,
        }),
      ],
      { profile: PROFILE, asOf }
    )

    expect(result.volume.minor).toBe(79_999_999)
    expect(result.early_warn).toBe(false)
    expect(result.alert).toBe(false)
  })

  it("fails safe when ambiguous data could hide an LNE threshold breach", () => {
    const result = rollingVolumeLNE(
      [
        issued("ent_clear", "2026-05-01T00:00:00Z", 10_00),
        {
          event_type: "gp.entitlements.entitlement_issued.v1",
          occurred_at: "2026-05-02T00:00:00Z",
          payload: {
            entitlement_id: "ent_pii",
            currency: "EUR",
            customer_email: "buyer@example.com",
          },
          voucher_code: "SECRET-CODE-123",
        },
      ],
      { profile: PROFILE, asOf: "2026-06-01T00:00:00Z" }
    )

    expect(result.alert).toBe(true)
    expect(result.early_warn).toBe(true)
    expect(result.data_quality.fail_safe_missing_amount_count).toBe(1)
    expect(result.data_quality.ambiguous_profile_included_count).toBe(1)
    expect(idsLeak(result)).toBe(false)
  })

  it("is deterministic for identical inputs and injected asOf", () => {
    const events = [
      issued("ent_a", "2026-05-01T00:00:00Z", 200_00),
      issued("ent_b", "2026-05-02T00:00:00Z", 300_00),
    ]
    const options = { profile: PROFILE, asOf: "2026-06-01T00:00:00Z" }

    expect(rollingVolumeLNE(events, options)).toEqual(rollingVolumeLNE(events, options))
  })
})

describe("voucher telemetry rollingVolumeLNE — real canonical event shapes (HIGH-1)", () => {
  // Dokładny kształt z specs/contracts/events/examples/entitlement_issued.example.json
  // (gp.entitlements.entitlement_issued.v1): brutto = payload.amount_minor, waluta
  // = payload.currency (PLN), occurred_at top-level; BEZ is_lne/posting_profile.
  const canonicalDomainIssued: VoucherTelemetryEvent = {
    schema_version: "1",
    event_type: "gp.entitlements.entitlement_issued.v1",
    occurred_at: "2026-01-31T12:01:00Z",
    actor: "system",
    scope: {
      instance_id: "gp-dev",
      market_id: "pl",
      vendor_id: "vendor_abc",
      location_id: "loc_001",
    },
    idempotency_key: "entitlement:ent_001",
    payload: {
      entitlement_id: "ent_001",
      order_id: "ord_123",
      payment_id: "pay_123",
      line_item_id: "li_001",
      entitlement_type: "VOUCHER_AMOUNT",
      currency: "PLN",
      amount_minor: 19900,
      items_count: 1,
    },
  }

  it("PoC: real domain entitlement_issued.v1 event yields volume>0 (FX PLN→EUR), not vacuous 0", () => {
    const result = rollingVolumeLNE([canonicalDomainIssued], {
      profile: PROFILE,
      asOf: "2026-06-01T00:00:00Z",
      fx_rates_to_eur: { PLN: 0.23 },
    })

    // 19900 grosz * 0.23 = 4577 EUR-minor — wolumen jest NIEZEROWY i policzony
    // z realnego pola payload.amount_minor (nie z wymyślonego kształtu).
    expect(result.volume).toEqual({ currency: "EUR", minor: 4577 })
    expect(result.events_included_count).toBe(1)
    expect(result.alert).toBe(false)
    expect(result.data_quality.fail_safe_missing_amount_count).toBe(0)
    expect(result.data_quality.fx_converted_count).toBe(1)
    // brak posting_profile w domenowym evencie → fail-safe include
    expect(result.data_quality.ambiguous_profile_included_count).toBe(1)
    // brak is_lne/regulatory_model → unknown → include (monitoring fail-safe)
    expect(result.data_quality.ambiguous_lne_scope_included_count).toBe(1)
  })

  it("canonical ledger-transaction.v1 ENTITLEMENT_ISSUED VAT carve-out has no gross → fail-safe (not silent 0)", () => {
    // Dokładny kształt z specs/contracts/ledger/examples/
    // ledger-transaction.v1.entitlement_issued.example.json — lines[] niosą TYLKO
    // carve-out VAT (debet liability=2300 / kredyt vat:output:emission=2300),
    // brutto stored-value NIE istnieje w entitlement-ledgerze (money-ledger / 2.5).
    const ledgerIssued: VoucherTelemetryEvent = {
      transaction_id: "ltx_entitlement_2001",
      occurred_at: "2026-01-31T09:15:00Z",
      scope: { instance_id: "gp-dev", market_id: "pl" },
      currency: "PLN",
      entry_type: "ENTITLEMENT_ISSUED",
      lines: [
        {
          ledger_entry_id: "le_2001",
          account: "liability:contract_liability:voucher",
          debit_minor: 2300,
          credit_minor: 0,
        },
        {
          ledger_entry_id: "le_2002",
          account: "vat:output:emission",
          debit_minor: 0,
          credit_minor: 2300,
        },
      ],
      metadata: {
        posting_profile: "voucher_liability_only_v1",
        vat_classification: "SPV",
        lifecycle_event: "ISSUED",
      },
    }

    const result = rollingVolumeLNE([ledgerIssued], {
      profile: PROFILE,
      asOf: "2026-06-01T00:00:00Z",
      fx_rates_to_eur: { PLN: 0.23 },
    })

    expect(result.volume.minor).toBe(0)
    expect(result.alert).toBe(true)
    expect(result.data_quality.fail_safe_missing_amount_count).toBe(1)
    // profil dopasowany z metadata.posting_profile (nie pominięty)
    expect(result.data_quality.events_skipped_profile_count).toBe(0)
    expect(result.data_quality.ambiguous_profile_included_count).toBe(0)
  })
})

describe("voucher telemetry rollingVolumeLNE — FX/fail-safe non-EUR (HIGH-2/VER-H1)", () => {
  const gbpIssued = (id: string, amountMinor: number): VoucherTelemetryEvent => ({
    event_type: "gp.entitlements.entitlement_issued.v1",
    occurred_at: "2026-05-01T00:00:00Z",
    posting_profile: PROFILE,
    payload: {
      entitlement_id: id,
      currency: "GBP",
      amount_minor: amountMinor,
      is_lne: true,
    },
  })

  it("PoC: 900k GBP without FX rate fails safe (alert) — never silently under-counts an LNE breach", () => {
    const result = rollingVolumeLNE([gbpIssued("ent_gbp", 900_000_00)], {
      profile: PROFILE,
      asOf: "2026-06-01T00:00:00Z",
    })

    expect(result.alert).toBe(true)
    expect(result.volume.minor).toBe(0)
    expect(result.data_quality.non_eur_missing_fx_count).toBe(1)
  })

  it("PoC: 900k GBP with FX → ~1.05M EUR → alert via converted volume", () => {
    const result = rollingVolumeLNE([gbpIssued("ent_gbp", 900_000_00)], {
      profile: PROFILE,
      asOf: "2026-06-01T00:00:00Z",
      fx_rates_to_eur: { GBP: 1.17 },
    })

    // 90_000_000 minor * 1.17 = 105_300_000 EUR-minor > 100_000_000 próg
    expect(result.volume.minor).toBe(105_300_000)
    expect(result.alert).toBe(true)
    expect(result.data_quality.fx_converted_count).toBe(1)
    expect(result.data_quality.non_eur_missing_fx_count).toBe(0)
  })
})

describe("voucher telemetry rollingVolumeLNE — dedup + zero-amount (VER-M1/VER-M2 + LOW)", () => {
  it("VER-M1: deduplicates replayed ISSUED per entitlement_id (no inflated volume / false alert)", () => {
    const result = rollingVolumeLNE(
      [
        issued("ent_dup", "2026-05-01T00:00:00Z", 60_000_000),
        // replay tego samego ISSUED (at-least-once feed) — NIE może podwoić wolumenu
        issued("ent_dup", "2026-05-02T00:00:00Z", 60_000_000),
      ],
      { profile: PROFILE, asOf: "2026-06-01T00:00:00Z" }
    )

    expect(result.volume.minor).toBe(60_000_000)
    expect(result.alert).toBe(false)
    expect(result.data_quality.duplicate_issued_skipped_count).toBe(1)
    expect(result.events_included_count).toBe(1)
  })

  it("VER-M2: amount_minor 0 masking a positive gross_minor uses the gross (no under-count)", () => {
    const result = rollingVolumeLNE(
      [
        {
          event_type: "gp.entitlements.entitlement_issued.v1",
          occurred_at: "2026-05-01T00:00:00Z",
          posting_profile: PROFILE,
          payload: {
            entitlement_id: "ent_zero_gross",
            currency: "EUR",
            amount_minor: 0,
            gross_minor: 200_000_000,
            is_lne: true,
          },
        },
      ],
      { profile: PROFILE, asOf: "2026-06-01T00:00:00Z" }
    )

    expect(result.volume.minor).toBe(200_000_000)
    expect(result.alert).toBe(true)
    expect(result.data_quality.fail_safe_missing_amount_count).toBe(0)
  })

  it("VER-M2: amount_minor 0 with no gross is ambiguous → fail-safe (alert)", () => {
    const result = rollingVolumeLNE(
      [
        {
          event_type: "gp.entitlements.entitlement_issued.v1",
          occurred_at: "2026-05-01T00:00:00Z",
          posting_profile: PROFILE,
          payload: {
            entitlement_id: "ent_zero",
            currency: "EUR",
            amount_minor: 0,
            is_lne: true,
          },
        },
      ],
      { profile: PROFILE, asOf: "2026-06-01T00:00:00Z" }
    )

    expect(result.volume.minor).toBe(0)
    expect(result.alert).toBe(true)
    expect(result.data_quality.fail_safe_missing_amount_count).toBe(1)
  })

  it("LOW: conflicting is_lne (top false vs payload true) resolves to LNE inclusion (fail-safe)", () => {
    const result = rollingVolumeLNE(
      [
        {
          event_type: "gp.entitlements.entitlement_issued.v1",
          occurred_at: "2026-05-01T00:00:00Z",
          posting_profile: PROFILE,
          is_lne: false,
          payload: {
            entitlement_id: "ent_conflict",
            currency: "EUR",
            amount_minor: 50_000_000,
            is_lne: true,
          },
        },
      ],
      { profile: PROFILE, asOf: "2026-06-01T00:00:00Z" }
    )

    expect(result.volume.minor).toBe(50_000_000)
    expect(result.data_quality.explicit_non_lne_excluded_count).toBe(0)
    expect(result.data_quality.ambiguous_lne_scope_included_count).toBe(0)
  })
})
