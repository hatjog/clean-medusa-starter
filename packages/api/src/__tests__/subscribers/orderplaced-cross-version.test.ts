/**
 * STORY-MIG-B AC #5 — Cross-version subscriber regression test.
 *
 * Matrix:
 *   1. v1 payload → v2-aware subscriber: defaults applied, no throw.
 *   2. v2 payload → v1-only subscriber:  v2-only fields ignored, core
 *      processing succeeds.
 *   3. v2 gift payload → v2-aware subscriber: recipient_locale +
 *      message_locale resolved per resolution rule (P-09 / D-58).
 *
 * The "v1-only subscriber" is simulated by a thin wrapper that strictly types
 * the legacy payload shape (no `mor`, no locale fields). The wrapper running
 * against a v2 payload demonstrates that v2 fields don't break v1 readers.
 *
 * Invocation:
 *   cd GP/backend && yarn test:unit -- src/__tests__/subscribers/orderplaced-cross-version.test.ts
 */

import { describe, it, expect, jest } from "@jest/globals"

import onOrderCompleted from "../../subscribers/on-order-completed"
import { NotImplementedError } from "../../modules/gp-core/service"

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

function buildContainer(overrides?: {
  gpCore?: { createEntitlement: jest.Mock } | null
}) {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
  const gpCore =
    overrides?.gpCore !== undefined
      ? overrides.gpCore
      : {
          createEntitlement: jest
            .fn<(dto: unknown) => Promise<unknown>>()
            .mockRejectedValue(new NotImplementedError("Story 1.3")),
        }
  return {
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "gp_core") return gpCore
      return null
    }),
    logger,
    gpCore,
  }
}

describe("STORY-MIG-B AC #5 — cross-version OrderPlaced subscribers", () => {
  it("v1 payload → v2-aware subscriber: optional-chained reads default to null/false", async () => {
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

    expect(container.gpCore!.createEntitlement).toHaveBeenCalledTimes(1)
    expect(container.gpCore!.createEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: v1Payload.order_id,
        recipient_locale: null,
        message_locale: null,
        is_gift: false,
        voucher_kind: "none",
      })
    )
    expect(container.logger.error).not.toHaveBeenCalled()
  })

  it("v2 payload → v1-only subscriber: v2 fields ignored, core fields processed", () => {
    const v2Payload = (v2Sample as { payload: Record<string, unknown> }).payload
    const result = v1OnlySubscriber(v2Payload as unknown as V1OnlyPayload)
    expect(result.order_id).toBe(v2Payload.order_id)
    expect(result.total_amount_minor).toBe(v2Payload.total_amount_minor)
    expect(result.line_count).toBeGreaterThan(0)
  })

  it("v2 gift payload → v2-aware subscriber: recipient_locale + is_gift propagated to entitlement DTO", async () => {
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

    expect(container.gpCore!.createEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: v2Payload.order_id,
        recipient_locale: "pl-PL",
        is_gift: true,
        voucher_kind: "MPV",
      })
    )
  })

  it("v2 payload with null message_locale falls back to recipient_locale per P-09 resolution rule", async () => {
    const container = buildContainer()
    await onOrderCompleted({
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

    expect(container.gpCore!.createEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient_locale: "en-GB",
        message_locale: "en-GB",
      })
    )
  })

  it("v1-only subscriber does not throw when handed a v2 payload (regression for D-50 backward-compat)", () => {
    const v2Payload = (v2Sample as { payload: Record<string, unknown> }).payload
    expect(() =>
      v1OnlySubscriber(v2Payload as unknown as V1OnlyPayload)
    ).not.toThrow()
  })
})
