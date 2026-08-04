import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

const runOrderDetailWorkflow = jest.fn()
jest.mock("@medusajs/core-flows", () => ({
  // requireActual: podmieniamy JEDEN eksport, nie cały moduł — inaczej każdy
  // przyszły import z core-flows w grafie trasy stałby się `undefined`.
  ...jest.requireActual("@medusajs/core-flows"),
  getOrderDetailWorkflow: () => ({ run: runOrderDetailWorkflow }),
}))

import {
  resolveOrderByCartId,
  retrieveOrderByStatusIdentifier,
  withComputedPaymentStatus,
} from "../../../api/store/orders/[id]/payment-status/helpers"
import { marketContextStorage } from "../../../lib/market-context"
import { GET as paymentStatusGET } from "../../../api/store/orders/[id]/payment-status/route"
import {
  assertOrderAccess,
  parseCartProof,
} from "../../../lib/orders/guest-order-access"

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

describe("guest order access proof", () => {
  /**
   * `rows` steruje odpowiedzią na zapytanie o przynależność koszyka.
   * `capture` pozwala sprawdzić, że pytamy o OBA identyfikatory naraz —
   * to jedyne, co odróżnia test przynależności od „rozwiąż koszyk na zamówienie".
   */
  function makeReq(rows: unknown[], capture?: { sql?: string; bindings?: unknown[] }) {
    return {
      scope: {
        resolve: (key: string) => {
          if (key === ContainerRegistrationKeys.PG_CONNECTION) {
            return {
              raw: async (sql: string, bindings?: ReadonlyArray<unknown>) => {
                if (capture) {
                  capture.sql = sql
                  capture.bindings = bindings ? [...bindings] : []
                }
                // Mock symuluje BAZĘ, nie zgodę: wiersz wraca wyłącznie, gdy
                // zapytanie realnie wiąże order_id ORAZ cart_id. Mock zwracający
                // rows bezwarunkowo przepuszczałby regresję `WHERE cart_id LIMIT 1`,
                // czyli dokładnie ten błąd, którego ten test pilnuje.
                const asksForBoth = /order_id\s*=\s*\?/.test(sql) && /cart_id\s+IN/.test(sql)
                return asksForBoth ? { rows } : { rows: [] }
              },
            }
          }
          throw new Error(`unexpected resolve ${key}`)
        },
      },
    } as any
  }

  const order = { id: "ord_1", customer_id: "cus_owner" }

  it("wpuszcza zalogowaną właścicielkę bez odpytywania bazy", async () => {
    const req = makeReq([])
    await expect(
      assertOrderAccess({ req, order, orderId: "ord_1", customerId: "cus_owner" })
    ).resolves.toEqual({ granted: true, actor: "customer" })
  })

  it("wpuszcza gościa z dowodem koszyka i pyta o oba identyfikatory", async () => {
    const capture: { sql?: string; bindings?: unknown[] } = {}
    const req = makeReq([{ "?column?": 1 }], capture)

    await expect(
      assertOrderAccess({
        req,
        order,
        orderId: "ord_1",
        customerId: undefined,
        proof: { type: "cart", values: ["cart_1"] },
      })
    ).resolves.toEqual({ granted: true, actor: "guest", proof: "cart" })

    expect(capture.bindings).toEqual(["ord_1", "cart_1"])
    expect(capture.sql).toContain("order_id")
    expect(capture.sql).toContain("cart_id")
  })

  it("wpuszcza gościa do KAŻDEGO zamówienia z koszyka multi-seller", async () => {
    // Regresja: dowód rozstrzygany przez `resolveOrderByCartId` (ORDER BY ... LIMIT 1)
    // przyznawał dostęp wyłącznie do najnowszego rodzeństwa. Ten sam koszyk musi
    // otwierać każde zamówienie, które wyprodukował.
    const capture: { sql?: string; bindings?: unknown[] } = {}
    const req = makeReq([{ "?column?": 1 }], capture)

    await expect(
      assertOrderAccess({
        req,
        order: { id: "ord_starszy_brat", customer_id: null },
        orderId: "ord_starszy_brat",
        proof: { type: "cart", values: ["cart_multi"] },
      })
    ).resolves.toEqual({ granted: true, actor: "guest", proof: "cart" })

    expect(capture.bindings).toEqual(["ord_starszy_brat", "cart_multi"])
  })

  it("odrzuca gościa z koszykiem, który nie wyprodukował tego zamówienia", async () => {
    const req = makeReq([])
    await expect(
      assertOrderAccess({
        req,
        order,
        orderId: "ord_1",
        proof: { type: "cart", values: ["cart_obcy"] },
      })
    ).resolves.toEqual({ granted: false, reason: "no_proof" })
  })

  it("odrzuca gościa bez dowodu", async () => {
    const req = makeReq([])
    await expect(
      assertOrderAccess({ req, order, orderId: "ord_1" })
    ).resolves.toEqual({ granted: false, reason: "no_proof" })
  })

  it("odrzuca zalogowaną kupującą z cudzym zamówieniem jako not_owner", async () => {
    const req = makeReq([])
    await expect(
      assertOrderAccess({ req, order, orderId: "ord_1", customerId: "cus_ktos_inny" })
    ).resolves.toEqual({ granted: false, reason: "not_owner" })
  })

  /**
   * Anty-regresja na poziomie TRASY, nie configu middleware'ów. Gdyby ktoś
   * przywrócił twarde `authenticate("customer")` albo wyciął gałąź gościa,
   * asercja na configu nadal by przechodziła — a kupująca bez konta znów
   * dostawałaby 401 na ekranie własnej płatności. Ten test chodzi handlerem.
   */
  it("handler bez auth_context oddaje 200, gdy dowód koszyka się zgadza", async () => {
    const req = {
      params: { id: "ord_1" },
      query: { cart_id: "cart_1" },
      // brak auth_context — dokładnie tak wygląda żądanie gościa
      scope: {
        resolve: (key: string) => {
          if (key === Modules.ORDER) {
            return {
              retrieveOrder: async () => ({
                id: "ord_1",
                customer_id: null,
                payment_status: "captured",
                status: "pending",
                created_at: new Date().toISOString(),
                // Zamowienie MA kanal, bo guard rynku jest fail-closed od
                // 2026-08-01: brak ktorejkolwiek ze stron to odmowa. Produkcja
                // odpowiada temu ksztaltowi — pomiar na bazie dev: 0 z 21
                // zamowien bez `sales_channel_id`.
                sales_channel_id: "sc_1",
              }),
            }
          }
          if (key === ContainerRegistrationKeys.PG_CONNECTION) {
            return {
              raw: async (sql: string) => {
                if (sql.includes("order_cart")) return { rows: [{ "?column?": 1 }] }
                return { rows: [] }
              },
            }
          }
          if (key === "logger") return { info: () => undefined, warn: () => undefined, error: () => undefined }
          throw new Error(`unexpected resolve ${key}`)
        },
      },
    } as any

    const captured: { status?: number; body?: any } = {}
    const res = {
      status(code: number) {
        captured.status = code
        return this
      },
      json(body: any) {
        captured.body = body
        return this
      },
    } as any

    // `/store/*` przechodzi przez `marketGuardMiddleware`, ktory fail-closuje
    // zadania bez kontekstu rynku — handler nigdy nie widzi go pustego.
    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_1" },
      async () => {
        await paymentStatusGET(req, res)
      },
    )

    expect(captured.status).toBe(200)
    expect(captured.body).toMatchObject({ status: "paid", recommended_action_key: "continue" })
  })

  /**
   * KONTROLA NEGATYWNA guardu rynku. Poprzedni warunek wymagal, zeby OBIE
   * strony byly ustawione, wiec zamowienie bez `sales_channel_id` bylo czytelne
   * z DOWOLNEGO rynku — nawet przy poprawnym dowodzie koszyka. Ten test
   * przechodzil BY takze przed zmiana, gdyby nie asercja na 404.
   */
  it.each([
    ["zamowienie bez kanalu", "sc_1", null],
    ["brak kanalu w kontekscie rynku", null, "sc_1"],
    ["kanal innego rynku", "sc_1", "sc_INNY"],
  ])(
    "%s => 404, mimo poprawnego dowodu koszyka (fail-closed)",
    async (_label, contextChannel, orderChannel) => {
      const req = {
        params: { id: "ord_1" },
        query: { cart_id: "cart_1" },
        scope: {
          resolve: (key: string) => {
            if (key === Modules.ORDER) {
              return {
                retrieveOrder: async () => ({
                  id: "ord_1",
                  customer_id: null,
                  payment_status: "captured",
                  status: "pending",
                  created_at: new Date().toISOString(),
                  sales_channel_id: orderChannel,
                }),
              }
            }
            if (key === ContainerRegistrationKeys.PG_CONNECTION) {
              return {
                raw: async (sql: string) => {
                  if (sql.includes("order_cart")) return { rows: [{ "?column?": 1 }] }
                  return { rows: [] }
                },
              }
            }
            if (key === "logger") {
              return { info: () => undefined, warn: () => undefined, error: () => undefined }
            }
            throw new Error(`unexpected resolve ${key}`)
          },
        },
      } as any

      const captured: { status?: number; body?: any } = {}
      const res = {
        status(code: number) {
          captured.status = code
          return this
        },
        json(body: any) {
          captured.body = body
          return this
        },
      } as any

      await marketContextStorage.run(
        { market_id: "bonbeauty", sales_channel_id: contextChannel as any },
        async () => {
          await paymentStatusGET(req, res)
        },
      )

      // 404, nie 403 — odmowa nie moze rozniac sie od "nie ma takiego
      // zamowienia", inaczej staje sie wyrocznia istnienia zasobu.
      expect(captured.status).toBe(404)
      expect(captured.body).toMatchObject({ type: "not_found" })
    },
  )

  it("handler bez auth_context i bez dowodu oddaje 401", async () => {
    const req = {
      params: { id: "ord_1" },
      query: {},
      scope: { resolve: () => { throw new Error("nie powinniśmy dotykać kontenera") } },
    } as any

    const captured: { status?: number; body?: any } = {}
    const res = {
      status(code: number) {
        captured.status = code
        return this
      },
      json(body: any) {
        captured.body = body
        return this
      },
    } as any

    await paymentStatusGET(req, res)

    expect(captured.status).toBe(401)
  })

  it("nie przyjmuje dowodu spoza kształtu string (powtórzony parametr w query)", () => {
    expect(parseCartProof(["cart_a", "cart_b"])).toBeNull()
    expect(parseCartProof("")).toBeNull()
    expect(parseCartProof("  ")).toBeNull()
    expect(parseCartProof(undefined)).toBeNull()
    expect(parseCartProof(" cart_1 ")).toEqual({ type: "cart", values: ["cart_1"] })
    // Lista: kolejny zakup nie może odbierać dostępu do poprzedniego zamówienia.
    expect(parseCartProof("cart_1,cart_2")).toEqual({ type: "cart", values: ["cart_1", "cart_2"] })
    // Wejście ograniczone co do liczby i długości.
    expect(parseCartProof("a,b,c,d,e,f,g")?.values).toHaveLength(5)
    expect(parseCartProof("x".repeat(101))).toBeNull()
  })
})

describe("payment_status source", () => {
  beforeEach(() => {
    runOrderDetailWorkflow.mockReset()
  })

  function reqWithoutDb() {
    return {
      scope: {
        resolve: (key: string) => {
          if (key === ContainerRegistrationKeys.PG_CONNECTION) {
            return { raw: async () => ({ rows: [] }) }
          }
          throw new Error(`unexpected resolve ${key}`)
        },
      },
    } as any
  }

  it("dolicza payment_status z getOrderDetailWorkflow, gdy moduł oddaje undefined", async () => {
    // Regresja: `retrieveOrder(..., { select: [..., "payment_status"] })` ORAZ
    // `query.graph` oddają w tym polu undefined — trasa raportowała wtedy
    // `pending_psp_confirmation` dla zamówienia opłaconego i przechwyconego.
    runOrderDetailWorkflow.mockResolvedValue({ result: { id: "ord_1", payment_status: "captured" } })

    const order = await withComputedPaymentStatus(reqWithoutDb(), {
      id: "ord_1",
      customer_id: "cus_1",
      payment_status: undefined,
      status: "pending",
    })

    expect(order).toMatchObject({ id: "ord_1", payment_status: "captured" })
    expect(runOrderDetailWorkflow).toHaveBeenCalledTimes(1)
  })

  it("nie nadpisuje statusu, gdy moduł już go zwrócił", async () => {
    const order = await withComputedPaymentStatus(reqWithoutDb(), {
      id: "ord_1",
      customer_id: "cus_1",
      payment_status: "canceled",
      status: "pending",
    })

    expect(order).toMatchObject({ payment_status: "canceled" })
    expect(runOrderDetailWorkflow).not.toHaveBeenCalled()
  })

  it("przy awarii workflow zostawia pole puste — nigdy nie zgaduje paid", async () => {
    runOrderDetailWorkflow.mockRejectedValue(new Error("workflow down"))
    const warn = jest.fn()

    const order = await withComputedPaymentStatus(
      reqWithoutDb(),
      { id: "ord_1", customer_id: "cus_1", payment_status: undefined, status: "pending" },
      { warn }
    )

    expect(order?.payment_status).toBeUndefined()
    // Przyczyna MUSI zostawić ślad — inaczej systemowa awaria workflow jest
    // nieodróżnialna od braku danych i każde opłacone zamówienie cicho wisi.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("getOrderDetailWorkflow failed"))
  })
})

describe("retrieveOrderByStatusIdentifier — NOT_FOUND z modułu", () => {
  it("zwraca null zamiast propagować wyjątek i próbuje fallbacku cart→order", async () => {
    // Regresja: `retrieveOrder` RZUCA MedusaError NOT_FOUND. Brak opakowania
    // czynił fallback martwym, a URL z cart_id (return_url Stripe) kończył się
    // 503 „awaria backendu" zamiast statusem albo uczciwym 401.
    const notFound = Object.assign(new Error("Order not found"), { type: "not_found" })
    const retrieveOrder = jest
      .fn()
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({ id: "ord_z_koszyka", customer_id: null, payment_status: "captured" })

    const req = {
      scope: {
        resolve: (key: string) => {
          if (key === ContainerRegistrationKeys.PG_CONNECTION) {
            return { raw: async () => ({ rows: [{ id: "ord_z_koszyka" }] }) }
          }
          throw new Error(`unexpected resolve ${key}`)
        },
      },
    } as any

    const order = await retrieveOrderByStatusIdentifier(req, { retrieveOrder }, "cart_1")

    expect(order).toMatchObject({ id: "ord_z_koszyka" })
    expect(retrieveOrder).toHaveBeenCalledTimes(2)
  })

  it("propaguje błędy INNE niż NOT_FOUND", async () => {
    const boom = Object.assign(new Error("db down"), { type: "database_error" })
    const retrieveOrder = jest.fn().mockRejectedValue(boom)
    const req = { scope: { resolve: () => ({ raw: async () => ({ rows: [] }) }) } } as any

    await expect(
      retrieveOrderByStatusIdentifier(req, { retrieveOrder }, "ord_1")
    ).rejects.toThrow("db down")
  })
})
