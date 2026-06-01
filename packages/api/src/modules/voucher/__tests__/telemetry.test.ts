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
  it("uses an inclusive 12-month UTC rolling window and excludes events just outside it", () => {
    const asOf = "2026-06-01T12:00:00Z"
    const boundary = "2025-06-01T12:00:00Z"
    const justBeforeBoundary = "2025-06-01T11:59:59.999Z"
    const justAfterAsOf = "2026-06-01T12:00:00.001Z"

    const result = rollingVolumeLNE(
      [
        issued("ent_before", justBeforeBoundary, 100_00),
        issued("ent_boundary", boundary, 200_00),
        issued("ent_inside", "2026-02-01T00:00:00+01:00", 300_00),
        issued("ent_after", justAfterAsOf, 400_00),
      ],
      { profile: PROFILE, asOf }
    )

    expect(result.window).toEqual({
      start_at: "2025-06-01T12:00:00.000Z",
      start_inclusive: true,
      end_at: "2026-06-01T12:00:00.000Z",
      end_inclusive: true,
    })
    expect(result.volume).toEqual({ currency: "EUR", minor: 500_00 })
    expect(result.events_included_count).toBe(2)
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
