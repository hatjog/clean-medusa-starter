import { describe, it, expect, jest } from "@jest/globals"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import fs from "node:fs"
import path from "node:path"

import voucherClaimedBuyerNotification, {
  handleVoucherClaimedForBuyerNotification,
} from "../../subscribers/voucher-claimed-buyer-notification"

const subscriberSourcePath = path.join(
  process.cwd(),
  "packages/api/src/subscribers/voucher-claimed-buyer-notification.ts",
)

function buildEvent(data: Record<string, unknown>) {
  return {
    name: "voucher.claimed",
    data,
    metadata: {},
  }
}

function buildContainer(queryGraph: jest.Mock, notificationModule: Record<string, unknown>) {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
  return {
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === ContainerRegistrationKeys.QUERY) return { graph: queryGraph }
      if (key === Modules.NOTIFICATION) return notificationModule
      throw new Error(`Unexpected container key: ${key}`)
    }),
    logger,
  }
}

describe("voucher-claimed-buyer-notification subscriber", () => {
  it("reads Layer 4 entitlement_instance through query.graph and dispatches buyer email", async () => {
    const queryGraph = jest.fn(async () => ({
      data: [
        {
          id: "ent_inst_1",
          buyer_email: "buyer@example.com",
          claimed_at: "2026-05-28T10:00:00.000Z",
          policy_snapshot: { voucher_code: "BB-2026" },
          seller: { name: "BonBeauty Mokotow", handle: "bonbeauty-mokotow" },
          product: { title: "Masaz twarzy" },
          voucher: { code: "BB-2026" },
        },
      ],
    }))
    const createNotifications = jest.fn(async () => ({ id: "noti_1" }))
    const container = buildContainer(queryGraph, { createNotifications })

    await voucherClaimedBuyerNotification({
      event: buildEvent({
        voucher_id: "ent_inst_1",
        voucher_code: "BB-2026",
        claimed_at: "2026-05-28T10:00:00.000Z",
      }),
      container,
    } as any)

    expect(queryGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "entitlement_instance",
        fields: expect.arrayContaining([
          "seller.name",
          "seller.handle",
          "product.title",
          "voucher.code",
        ]),
      }),
    )
    expect(createNotifications).toHaveBeenCalledTimes(1)
    const notificationCalls = createNotifications.mock.calls as unknown as Array<
      [Record<string, any>]
    >
    const dispatched = notificationCalls[0][0]
    expect(dispatched.to).toBe("buyer@example.com")
    expect(dispatched.data.locale).toBe("pl")
    expect(dispatched.data.voucher_id).toBe("ent_inst_1")
  })

  it("returns failed audit entry when entitlement_instance is missing", async () => {
    const entry = await handleVoucherClaimedForBuyerNotification(
      { voucher_id: "missing-voucher" },
      {
        fetcher: { fetchVoucherClaimSource: jest.fn(async () => null) },
      },
    )

    expect(entry.status).toBe("failed")
    expect(entry.error_message).toBe("voucher source not found")
    expect(entry.email_to).toBeNull()
  })

  it("keeps AR45 recipient fields out of dispatched notification payload", async () => {
    const dispatch = jest.fn(async () => ({ notificationId: "noti_2" }))

    const entry = await handleVoucherClaimedForBuyerNotification(
      { voucher_id: "ent_inst_privacy" },
      {
        fetcher: {
          fetchVoucherClaimSource: jest.fn(async () => ({
            buyer_email: "buyer@example.com",
            buyer_locale: "en",
            seller_name: "BonBeauty Centrum",
            seller_handle: "bonbeauty-centrum",
            service_title: "Voucher SPA",
            claimed_at: "2026-05-28T11:00:00.000Z",
            voucher_code: "BB-PRIV",
            recipient_email: "recipient@example.com",
            recipient_first_name: "Anna",
          } as any)),
        },
        dispatcher: { dispatch },
      },
    )

    expect(entry.status).toBe("sent")
    const dispatchCalls = dispatch.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >
    const payload = JSON.stringify(dispatchCalls[0][0])
    expect(payload).not.toContain("recipient_email")
    expect(payload).not.toContain("recipient_first_name")
    expect(payload).not.toContain("recipient@example.com")
  })

  it("keeps subscriber source free of ADR-052 legacy runtime callsites", () => {
    const source = fs.readFileSync(subscriberSourcePath, "utf8")

    expect(source).not.toMatch(/FROM gp_core\.entitlements\b/)
    expect(source).not.toMatch(/GpCoreService\.createEntitlement\b/)
    expect(source).not.toMatch(/JOIN gp_core\.entitlements\b/)
  })
})
