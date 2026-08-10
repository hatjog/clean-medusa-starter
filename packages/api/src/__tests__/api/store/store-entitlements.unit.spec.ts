/**
 * store-entitlements.unit.spec.ts — v1.15.0 DW-15-132.
 *
 * Trasa `GET /store/entitlements` NIE ISTNIAŁA, mimo że storefrontowy BFF wołał
 * ją od Story 3.7: backend odpowiadał `Cannot GET /store/entitlements`, BFF
 * mapował to na `502`, a kupująca widziała „Nie udało nam się teraz odczytać
 * całego zakupu" przy działającym voucherze.
 *
 * Ta suita chodzi REALNYM handlerem trasy i realnym middlewarem limitu — nie
 * czyta źródła i nie sprawdza konfiguracji. Pokryty jest KAŻDY wiersz macierzy
 * I/O ze specu, w tym kontrole negatywne: „bez dowodu nie ma zapytania do bazy"
 * i „poza rynkiem 404 mimo poprawnego dowodu".
 */

import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import {
  GET as entitlementsGET,
  resetGuestAccessLogSamplingForTests,
} from "../../../api/store/entitlements/route"
import { marketContextStorage } from "../../../lib/market-context"
import {
  STORE_ENTITLEMENTS_CART_CAPACITY,
  STORE_ENTITLEMENTS_IP_CAPACITY,
  storeEntitlementsRateLimiter,
  storeEntitlementsRateLimitMiddleware,
} from "../../../api/middlewares/store-entitlements-rate-limit"
import { paymentStatusRateLimiter } from "../../../api/middlewares/payment-status-rate-limit"

type CapturedResponse = { status?: number; body?: any; headers: Record<string, string> }

function makeRes(): { res: any; captured: CapturedResponse } {
  const captured: CapturedResponse = { headers: {} }
  const res = {
    status(code: number) {
      captured.status = code
      return this
    },
    json(body: any) {
      captured.body = body
      return this
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value
      return this
    },
  } as any
  return { res, captured }
}

const ORDER_ID = "ord_1"
const CUSTOMER_ID = "cus_owner"

function entitlementRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ent_1",
    order_id: ORDER_ID,
    line_item_id: "ordli_1",
    state: "ISSUED",
    policy_snapshot: {
      voucher_code: "BO-AAAA-1111",
      amount_minor: 26000,
      currency: "PLN",
      validity_months: 12,
      cancellation: { fee_pct: 10 },
      refund_channel: "original_payment",
      no_show: { policy: "forfeit_voucher" },
      extension: { allowed: true, paid: false, fee_pct: 0, max_extension_months: 3 },
      // ZMIERZONE na realnym snapshocie: identyfikator płatności Stripe leży w
      // tym samym obiekcie. Fixture go niesie, żeby test „snapshot nie wycieka
      // w całości" mierzył realny wyciek, a nie wymyślony.
      source_payment_intent_id: "pi_3ABCDEF",
      purchase_locale: "en",
    },
    expires_at: new Date("2027-08-10T12:00:00.000Z"),
    market_id: "bonbeauty",
    remaining_amount: null,
    reference_price_minor: "26000",
    created_at: new Date("2026-08-10T12:00:00.000Z"),
    line_item_title: "Oczyszczanie twarzy",
    order_metadata: { purchase_locale: "pl" },
    voucher_code: "BO-AAAA-1111",
    product_title: "Oczyszczanie twarzy",
    seller_name: "Salon Testowy",
    seller_handle: "salon-testowy",
    value_minor: 26000,
    currency_code: "PLN",
    voucher_expires_at: null,
    ...overrides,
  }
}

type ScenarioOptions = {
  customerId?: string
  cartId?: string
  order?: Record<string, unknown> | null
  cartProducedOrder?: boolean
  entitlementRows?: Record<string, unknown>[]
  entitlementQueryThrows?: boolean
}

type Scenario = {
  req: any
  resolved: string[]
  entitlementSql: string[]
  /** KAŻDY SQL, jaki trasa wysłała — mierzy też zapytania, których NIE MA. */
  allSql: string[]
  /** Wpisy logu — degradacja MUSI być nazwana, nie cicha. */
  logs: string[]
  bindings: unknown[][]
}

function makeScenario(options: ScenarioOptions = {}): Scenario {
  const resolved: string[] = []
  const entitlementSql: string[] = []
  const allSql: string[] = []
  const logs: string[] = []
  const bindings: unknown[][] = []

  const order =
    options.order === undefined
      ? {
          id: ORDER_ID,
          customer_id: CUSTOMER_ID,
          status: "pending",
          sales_channel_id: "sc_1",
        }
      : options.order

  const req = {
    query: {
      order_id: ORDER_ID,
      ...(options.cartId ? { cart_id: options.cartId } : {}),
    },
    ...(options.customerId ? { auth_context: { actor_id: options.customerId } } : {}),
    scope: {
      resolve: (key: string) => {
        resolved.push(key)
        if (key === Modules.ORDER) {
          return {
            retrieveOrder: async () => {
              if (!order) {
                const err: any = new Error("not found")
                err.type = "not_found"
                throw err
              }
              return order
            },
          }
        }
        if (key === ContainerRegistrationKeys.PG_CONNECTION) {
          return {
            raw: async (sql: string, params?: ReadonlyArray<unknown>) => {
              allSql.push(sql)
              bindings.push(params ? [...params] : [])
              if (sql.includes("order_cart")) {
                return { rows: options.cartProducedOrder ? [{ "?column?": 1 }] : [] }
              }
              if (sql.includes("entitlement_instance")) {
                entitlementSql.push(sql)
                if (options.entitlementQueryThrows) {
                  throw new Error("connection terminated unexpectedly")
                }
                return { rows: options.entitlementRows ?? [] }
              }
              return { rows: [] }
            },
          }
        }
        if (key === "logger") {
          return {
            info: (msg: string) => logs.push(String(msg)),
            warn: (msg: string) => logs.push(String(msg)),
            error: (msg: string) => logs.push(String(msg)),
          }
        }
        throw new Error(`unexpected resolve ${key}`)
      },
    },
  } as any

  return { req, resolved, entitlementSql, allSql, logs, bindings }
}

async function runInMarket(
  work: () => Promise<void>,
  context: { market_id: string; sales_channel_id: string | null } = {
    market_id: "bonbeauty",
    sales_channel_id: "sc_1",
  },
): Promise<void> {
  await marketContextStorage.run(context as any, work)
}

describe("GET /store/entitlements — model dostępu", () => {
  it("zalogowana właścicielka dostaje 200 i TABLICĘ uprawnień", async () => {
    const scenario = makeScenario({
      customerId: CUSTOMER_ID,
      entitlementRows: [entitlementRow()],
    })
    const { res, captured } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(captured.status).toBe(200)
    expect(Array.isArray(captured.body)).toBe(true)
    expect(captured.body).toHaveLength(1)
  })

  it("gość z dowodem koszyka dostaje 200 — checkout bez konta nie jest odcięty", async () => {
    const scenario = makeScenario({
      cartId: "cart_1",
      order: { id: ORDER_ID, customer_id: null, status: "pending", sales_channel_id: "sc_1" },
      cartProducedOrder: true,
      entitlementRows: [entitlementRow()],
    })
    const { res, captured } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(captured.status).toBe(200)
    expect(Array.isArray(captured.body)).toBe(true)
  })

  /**
   * KONTROLA NEGATYWNA. Odpowiedź `401` jest bezwartościowa, jeśli trasa
   * najpierw odpytała bazę o to zamówienie: czas odpowiedzi i log stają się
   * wtedy wyrocznią jego istnienia. Mierzymy KONTENER — jeśli handler nie
   * poprosił o `PG_CONNECTION` ani o moduł zamówień, to nie mógł nic odczytać.
   */
  it("brak sesji i brak dowodu ⇒ 401 BEZ dotknięcia bazy", async () => {
    const scenario = makeScenario({})
    const { res, captured } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(captured.status).toBe(401)
    expect(scenario.resolved).not.toContain(ContainerRegistrationKeys.PG_CONNECTION)
    expect(scenario.resolved).not.toContain(Modules.ORDER)
    expect(scenario.bindings).toHaveLength(0)
  })

  it("brak `order_id` ⇒ 400 z `request_id`", async () => {
    const scenario = makeScenario({ customerId: CUSTOMER_ID })
    scenario.req.query = {}
    const { res, captured } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(captured.status).toBe(400)
    expect(captured.body.type).toBe("invalid_request")
    expect(captured.body.request_id).toEqual(expect.any(String))
  })

  /**
   * Odpowiedź nie może być wyrocznią istnienia zamówienia: „cudze" i
   * „nieistniejące" muszą być NIEODRÓŻNIALNE dla wołającego. Porównujemy ciała
   * z pominięciem `request_id`, bo ten jest z definicji per-żądanie.
   */
  it("cudze i nieistniejące zamówienie dają IDENTYCZNE 404", async () => {
    const foreign = makeScenario({
      customerId: "cus_ktos_inny",
      entitlementRows: [entitlementRow()],
    })
    const missing = makeScenario({ customerId: "cus_ktos_inny", order: null })

    const a = makeRes()
    const b = makeRes()
    await runInMarket(() => entitlementsGET(foreign.req, a.res))
    await runInMarket(() => entitlementsGET(missing.req, b.res))

    expect(a.captured.status).toBe(404)
    expect(b.captured.status).toBe(404)
    const { request_id: _a, ...bodyA } = a.captured.body
    const { request_id: _b, ...bodyB } = b.captured.body
    expect(bodyA).toEqual(bodyB)
  })

  /**
   * Log zgody jest PRÓBKĄ. Poller odpytuje co 5 s przez 10 minut, więc wpis na
   * każdy tick daje ~120 linii na JEDNO zamówienie — a wtedy odmowy (jedyny
   * realny sygnał na tej trasie) toną w potwierdzeniach.
   */
  it("log zgody gościa jest PRÓBKOWANY, nie leci na każdy tick pollera", async () => {
    resetGuestAccessLogSamplingForTests()
    const logs: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const scenario = makeScenario({
        cartId: "cart_1",
        order: { id: ORDER_ID, customer_id: null, status: "pending", sales_channel_id: "sc_1" },
        cartProducedOrder: true,
        entitlementRows: [entitlementRow()],
      })
      const { res } = makeRes()
      await runInMarket(() => entitlementsGET(scenario.req, res))
      logs.push(...scenario.logs)
    }

    const granted = logs.filter((line) => line.includes("guest_order_access_granted"))
    expect(granted).toHaveLength(1)
  })

  it("gość, którego koszyk NIE wyprodukował zamówienia, dostaje 401 (nie 404)", async () => {
    const scenario = makeScenario({
      cartId: "cart_obcy",
      order: { id: ORDER_ID, customer_id: null, status: "pending", sales_channel_id: "sc_1" },
      cartProducedOrder: false,
    })
    const { res, captured } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(captured.status).toBe(401)
  })

  /**
   * KONTROLA NEGATYWNA guardu rynku (fail-closed). Brak KTÓREJKOLWIEK ze stron
   * to odmowa — inaczej zamówienie bez kanału byłoby czytelne z dowolnego rynku.
   */
  it.each([
    ["zamówienie bez kanału", "sc_1", null],
    ["brak kanału w kontekście rynku", null, "sc_1"],
    ["kanał innego rynku", "sc_1", "sc_INNY"],
  ])(
    "%s ⇒ 404 mimo poprawnego dowodu koszyka",
    async (_label, contextChannel, orderChannel) => {
      const scenario = makeScenario({
        cartId: "cart_1",
        order: {
          id: ORDER_ID,
          customer_id: null,
          status: "pending",
          sales_channel_id: orderChannel,
        },
        cartProducedOrder: true,
        entitlementRows: [entitlementRow()],
      })
      const { res, captured } = makeRes()

      await runInMarket(() => entitlementsGET(scenario.req, res), {
        market_id: "bonbeauty",
        sales_channel_id: contextChannel,
      })

      expect(captured.status).toBe(404)
    },
  )

  it("awaria bazy ⇒ 503 (BFF mapuje na 502, poller odpytuje dalej)", async () => {
    const scenario = makeScenario({
      customerId: CUSTOMER_ID,
      entitlementQueryThrows: true,
    })
    const { res, captured } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(captured.status).toBe(503)
    expect(captured.body.type).toBe("service_unavailable")
  })
})

describe("GET /store/entitlements — kształt odpowiedzi", () => {
  /**
   * AD-19: „jeszcze nie wystawiono" MUSI być odróżnialne od awarii. Pusta
   * tablica z `200` każe pollerowi czekać; błąd kończy jego pętlę i pokazuje
   * kupującej ekran awarii przy działającym zakupie.
   */
  it("zamówienie bez uprawnień ⇒ 200 z PUSTĄ TABLICĄ, nie błąd", async () => {
    const scenario = makeScenario({ customerId: CUSTOMER_ID, entitlementRows: [] })
    const { res, captured } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(captured.status).toBe(200)
    expect(captured.body).toEqual([])
  })

  /**
   * Koszyk multi-seller rodzi po jednym uprawnieniu na `line_item_id`.
   * `LIMIT 1` oddałby kupującej jeden voucher z kilku kupionych.
   */
  it("oddaje WSZYSTKIE uprawnienia zamówienia i nie ogranicza zapytania", async () => {
    const scenario = makeScenario({
      customerId: CUSTOMER_ID,
      entitlementRows: [
        entitlementRow({ id: "ent_1", line_item_id: "ordli_1" }),
        entitlementRow({ id: "ent_2", line_item_id: "ordli_2", voucher_code: "BO-BBBB-2222" }),
      ],
    })
    const { res, captured } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(captured.body.map((e: any) => e.id)).toEqual(["ent_1", "ent_2"])
    expect(scenario.entitlementSql[0]).not.toMatch(/LIMIT\s+1/i)
    // SKUTEK, nie tekst SQL-a: zapytanie o uprawnienia poszło z identyfikatorem
    // ZAMÓWIENIA jako jedynym wiązaniem. Asercja na literał `ei.order_id = ?`
    // przechodziła nawet wtedy, gdyby wiązanie było inne.
    const entitlementBindings = scenario.bindings[scenario.bindings.length - 1]
    expect(entitlementBindings).toEqual([ORDER_ID])
  })

  /**
   * Kod vouchera NIE leży w `entitlement_instance` — bez joinu po JSON-ie
   * `voucher_code` wychodziłby `null` i ekran potwierdzenia nie miałby co
   * pokazać.
   */
  it("wiąże voucher joinem po `policy_snapshot->>'voucher_code'`", async () => {
    const scenario = makeScenario({
      customerId: CUSTOMER_ID,
      entitlementRows: [entitlementRow()],
    })
    const { res, captured } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(scenario.entitlementSql[0]).toContain("policy_snapshot->>'voucher_code'")
    expect(captured.body[0].voucher_code).toBe("BO-AAAA-1111")
  })

  /**
   * Status SUROWY. UI czyta go dwiema drogami naraz: `isGiftOrder` porównuje
   * `toUpperCase() === 'ISSUED'`, a `normalizeEntitlementPipelineStatus`
   * lowercase'uje i mapuje. Tłumaczenie po stronie backendu zepsułoby jedną.
   */
  it("zwraca SUROWY `state` jako `status`", async () => {
    const scenario = makeScenario({
      customerId: CUSTOMER_ID,
      entitlementRows: [entitlementRow({ state: "ISSUED" })],
    })
    const { res, captured } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(captured.body[0].status).toBe("ISSUED")
  })

  it("element niesie komplet pól czytanych przez BFF i UI", async () => {
    const scenario = makeScenario({
      customerId: CUSTOMER_ID,
      entitlementRows: [entitlementRow()],
    })
    const { res, captured } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(captured.body[0]).toMatchObject({
      status: "ISSUED",
      voucher_code: "BO-AAAA-1111",
      product_name: "Oczyszczanie twarzy",
      salon_name: "Salon Testowy",
      face_value_minor: 26000,
      currency: "PLN",
      expires_at: "2027-08-10T12:00:00.000Z",
    })
    // Nośnik reguł: BFF liczy `voucherRules` z SUROWEGO wiersza. Bez tego pola
    // `normalizeVoucherRules` oddaje reguły puste i fixture'y e2e rozjeżdżają
    // się z realnym backendem.
    expect(captured.body[0].policy_snapshot).toMatchObject({ validity_months: 12 })
    expect(captured.body[0]).toHaveProperty("claim_url")
  })

  /**
   * `reference_price_minor` jest `bigint`, a node-pg oddaje BIGINT jako STRING.
   * Bez konwersji kwota szłaby na front jako `"26000"`.
   */
  it("kwota jest LICZBĄ nawet gdy sterownik oddał ją stringiem", async () => {
    const scenario = makeScenario({
      customerId: CUSTOMER_ID,
      entitlementRows: [
        entitlementRow({
          value_minor: null,
          policy_snapshot: { voucher_code: "BO-AAAA-1111" },
          reference_price_minor: "19900",
        }),
      ],
    })
    const { res, captured } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(captured.body[0].face_value_minor).toBe(19900)
  })

  /**
   * Decyzja PO 2026-08-10 (PO RECENZJI): odpowiedź NIE NIESIE danych odbiorcy.
   * Mierzymy BRAK POLA, a nie „pole równe null" — pole obecne z wartością pustą
   * byłoby nadal deklaracją, że ta trasa jest nośnikiem PII odbiorcy.
   */
  it("NIE niesie danych odbiorcy — ani nazwy, ani adresu", async () => {
    const scenario = makeScenario({
      customerId: CUSTOMER_ID,
      entitlementRows: [
        entitlementRow({
          // Realny wiersz niesie metadane prezentu; trasa nie ma ich czytać.
          line_item_metadata: {
            gift_recipient_email: "obdarowana@example.test",
            gift_recipient_name: "Ala",
          },
        }),
      ],
    })
    const { res, captured } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(captured.status).toBe(200)
    expect(captured.body[0]).not.toHaveProperty("recipient_name")
    expect(captured.body[0]).not.toHaveProperty("recipient_email")
    expect(JSON.stringify(captured.body)).not.toContain("obdarowana@example.test")
  })

  /**
   * KONTROLA NEGATYWNA zdjęcia PII: nie chodzi tylko o brak pól w odpowiedzi,
   * ale o brak ZAPYTANIA. `voucher_recipient_pii` nie ma być odpytywane w ogóle
   * — jego polityka RLS porównuje `market_id::uuid`, a rynek jest slugiem, więc
   * to zapytanie i tak padało ZAWSZE.
   */
  it("NIE odpytuje `voucher_recipient_pii`", async () => {
    const scenario = makeScenario({
      customerId: CUSTOMER_ID,
      entitlementRows: [entitlementRow()],
    })
    const { res } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(scenario.allSql.join("\n")).not.toContain("voucher_recipient_pii")
  })

  /**
   * `policy_snapshot` niesie w realnej bazie m.in. `source_payment_intent_id`
   * („pi_…"). Przepisujemy z niego WYŁĄCZNIE pola czytane przez
   * `normalizeVoucherRules` — reszta nie ma czego szukać w przeglądarce.
   */
  it("przepisuje `policy_snapshot` po jawnej liście pól, bez identyfikatora płatności", async () => {
    const scenario = makeScenario({
      customerId: CUSTOMER_ID,
      entitlementRows: [entitlementRow()],
    })
    const { res, captured } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(Object.keys(captured.body[0].policy_snapshot).sort()).toEqual([
      "cancellation",
      "extension",
      "no_show",
      "refund_channel",
      "validity_months",
    ])
    expect(JSON.stringify(captured.body)).not.toContain("pi_3ABCDEF")
    expect(JSON.stringify(captured.body)).not.toContain("source_payment_intent_id")
  })

  /**
   * Ładunek niesie kod na okaziciela — odpowiedź nie może być przechowywana po
   * drodze.
   */
  it("odpowiedź 200 niesie `Cache-Control: no-store`", async () => {
    const scenario = makeScenario({
      customerId: CUSTOMER_ID,
      entitlementRows: [entitlementRow()],
    })
    const { res, captured } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(captured.status).toBe(200)
    expect(captured.headers["Cache-Control"]).toBe("no-store")
  })

  /**
   * WARTOŚCI DOMYŚLNE, KTÓRE KŁAMIĄ. `0` jest nieodróżnialne od vouchera o
   * zerowej wartości, twarde `"PLN"` byłoby złą walutą na DE/UA, a `"ISSUED"`
   * mapuje się na stan TERMINALNY i zatrzymałoby poller na „dostarczone" przy
   * wystawieniu, którego jeszcze nie ma.
   */
  it("brak kwoty, waluty i stanu daje `null`, nie zmyśloną wartość", async () => {
    const scenario = makeScenario({
      customerId: CUSTOMER_ID,
      entitlementRows: [
        entitlementRow({
          state: null,
          value_minor: null,
          reference_price_minor: null,
          currency_code: null,
          policy_snapshot: { voucher_code: "BO-AAAA-1111" },
        }),
      ],
    })
    const { res, captured } = makeRes()

    await runInMarket(() => entitlementsGET(scenario.req, res))

    expect(captured.body[0].face_value_minor).toBeNull()
    expect(captured.body[0].currency).toBeNull()
    expect(captured.body[0].status).toBeNull()
  })

  it("buduje `claim_url` z JEDYNEGO buildera linku, gdy baza rynku jest skonfigurowana", async () => {
    const previous = process.env.GP_STOREFRONT_URL_BONBEAUTY
    process.env.GP_STOREFRONT_URL_BONBEAUTY = "https://bonbeauty.test"
    try {
      const scenario = makeScenario({
        customerId: CUSTOMER_ID,
        entitlementRows: [entitlementRow()],
      })
      const { res, captured } = makeRes()

      await runInMarket(() => entitlementsGET(scenario.req, res))

      expect(captured.body[0].claim_url).toBe(
        "https://bonbeauty.test/pl/voucher/BO-AAAA-1111",
      )
    } finally {
      if (previous === undefined) {
        delete process.env.GP_STOREFRONT_URL_BONBEAUTY
      } else {
        process.env.GP_STOREFRONT_URL_BONBEAUTY = previous
      }
    }
  })

  /**
   * Locale deep-linku pochodzi z ZAKUPU (`order.metadata.purchase_locale`, a w
   * drugiej kolejności ze snapshotu polityki) — tą samą drogą co maile
   * (`voucher/service.ts`). Wcześniej brało się z rekordu PII, którego odczyt
   * padał zawsze, więc link ZAWSZE wychodził na domyślne `pl`.
   */
  it.each([
    ["z metadanych zamówienia", { purchase_locale: "pl" }, "pl"],
    ["ze snapshotu polityki, gdy zamówienie nie niesie locale", null, "en"],
  ])("locale deep-linku pochodzi %s", async (_label, orderMetadata, expected) => {
    const previous = process.env.GP_STOREFRONT_URL_BONBEAUTY
    process.env.GP_STOREFRONT_URL_BONBEAUTY = "https://bonbeauty.test"
    try {
      const scenario = makeScenario({
        customerId: CUSTOMER_ID,
        entitlementRows: [entitlementRow({ order_metadata: orderMetadata })],
      })
      const { res, captured } = makeRes()

      await runInMarket(() => entitlementsGET(scenario.req, res))

      expect(captured.body[0].claim_url).toBe(
        `https://bonbeauty.test/${expected}/voucher/BO-AAAA-1111`,
      )
    } finally {
      if (previous === undefined) {
        delete process.env.GP_STOREFRONT_URL_BONBEAUTY
      } else {
        process.env.GP_STOREFRONT_URL_BONBEAUTY = previous
      }
    }
  })

  it("brak skonfigurowanej bazy rynku daje `claim_url: null`, a degradacja jest NAZWANA w logu", async () => {
    const previous = process.env.GP_STOREFRONT_URL_BONBEAUTY
    delete process.env.GP_STOREFRONT_URL_BONBEAUTY
    try {
      const scenario = makeScenario({
        customerId: CUSTOMER_ID,
        entitlementRows: [entitlementRow()],
      })
      const { res, captured } = makeRes()

      await runInMarket(() => entitlementsGET(scenario.req, res))

      expect(captured.status).toBe(200)
      expect(captured.body[0].claim_url).toBeNull()
      // `catch { return null }` bez logu byłby ciszą — przycisk „otwórz
      // voucher" znikałby bez jednego śladu.
      expect(scenario.logs.join("\n")).toContain("claim_url_build_degraded")
      // Log nie jest nośnikiem instrumentu na okaziciela.
      expect(scenario.logs.join("\n")).not.toContain("BO-AAAA-1111")
    } finally {
      if (previous !== undefined) {
        process.env.GP_STOREFRONT_URL_BONBEAUTY = previous
      }
    }
  })
})

describe("GET /store/entitlements — limit żądań", () => {
  let now = 2_000_000

  beforeEach(() => {
    now = 2_000_000
    storeEntitlementsRateLimiter.resetForTests()
    storeEntitlementsRateLimiter.setClockForTests(() => now)
    paymentStatusRateLimiter.resetForTests()
  })

  afterEach(() => {
    storeEntitlementsRateLimiter.resetForTests()
    paymentStatusRateLimiter.resetForTests()
  })

  function limiterReq(ip = "203.0.113.10", cartId?: string) {
    return {
      ip,
      headers: {},
      query: cartId ? { cart_id: cartId } : {},
      scope: { resolve: () => ({ warn: () => undefined }) },
    } as never
  }

  async function callLimiter(req: unknown): Promise<{ captured: any; passed: boolean }> {
    const captured: any = { headers: {} }
    const res = {
      status(code: number) {
        captured.status = code
        return this
      },
      json(body: any) {
        captured.body = body
        return this
      },
      setHeader(name: string, value: string) {
        captured.headers[name] = value
      },
    } as never
    let passed = false
    await storeEntitlementsRateLimitMiddleware(req as never, res as never, (() => {
      passed = true
    }) as never)
    return { captured, passed }
  }

  it("KONTROLA NEGATYWNA: po przekroczeniu budżetu `cart_id` odrzuca 429 z `Retry-After` i NIE woła next()", async () => {
    for (let i = 0; i < STORE_ENTITLEMENTS_CART_CAPACITY; i += 1) {
      const { passed } = await callLimiter(limiterReq("203.0.113.10", "cart_1"))
      expect(passed).toBe(true)
    }

    const { captured, passed } = await callLimiter(limiterReq("203.0.113.10", "cart_1"))

    expect(passed).toBe(false)
    expect(captured.status).toBe(429)
    expect(captured.headers["Retry-After"]).toBeDefined()
  })

  /**
   * KONTROLA NEGATYWNA zdjęcia kubełka per-IP. Ta trasa jest wołana wyłącznie
   * server-side przez BFF, więc backend widzi JEDEN adres dla całego ruchu
   * storefrontu: kubełek „per adres" dławił nie napastnika, tylko drugą
   * kupującą. Pełny rytm pollera JEDNEJ kupującej (120 żądań) musi przejść w
   * całości, mimo że wszystkie idą z tego samego adresu.
   */
  it("rytm pollera jednej kupującej NIE jest dławiony przez adres źródłowy", async () => {
    expect(STORE_ENTITLEMENTS_IP_CAPACITY).toBeNull()

    for (let i = 0; i < 120; i += 1) {
      const { passed } = await callLimiter(limiterReq("10.0.0.7", `cart_${i % 3}`))
      expect(passed).toBe(true)
    }

    // Kolejna kupująca z TEGO SAMEGO adresu (ten sam proces BFF) nadal przechodzi.
    const { passed } = await callLimiter(limiterReq("10.0.0.7", "cart_NASTEPNA"))
    expect(passed).toBe(true)
  })

  /**
   * Ekran potwierdzenia odpytuje `entitlements` i `payment-status` RÓWNOLEGLE.
   * Wspólna instancja licznika zjadałaby budżet dwa razy szybciej i odsyłała
   * `429` kupującej w środku jej własnego zakupu.
   */
  it("licznik jest NIEZALEŻNY od licznika `payment-status`", async () => {
    for (let i = 0; i < STORE_ENTITLEMENTS_CART_CAPACITY; i += 1) {
      await callLimiter(limiterReq("198.51.100.5", "cart_wspolny"))
    }

    const { passed } = await callLimiter(limiterReq("198.51.100.5", "cart_wspolny"))
    expect(passed).toBe(false)

    // Ten sam dowód na drugiej trasie ma NIETKNIĘTY budżet.
    const paymentDecision = paymentStatusRateLimiter.consume([
      { key: "ip:probe", capacity: 1 },
    ])
    expect(paymentDecision.allowed).toBe(true)
  })
})
