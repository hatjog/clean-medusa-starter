import { describe, it, expect, jest, beforeEach } from "@jest/globals"

import onOrderCompleted from "../subscribers/on-order-completed"
import { NotImplementedError } from "../modules/gp-core/service"

function buildMockContainer(overrides: {
  gpCore?: Record<string, unknown> | null
  logger?: Record<string, unknown>
} = {}) {
  const logger = overrides.logger ?? {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }

  // Story 1.10 (ADR-118 Path Y): createEntitlement is now implemented end-to-end.
  // The default mock therefore RESOLVES with a synthetic ACTIVE entitlement, and
  // tests that need to exercise the legacy NotImplementedError path override the
  // mock explicitly.
  const gpCore = overrides.gpCore !== undefined ? overrides.gpCore : {
    createEntitlement: (jest.fn() as any).mockResolvedValue({
      id: "ent-default",
      status: "ACTIVE",
      order_id: "ord-default",
    }),
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
    // Story 1.10: subscriber now logs success (info) rather than the legacy
    // NotImplementedError stub warning. Error path must remain quiet.
    expect(container.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("entitlement created")
    )
    expect(container.logger.error).not.toHaveBeenCalled()
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

  it("logs legacy NotImplementedError fallback as warn, not error", async () => {
    // Regression coverage: until ADR-118 Path Y is fully rolled out everywhere,
    // a downstream gp_core surface MAY still throw NotImplementedError. The
    // subscriber must not escalate it to an error log because that would burn
    // operator pager budget for a known-deferred branch.
    const container = buildMockContainer({
      gpCore: {
        createEntitlement: (jest.fn() as any).mockRejectedValue(
          new NotImplementedError("Story 1.3")
        ),
      },
    })
    await onOrderCompleted({
      event: buildEvent({ order_ids: ["ord-1"] }),
      container,
    } as any)

    expect(container.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("stub")
    )
    expect(container.logger.error).not.toHaveBeenCalled()
  })

  it("logs entitlement creation success for each order (Story 1.10)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createEntitlement = (jest.fn() as any).mockResolvedValue({
      id: "ent-success",
      status: "ACTIVE",
      order_id: "ord-success",
    })
    const container = buildMockContainer({
      gpCore: { createEntitlement },
    })

    await onOrderCompleted({
      event: buildEvent({ order_ids: ["ord-1", "ord-2"] }),
      container,
    } as any)

    expect(createEntitlement).toHaveBeenCalledTimes(2)
    // First call carries the canonical payload + v2 fallback defaults.
    expect(createEntitlement).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        order_id: "ord-1",
        recipient_locale: null,
        message_locale: null,
        is_gift: false,
        voucher_kind: "none",
      })
    )
    expect(container.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("entitlement created for order ord-1")
    )
    expect(container.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("entitlement created for order ord-2")
    )
    expect(container.logger.error).not.toHaveBeenCalled()
  })

  it("subscriber is idempotent on repeat dispatch (same order_id, two invocations)", async () => {
    // The subscriber MAY be invoked twice for the same order in failure-retry
    // scenarios. gp_core.createEntitlement is itself idempotent on
    // (order_id, line_item_id), so the subscriber simply forwards both calls
    // and the underlying ON CONFLICT keeps state stable. We assert the call
    // shape is identical across invocations (no clock-dependent inputs).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createEntitlement = (jest.fn() as any).mockResolvedValue({
      id: "ent-idem",
      status: "ACTIVE",
      order_id: "ord-idem",
    })
    const container = buildMockContainer({
      gpCore: { createEntitlement },
    })

    const payload = buildEvent({ order_ids: ["ord-idem"] })
    await onOrderCompleted({ event: payload, container } as any)
    await onOrderCompleted({ event: payload, container } as any)

    expect(createEntitlement).toHaveBeenCalledTimes(2)
    expect(createEntitlement.mock.calls[0][0]).toEqual(
      createEntitlement.mock.calls[1][0]
    )
  })

  it("logs unexpected errors as error", async () => {
    const container = buildMockContainer({
      gpCore: {
        createEntitlement: (jest.fn() as any).mockRejectedValue(new Error("DB down")),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createEntitlement = (jest.fn() as any)
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
        createEntitlement: (jest.fn() as any).mockRejectedValue(new Error("catastrophic")),
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
