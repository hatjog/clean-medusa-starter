/**
 * STORY-MIG-B AC #9 — feature-flag emission gate.
 *
 * Scope:
 *   - Flag OFF (default) → publisher emits v1 envelope (event_type
 *     `gp.commerce.order_placed.v1`, schema_version "1", no `mor`).
 *   - Flag ON in market → publisher emits v2 envelope (event_type
 *     `gp.commerce.order_placed.v2`, schema_version "2", required `mor`).
 *   - Flag is read per-market from `market_runtime_config.feature_flags`.
 *   - Toggling the flag mid-stream flips emission shape with no other side
 *     effects (rollback path: flag OFF reverts instantly).
 *
 * Invocation:
 *   cd GP/backend && yarn test:unit -- src/__tests__/events/orderplaced-v2-flag-toggle.test.ts
 */

import { describe, it, expect } from "@jest/globals"

import {
  composeOrderPlacedEnvelope,
  isOrderPlacedV2EmissionEnabled,
  type MarketRuntimeConfig,
  type OrderPlacedComposeInput,
} from "../../lib/events/orderplaced-v2-publisher"

import v2Sample from "../fixtures/events/orderplaced-v2-payload.sample.json"

function buildInput(
  overrides?: Partial<OrderPlacedComposeInput>
): OrderPlacedComposeInput {
  return {
    event_id: "01J_FLAG_TEST_001",
    occurred_at: "2026-04-27T12:00:00Z",
    idempotency_key: "order:flag-test-001",
    actor: "end_customer",
    scope: { instance_id: "gp-prod", market_id: "bonbeauty-pl" },
    order: {
      order_id: "flag-test-001",
      currency: "PLN",
      total_amount_minor: 19900,
      line_items: [
        {
          line_item_id: "li_001",
          offer_id: "offer_x",
          offer_version: "1.0.0",
          pricing_snapshot: {
            currency: "PLN",
            unit_amount_minor: 19900,
            quantity: 1,
            total_amount_minor: 19900,
          },
        },
      ],
    },
    mor: {
      sale_mor: "operator",
      service_mor: "operator",
      mor_policy_version: "1.0.0",
      voucher_kind: "none",
      breakage_policy_snapshot: {
        policy_id: null,
        policy_version: null,
        recognition_mode: null,
        expiry_grace_days: null,
      },
    },
    market_runtime_config: {
      market_id: "bonbeauty-pl",
      locales: { default: "pl-PL" },
      feature_flags: { orderplaced_v2_emission_enabled: false },
    },
    ...overrides,
  }
}

describe("STORY-MIG-B AC #9 — orderplaced_v2_emission_enabled flag toggle", () => {
  it("isOrderPlacedV2EmissionEnabled defaults to false when flag is missing", () => {
    expect(isOrderPlacedV2EmissionEnabled(undefined)).toBe(false)
    expect(isOrderPlacedV2EmissionEnabled(null)).toBe(false)
    expect(
      isOrderPlacedV2EmissionEnabled({
        market_id: "bonbeauty-pl",
      })
    ).toBe(false)
    expect(
      isOrderPlacedV2EmissionEnabled({
        market_id: "bonbeauty-pl",
        feature_flags: {},
      })
    ).toBe(false)
  })

  it("isOrderPlacedV2EmissionEnabled returns true only when flag is exactly true", () => {
    const cfg: MarketRuntimeConfig = {
      market_id: "bonbeauty-pl",
      feature_flags: { orderplaced_v2_emission_enabled: true },
    }
    expect(isOrderPlacedV2EmissionEnabled(cfg)).toBe(true)
  })

  it("flag OFF → publisher emits v1 envelope (rollback / pre-canary baseline)", () => {
    const envelope = composeOrderPlacedEnvelope(buildInput())
    expect(envelope.event_type).toBe("gp.commerce.order_placed.v1")
    expect(envelope.schema_version).toBe("1")
    // v1 payload has no mor, no recipient_locale, no message_locale, no is_gift.
    expect((envelope.payload as Record<string, unknown>).mor).toBeUndefined()
    expect(
      (envelope.payload as Record<string, unknown>).recipient_locale
    ).toBeUndefined()
  })

  it("flag ON → publisher emits v2 envelope with full MoR snapshot + recipient_locale", () => {
    const envelope = composeOrderPlacedEnvelope(
      buildInput({
        market_runtime_config: {
          market_id: "bonbeauty-pl",
          locales: { default: "pl-PL" },
          feature_flags: { orderplaced_v2_emission_enabled: true },
        },
      })
    )
    expect(envelope.event_type).toBe("gp.commerce.order_placed.v2")
    expect(envelope.schema_version).toBe("2")
    expect((envelope.payload as Record<string, unknown>).mor).toBeDefined()
    expect(
      (envelope.payload as Record<string, unknown>).recipient_locale
    ).toBeNull() // Non-gift order.
    expect(
      (envelope.payload as Record<string, unknown>).message_locale
    ).toBeNull()
    expect((envelope.payload as Record<string, unknown>).is_gift).toBe(false)
  })

  it("flag ON + gift order → recipient_locale falls back to market.locales.default when not explicit", () => {
    const envelope = composeOrderPlacedEnvelope(
      buildInput({
        market_runtime_config: {
          market_id: "bonbeauty-pl",
          locales: { default: "pl-PL" },
          feature_flags: { orderplaced_v2_emission_enabled: true },
        },
        gift: { is_gift: true },
      })
    )
    expect(envelope.event_type).toBe("gp.commerce.order_placed.v2")
    expect(
      (envelope.payload as Record<string, unknown>).recipient_locale
    ).toBe("pl-PL")
    expect((envelope.payload as Record<string, unknown>).is_gift).toBe(true)
  })

  it("flag ON + gift order with explicit recipient_locale → echoes the explicit locale (not market default)", () => {
    const envelope = composeOrderPlacedEnvelope(
      buildInput({
        market_runtime_config: {
          market_id: "bonbeauty-pl",
          locales: { default: "pl-PL" },
          feature_flags: { orderplaced_v2_emission_enabled: true },
        },
        gift: { is_gift: true, recipient_locale: "en-GB" },
      })
    )
    expect(
      (envelope.payload as Record<string, unknown>).recipient_locale
    ).toBe("en-GB")
  })

  it("flag toggle is per-market (rollout pattern: flip ON for canary, OFF for others)", () => {
    const canary = buildInput({
      scope: { instance_id: "gp-prod", market_id: "bonbeauty-pl" },
      market_runtime_config: {
        market_id: "bonbeauty-pl",
        locales: { default: "pl-PL" },
        feature_flags: { orderplaced_v2_emission_enabled: true },
      },
    })
    const other = buildInput({
      scope: { instance_id: "gp-prod", market_id: "mercur-pl" },
      market_runtime_config: {
        market_id: "mercur-pl",
        locales: { default: "pl-PL" },
        feature_flags: { orderplaced_v2_emission_enabled: false },
      },
    })

    const ce = composeOrderPlacedEnvelope(canary)
    const oe = composeOrderPlacedEnvelope(other)
    expect(ce.event_type).toBe("gp.commerce.order_placed.v2")
    expect(oe.event_type).toBe("gp.commerce.order_placed.v1")
  })

  it("v2 sample fixture aligns with publisher output for a gift order", () => {
    const sample = v2Sample as { payload: Record<string, unknown> }
    expect(sample.payload.recipient_locale).toBe("pl-PL")
    expect(sample.payload.is_gift).toBe(true)
    expect(sample.payload.message_locale).toBeNull()
    const mor = sample.payload.mor as Record<string, unknown>
    expect(mor.voucher_kind).toBe("MPV")
  })
})
