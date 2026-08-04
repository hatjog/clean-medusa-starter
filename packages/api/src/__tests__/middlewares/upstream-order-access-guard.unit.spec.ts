/**
 * upstream-order-access-guard.unit.spec.ts
 *
 * Upstreamowy `GET /store/orders/:id` jest w Medusie BEZ `authenticate` —
 * `order_id` dziala jak capability, wiec kazdy, kto go zna, odczytuje pozycje
 * zamowienia i adres e-mail kupujacej. Ten guard wyrownuje prog W GORE do
 * poziomu GP-owego `payment-status` (sesja ALBO dowod koszyka).
 *
 * Testy sa pisane wokol ODMOWY, nie wokol zgody: bramka dostepu, ktorej nikt
 * nie zmusil do odmowy, jest nieodrozninalna od braku bramki.
 */
import { Modules } from "@medusajs/framework/utils"

import {
  extractOrderId,
  upstreamOrderAccessGuardMiddleware,
} from "../../api/middlewares/upstream-order-access-guard"

type Captured = { status?: number; body?: any; passed: boolean }

function makeReq(options: {
  orderId?: string
  path?: string
  customerId?: string | null
  cartId?: string
  orderCustomerId?: string | null
  orderMissing?: boolean
  cartProducedOrder?: boolean
}) {
  const {
    orderId = "ord_1",
    customerId = null,
    cartId,
    orderCustomerId = null,
    orderMissing = false,
    cartProducedOrder = false,
  } = options

  return {
    params: { id: orderId },
    path: options.path ?? `/store/orders/${orderId}`,
    query: cartId === undefined ? {} : { cart_id: cartId },
    auth_context: customerId ? { actor_id: customerId } : undefined,
    scope: {
      resolve: (key: string) => {
        if (key === Modules.ORDER) {
          return {
            retrieveOrder: async () => {
              if (orderMissing) throw new Error("not found")
              return { id: orderId, customer_id: orderCustomerId }
            },
          }
        }
        if (key === "logger") {
          return { info: () => undefined, warn: () => undefined }
        }
        // `assertOrderAccess` siega po polaczenie tylko dla sciezki dowodu.
        return {
          raw: async () => ({ rows: cartProducedOrder ? [{ "?column?": 1 }] : [] }),
        }
      },
    },
  } as never
}

async function run(req: unknown): Promise<Captured> {
  const captured: Captured = { passed: false }
  const res = {
    status(code: number) {
      captured.status = code
      return this
    },
    json(body: any) {
      captured.body = body
      return this
    },
  } as never
  await upstreamOrderAccessGuardMiddleware(req as never, res, (() => {
    captured.passed = true
  }) as never)
  return captured
}

describe("upstreamOrderAccessGuardMiddleware", () => {
  it("RDZEN: anonim znajacy `order_id` NIE dostaje zamowienia (401)", async () => {
    // Przed wyrownaniem ta sama sytuacja oddawala pozycje i e-mail kupujacej.
    const out = await run(makeReq({}))

    expect(out.passed).toBe(false)
    expect(out.status).toBe(401)
  })

  it("wlascicielka z sesja przechodzi", async () => {
    const out = await run(
      makeReq({ customerId: "cus_1", orderCustomerId: "cus_1" }),
    )
    expect(out.passed).toBe(true)
    expect(out.status).toBeUndefined()
  })

  it("gosc z dowodem koszyka, ktory WYPRODUKOWAL to zamowienie, przechodzi", async () => {
    const out = await run(makeReq({ cartId: "cart_1", cartProducedOrder: true }))
    expect(out.passed).toBe(true)
  })

  it("gosc z dowodem koszyka, ktory NIE wyprodukowal zamowienia, dostaje 401", async () => {
    const out = await run(makeReq({ cartId: "cart_obcy", cartProducedOrder: false }))
    expect(out.passed).toBe(false)
    expect(out.status).toBe(401)
  })

  it("zalogowana z CUDZYM zamowieniem dostaje 404, nie 403", async () => {
    // 403 potwierdzalby istnienie cudzego zasobu — trasa stalaby sie wyrocznia.
    const out = await run(
      makeReq({ customerId: "cus_1", orderCustomerId: "cus_INNY" }),
    )
    expect(out.passed).toBe(false)
    expect(out.status).toBe(404)
  })

  it("nieistniejace zamowienie wyglada TAK SAMO jak brak uprawnien (404)", async () => {
    const out = await run(
      makeReq({ customerId: "cus_1", orderMissing: true }),
    )
    expect(out.passed).toBe(false)
    expect(out.status).toBe(404)
  })

  it("anonim bez sesji i bez dowodu jest odrzucany BEZ dotykania bazy", async () => {
    let touchedDb = false
    const req = {
      params: { id: "ord_1" },
      path: "/store/orders/ord_1",
      query: {},
      scope: {
        resolve: (key: string) => {
          if (key === Modules.ORDER) {
            touchedDb = true
            return { retrieveOrder: async () => ({ id: "ord_1", customer_id: null }) }
          }
          return { info: () => undefined, warn: () => undefined }
        },
      },
    } as never

    const out = await run(req)

    expect(out.status).toBe(401)
    expect(touchedDb).toBe(false)
  })

  it("trasa listowa `/store/orders` nie jest przedmiotem tej decyzji — przepuszczamy", async () => {
    const req = {
      params: {},
      path: "/store/orders",
      query: {},
      scope: { resolve: () => ({ info: () => undefined, warn: () => undefined }) },
    } as never

    const out = await run(req)
    expect(out.passed).toBe(true)
  })

  describe("extractOrderId", () => {
    it("czyta id z params, gdy juz sa wypelnione", () => {
      expect(extractOrderId({ params: { id: "ord_params" } } as never)).toBe("ord_params")
    })

    it("czyta id ze SCIEZKI, gdy params sa jeszcze puste", () => {
      // Middleware biegnie na matcherze, wiec `params` bywa niewypelnione.
      expect(
        extractOrderId({ params: {}, path: "/store/orders/ord_path" } as never),
      ).toBe("ord_path")
    })

    it("obsluguje podsciezke i query string", () => {
      expect(
        extractOrderId({
          params: {},
          path: "/store/orders/ord_x/payment-status?cart_id=c1",
        } as never),
      ).toBe("ord_x")
    })

    it("dla trasy listowej zwraca null zamiast zgadywac", () => {
      expect(extractOrderId({ params: {}, path: "/store/orders" } as never)).toBeNull()
    })
  })
})
