import { describe, it, expect, jest } from "@jest/globals"

import onOrderCompleted from "../subscribers/on-order-completed"

/**
 * v1.9.0 wf5 H-8 / CC-1 F-CC1-001 (DEC-A Option 2, ra-E9):
 *
 * The `on-order-completed` subscriber is now a NO-OP marker. The previous
 * implementation called `gpCore.createEntitlement(...)` which threw
 * `NotImplementedError` and produced a `[gp_core] order.placed —
 * createEntitlement stub` warn line that misled the Wave-B agent into
 * reimplementing 787 lines in the wrong ADR-052 deprecation layer.
 *
 * This test suite locks in the no-op contract:
 *   - subscriber logs a single info breadcrumb with order count
 *   - NEVER calls gp_core / createEntitlement (call removed entirely)
 *   - NEVER emits the misleading "stub" warn line again (Wave-B recurrence)
 *   - returns cleanly for all payload shapes (Mercur / standard / v1 / v2)
 */
function buildMockContainer() {
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

function buildEvent(data: Record<string, unknown>) {
  return {
    name: "order.placed",
    data,
    metadata: {},
  }
}

describe("on-order-completed subscriber (v1.9.0 wf5 no-op breadcrumb)", () => {
  it("emits a single info breadcrumb with order count for Mercur payload", async () => {
    const container = buildMockContainer()
    await onOrderCompleted({
      event: buildEvent({ order_ids: ["ord-1", "ord-2"] }),
      container,
    } as any)

    expect(container.logger.info).toHaveBeenCalledTimes(1)
    expect(container.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("order_count=2")
    )
    expect(container.logger.warn).not.toHaveBeenCalled()
    expect(container.logger.error).not.toHaveBeenCalled()
  })

  it("emits a single info breadcrumb for standard MedusaJS payload (single id)", async () => {
    const container = buildMockContainer()
    await onOrderCompleted({
      event: buildEvent({ id: "ord-single" }),
      container,
    } as any)

    expect(container.logger.info).toHaveBeenCalledTimes(1)
    expect(container.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("order_count=1")
    )
  })

  it("emits a single info breadcrumb for v2 envelope (order_id + mor)", async () => {
    const container = buildMockContainer()
    await onOrderCompleted({
      event: buildEvent({
        order_id: "ord-v2",
        mor: { voucher_kind: "SPV" },
      }),
      container,
    } as any)

    expect(container.logger.info).toHaveBeenCalledTimes(1)
    expect(container.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("order_count=1")
    )
  })

  it("handles empty payload without throwing or emitting warn", async () => {
    const container = buildMockContainer()
    await expect(
      onOrderCompleted({
        event: buildEvent({}),
        container,
      } as any)
    ).resolves.toBeUndefined()
    expect(container.logger.info).toHaveBeenCalledTimes(1)
    expect(container.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("order_count=0")
    )
  })

  it("NEVER emits the Wave-B 'createEntitlement stub' warn line (regression guard)", async () => {
    const container = buildMockContainer()
    await onOrderCompleted({
      event: buildEvent({ order_ids: ["ord-1"] }),
      container,
    } as any)

    expect(container.logger.warn).not.toHaveBeenCalled()
    expect(container.logger.info).toHaveBeenCalledWith(
      expect.not.stringContaining("createEntitlement stub")
    )
    expect(container.logger.info).toHaveBeenCalledWith(
      expect.not.stringContaining("entitlement created for order")
    )
  })

  it("NEVER calls gp_core service (call removed entirely per H-8 fix)", async () => {
    const resolve = jest.fn((key: string) => {
      if (key === "logger") return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      // If anything looks up gp_core, the test fails.
      if (key === "gp_core") {
        throw new Error(
          "REGRESSION: on-order-completed must NEVER resolve gp_core (Wave-B recurrence guard)"
        )
      }
      return null
    })

    await expect(
      onOrderCompleted({
        event: buildEvent({ order_ids: ["ord-1"] }),
        container: { resolve, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } },
      } as any)
    ).resolves.toBeUndefined()

    // Assert resolve was never called with "gp_core".
    const gpCoreCalls = resolve.mock.calls.filter((c) => c[0] === "gp_core")
    expect(gpCoreCalls).toEqual([])
  })

  it("does not throw on any payload shape — subscriber errors are confined", async () => {
    const container = buildMockContainer()
    await expect(
      onOrderCompleted({
        event: buildEvent({ order_ids: ["ord-1"] }),
        container,
      } as any)
    ).resolves.toBeUndefined()
  })
})
