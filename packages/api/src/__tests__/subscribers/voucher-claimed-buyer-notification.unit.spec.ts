import { describe, it, expect, jest } from "@jest/globals"
import { Modules } from "@medusajs/framework/utils"
import fs from "node:fs"
import path from "node:path"

import voucherClaimedBuyerNotification, {
  handleVoucherClaimedForBuyerNotification,
} from "../../subscribers/voucher-claimed-buyer-notification"
import { VOUCHER_MODULE } from "../../modules/voucher"

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

function buildContainer(
  voucherService: { findBuyerClaimSource: jest.Mock },
  notificationModule: Record<string, unknown>,
) {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
  return {
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === VOUCHER_MODULE) return voucherService
      if (key === Modules.NOTIFICATION) return notificationModule
      throw new Error(`Unexpected container key: ${key}`)
    }),
    logger,
  }
}

describe("voucher-claimed-buyer-notification subscriber", () => {
  it("reads Layer 4 source via VoucherService.findBuyerClaimSource and dispatches buyer email", async () => {
    const findBuyerClaimSource = jest.fn(async () => ({
      buyer_email: "buyer@example.com",
      buyer_locale: "pl",
      seller_name: "BonBeauty Mokotow",
      seller_handle: "bonbeauty-mokotow",
      service_title: "Masaz twarzy",
      claimed_at: "2026-05-28T10:00:00.000Z",
      voucher_code: "BB-2026",
    }))
    const createNotifications = jest.fn(async () => ({ id: "noti_1" }))
    const container = buildContainer(
      { findBuyerClaimSource },
      { createNotifications },
    )

    await voucherClaimedBuyerNotification({
      event: buildEvent({
        voucher_id: "ent_inst_1",
        voucher_code: "BB-2026",
        claimed_at: "2026-05-28T10:00:00.000Z",
      }),
      container,
    } as any)

    expect(findBuyerClaimSource).toHaveBeenCalledWith("ent_inst_1", "BB-2026")
    expect(createNotifications).toHaveBeenCalledTimes(1)
    const notificationCalls = createNotifications.mock.calls as unknown as Array<
      [Record<string, any>]
    >
    const dispatched = notificationCalls[0][0]
    expect(dispatched.to).toBe("buyer@example.com")
    expect(dispatched.data.locale).toBe("pl")
    expect(dispatched.data.voucher_id).toBe("ent_inst_1")
  })

  it("falls back to event payload voucher_code when service returns null voucher_code", async () => {
    const findBuyerClaimSource = jest.fn(async () => ({
      buyer_email: "buyer2@example.com",
      buyer_locale: null,
      seller_name: "Seller B",
      seller_handle: "seller-b",
      service_title: "Service B",
      claimed_at: null,
      voucher_code: null,
    }))
    const createNotifications = jest.fn(async () => ({ id: "noti_fb" }))

    const container = buildContainer(
      { findBuyerClaimSource },
      { createNotifications },
    )

    await voucherClaimedBuyerNotification({
      event: buildEvent({
        voucher_id: "ent_inst_fb",
        voucher_code: "FB-VC",
        claimed_at: "2026-05-28T12:00:00.000Z",
      }),
      container,
    } as any)

    expect(findBuyerClaimSource).toHaveBeenCalledWith("ent_inst_fb", "FB-VC")
    expect(createNotifications).toHaveBeenCalledTimes(1)
    const notificationCalls = createNotifications.mock.calls as unknown as Array<
      [Record<string, any>]
    >
    const dispatched = notificationCalls[0][0]
    // F-2-01 phase-3 fix: assert the event-payload fallback projects into
    // the rendered notification body when VoucherService returns null
    // voucher_code (source.voucher_code ?? eventPayload.voucher_code path).
    // The voucher_code is hydrated into the email template (text/html),
    // not dispatched as a top-level data field — see i18n.ts hydrate step.
    expect(typeof dispatched.data.text).toBe("string")
    expect(dispatched.data.text).toContain("FB-VC")
    expect(dispatched.data.html).toContain("FB-VC")
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

  it("projects buyer_locale from VoucherService source (Story 9.3 review F-08)", async () => {
    const dispatch = jest.fn(async () => ({ notificationId: "noti_loc" }))

    const entry = await handleVoucherClaimedForBuyerNotification(
      { voucher_id: "ent_inst_locale" },
      {
        fetcher: {
          fetchVoucherClaimSource: jest.fn(async () => ({
            buyer_email: "buyer.en@example.com",
            buyer_locale: "en",
            seller_name: "Seller EN",
            seller_handle: "seller-en",
            service_title: "Service EN",
            claimed_at: "2026-05-28T13:00:00.000Z",
            voucher_code: "EN-VC",
          })),
        },
        dispatcher: { dispatch },
      },
    )

    expect(entry.status).toBe("sent")
    expect(entry.locale).toBe("en")
  })

  it("keeps subscriber source free of ADR-052 legacy runtime callsites", () => {
    const source = fs.readFileSync(subscriberSourcePath, "utf8")

    expect(source).not.toMatch(/FROM gp_core\.entitlements\b/)
    expect(source).not.toMatch(/GpCoreService\.createEntitlement\b/)
    expect(source).not.toMatch(/JOIN gp_core\.entitlements\b/)
  })
})
