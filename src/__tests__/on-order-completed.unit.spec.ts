import { describe, it, expect, vi, beforeEach } from "vitest"

import onOrderCompleted from "../subscribers/on-order-completed"
import { NotImplementedError } from "../modules/gp-core/service"

function buildMockContainer(overrides: {
  gpCore?: Record<string, unknown> | null
  logger?: Record<string, unknown>
} = {}) {
  const logger = overrides.logger ?? {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const gpCore = overrides.gpCore !== undefined ? overrides.gpCore : {
    createEntitlement: vi.fn().mockRejectedValue(new NotImplementedError("Story 1.3")),
  }

  return {
    resolve: vi.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "gp_core") return gpCore
      return null
    }),
    logger,
    gpCore,
  }
}

function buildEvent(data: Record<string, unknown>) {
  return {
    name: "order.placed",
    data,
    metadata: {},
  }
}

describe("on-order-completed subscriber", () => {
  it("handles Mercur payload format (order_ids array)", async () => {
    const container = buildMockContainer()
    await onOrderCompleted({
      event: buildEvent({ order_ids: ["ord-1", "ord-2"] }),
      container,
    } as any)

    expect(container.gpCore!.createEntitlement).toHaveBeenCalledTimes(2)
    expect(container.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("stub")
    )
  })

  it("handles standard MedusaJS payload format (single id)", async () => {
    const container = buildMockContainer()
    await onOrderCompleted({
      event: buildEvent({ id: "ord-single" }),
      container,
    } as any)

    expect(container.gpCore!.createEntitlement).toHaveBeenCalledTimes(1)
    expect(container.gpCore!.createEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({ order_id: "ord-single" })
    )
  })

  it("skips when no order IDs in payload", async () => {
    const container = buildMockContainer()
    await onOrderCompleted({
      event: buildEvent({}),
      container,
    } as any)

    expect(container.gpCore!.createEntitlement).not.toHaveBeenCalled()
    expect(container.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no order IDs")
    )
  })

  it("logs NotImplementedError as warn, not error", async () => {
    const container = buildMockContainer()
    await onOrderCompleted({
      event: buildEvent({ order_ids: ["ord-1"] }),
      container,
    } as any)

    expect(container.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("stub")
    )
    expect(container.logger.error).not.toHaveBeenCalled()
  })

  it("logs unexpected errors as error", async () => {
    const container = buildMockContainer({
      gpCore: {
        createEntitlement: vi.fn().mockRejectedValue(new Error("DB down")),
      },
    })

    await onOrderCompleted({
      event: buildEvent({ order_ids: ["ord-1"] }),
      container,
    } as any)

    expect(container.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("DB down")
    )
  })

  it("continues processing remaining orders if one fails", async () => {
    const createEntitlement = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockRejectedValueOnce(new NotImplementedError("Story 1.3"))
    const container = buildMockContainer({
      gpCore: { createEntitlement },
    })

    await onOrderCompleted({
      event: buildEvent({ order_ids: ["ord-1", "ord-2"] }),
      container,
    } as any)

    expect(createEntitlement).toHaveBeenCalledTimes(2)
  })

  it("skips gracefully when GpCoreService not available", async () => {
    const container = buildMockContainer({ gpCore: null })
    await onOrderCompleted({
      event: buildEvent({ order_ids: ["ord-1"] }),
      container,
    } as any)

    expect(container.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not available")
    )
  })

  it("does not throw — subscriber errors are caught", async () => {
    const container = buildMockContainer({
      gpCore: {
        createEntitlement: vi.fn().mockRejectedValue(new Error("catastrophic")),
      },
    })

    await expect(
      onOrderCompleted({
        event: buildEvent({ order_ids: ["ord-1"] }),
        container,
      } as any)
    ).resolves.toBeUndefined()
  })
})
