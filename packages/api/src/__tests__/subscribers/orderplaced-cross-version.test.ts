/**
 * STORY-MIG-B AC #5 — Cross-version subscriber regression test.
 *
 * v1.9.0 wf5 H-8 / CC-1 F-CC1-001 update: the v2-aware subscriber
 * (`on-order-completed`) is now a NO-OP marker — gpCore.createEntitlement is
 * removed entirely (entitlement creation is owned by `stripe-payment-audit`
 * Path Y workflow per ADR-099 / ADR-118; webhook-before-order race recovery
 * by `on-order-placed-stripe-retry`). The cross-version backward-compat
 * contract still holds: the subscriber MUST accept v1 / standard / v2
 * payloads without throwing. This test suite was rewritten to assert the
 * runtime acceptance posture rather than the obsolete gp_core call.
 *
 * Matrix:
 *   1. v1 payload → v2-aware subscriber: no throw, info breadcrumb.
 *   2. v2 payload → v1-only subscriber:  v2-only fields ignored, core
 *      processing succeeds (unchanged — this is a pure-function check).
 *   3. v2 gift payload → v2-aware subscriber: no throw with mor/recipient
 *      fields present.
 *
 * Invocation:
 *   cd GP/backend && pnpm test:unit --testPathPattern="orderplaced-cross-version"
 */

import { describe, it, expect, jest } from "@jest/globals"

import onOrderCompleted from "../../subscribers/on-order-completed"

import v1Sample from "../fixtures/events/orderplaced-v1-payload.sample.json"
import v2Sample from "../fixtures/events/orderplaced-v2-payload.sample.json"

type V1OnlyPayload = {
  order_id: string
  currency: string
  total_amount_minor: number
  line_items: Array<{ line_item_id: string }>
}

/**
 * Strict v1-only subscriber. Reads only fields present in the v1 schema.
 * If the payload is v2, v2-only fields are silently dropped because TypeScript
 * narrows to V1OnlyPayload. We assert at runtime that no exception is thrown
 * and core fields are processed.
 */
function v1OnlySubscriber(payload: V1OnlyPayload): {
  order_id: string
  total_amount_minor: number
  line_count: number
} {
  return {
    order_id: payload.order_id,
    total_amount_minor: payload.total_amount_minor,
    line_count: payload.line_items.length,
  }
}

function buildContainer() {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
  return {
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      return null
    }),
    logger,
  }
}

describe("STORY-MIG-B AC #5 — cross-version OrderPlaced subscribers", () => {
  it("v1 payload → v2-aware no-op subscriber: info breadcrumb, no throw", async () => {
    const container = buildContainer()
    const v1Payload = (v1Sample as { payload: Record<string, unknown> }).payload
    await onOrderCompleted({
      event: {
        name: "order.placed",
        data: { order_id: v1Payload.order_id as string },
        metadata: {},
      },
      container,
    } as any)

    expect(container.logger.error).not.toHaveBeenCalled()
    expect(container.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("order_count=1")
    )
  })

  it("v2 payload → v1-only subscriber: v2 fields ignored, core fields processed", () => {
    const v2Payload = (v2Sample as { payload: Record<string, unknown> }).payload
    const result = v1OnlySubscriber(v2Payload as unknown as V1OnlyPayload)
    expect(result.order_id).toBe(v2Payload.order_id)
    expect(result.total_amount_minor).toBe(v2Payload.total_amount_minor)
    expect(result.line_count).toBeGreaterThan(0)
  })

  it("v2 gift payload → v2-aware no-op subscriber: no throw, info breadcrumb only", async () => {
    const container = buildContainer()
    const v2Payload = (v2Sample as { payload: Record<string, unknown> }).payload
    await onOrderCompleted({
      event: {
        name: "order.placed",
        data: {
          order_id: v2Payload.order_id as string,
          recipient_locale: v2Payload.recipient_locale as string | null,
          message_locale: v2Payload.message_locale as string | null,
          is_gift: v2Payload.is_gift as boolean,
          mor: v2Payload.mor as any,
        },
        metadata: {},
      },
      container,
    } as any)

    expect(container.logger.error).not.toHaveBeenCalled()
    expect(container.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("order_count=1")
    )
  })

  it("v2 payload with null message_locale → subscriber tolerates the shape without throw", async () => {
    const container = buildContainer()
    await expect(
      onOrderCompleted({
        event: {
          name: "order.placed",
          data: {
            order_id: "ord-fallback",
            recipient_locale: "en-GB",
            message_locale: null,
            is_gift: true,
            mor: {
              sale_mor: "operator",
              service_mor: "vendor",
              mor_policy_version: "1.0.0",
              voucher_kind: "MPV",
              breakage_policy_snapshot: {},
            },
          },
          metadata: {},
        },
        container,
      } as any)
    ).resolves.toBeUndefined()
  })

  it("v1-only subscriber does not throw when handed a v2 payload (regression for D-50 backward-compat)", () => {
    const v2Payload = (v2Sample as { payload: Record<string, unknown> }).payload
    expect(() =>
      v1OnlySubscriber(v2Payload as unknown as V1OnlyPayload)
    ).not.toThrow()
  })
})
