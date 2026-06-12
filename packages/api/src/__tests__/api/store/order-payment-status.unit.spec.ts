import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  resolveOrderByCartId,
  retrieveOrderByStatusIdentifier,
} from "../../../api/store/orders/[id]/payment-status/helpers"

describe("order payment-status identifier resolution", () => {
  it("resolves cart.id to the backend order id for payment-status lookups", async () => {
    const req = {
      scope: {
        resolve: (key: string) => {
          if (key === ContainerRegistrationKeys.PG_CONNECTION) {
            return {
              raw: async () => ({
                rows: [{ id: "ord_123" }],
              }),
            }
          }
          throw new Error(`unexpected resolve ${key}`)
        },
      },
    } as any

    await expect(resolveOrderByCartId(req, "cart_123")).resolves.toBe("ord_123")
  })

  it("falls back from cart.id to order lookup when direct retrieveOrder misses", async () => {
    const retrieveOrder = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "ord_123",
        customer_id: "cus_1",
        payment_status: "captured",
        status: "completed",
        created_at: "2026-05-17T10:00:00.000Z",
        sales_channel_id: "sc_1",
      })

    const req = {
      scope: {
        resolve: (key: string) => {
          if (key === ContainerRegistrationKeys.PG_CONNECTION) {
            return {
              raw: async () => ({
                rows: [{ id: "ord_123" }],
              }),
            }
          }
          throw new Error(`unexpected resolve ${key}`)
        },
      },
    } as any

    const order = await retrieveOrderByStatusIdentifier(req, { retrieveOrder }, "cart_123")

    expect(retrieveOrder).toHaveBeenNthCalledWith(
      1,
      "cart_123",
      expect.objectContaining({
        select: expect.arrayContaining(["id", "payment_status"]),
      })
    )
    expect(retrieveOrder).toHaveBeenNthCalledWith(
      2,
      "ord_123",
      expect.objectContaining({
        select: expect.arrayContaining(["id", "payment_status"]),
      })
    )
    expect(order).toMatchObject({ id: "ord_123" })
  })
})
