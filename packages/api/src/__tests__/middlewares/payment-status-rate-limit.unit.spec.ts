/**
 * payment-status-rate-limit.unit.spec.ts
 *
 * Trasa `GET /store/orders/:id/payment-status` przyjmuje ruch NIEUWIERZYTELNIONY
 * i do tej pory nie miała limitu ani na próby dowodu, ani na samą trasę. Odmowy
 * były LOGOWANE, ale nic ich nie zliczało — pomiar bez konsekwencji.
 *
 * Testy sprawdzają OBIE strony bramki: że przepuszcza normalny ruch i — co
 * ważniejsze — że REALNIE ODRZUCA po przekroczeniu. Bramka, której nikt nie
 * zmusił do odmowy, jest nieodróżnialna od bramki martwej.
 */
import {
  PAYMENT_STATUS_CART_CAPACITY,
  PAYMENT_STATUS_IP_CAPACITY,
  PAYMENT_STATUS_RATE_LIMIT_WINDOW_MS,
  paymentStatusRateLimiter,
  paymentStatusRateLimitMiddleware,
} from "../../api/middlewares/payment-status-rate-limit"

type FakeRes = {
  statusCode: number | null
  payload: unknown
  headers: Record<string, string>
  status: (code: number) => FakeRes
  json: (body: unknown) => FakeRes
  setHeader: (name: string, value: string) => void
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: null,
    payload: null,
    headers: {},
    status(code) {
      res.statusCode = code
      return res
    },
    json(body) {
      res.payload = body
      return res
    },
    setHeader(name, value) {
      res.headers[name] = value
    },
  }
  return res
}

function makeReq(options: { ip?: string; cartId?: string | string[] } = {}) {
  return {
    ip: options.ip ?? "203.0.113.10",
    headers: {},
    query: options.cartId === undefined ? {} : { cart_id: options.cartId },
    scope: { resolve: () => ({ warn: () => undefined }) },
  } as never
}

async function call(req: unknown): Promise<{ res: FakeRes; passed: boolean }> {
  const res = makeRes()
  let passed = false
  await paymentStatusRateLimitMiddleware(req as never, res as never, (() => {
    passed = true
  }) as never)
  return { res, passed }
}

describe("payment-status rate limit", () => {
  let now = 1_000_000

  beforeEach(() => {
    now = 1_000_000
    paymentStatusRateLimiter.resetForTests()
    paymentStatusRateLimiter.setClockForTests(() => now)
  })

  afterEach(() => {
    paymentStatusRateLimiter.resetForTests()
  })

  it("przepuszcza normalny ruch az do wyczerpania budzetu per-IP", async () => {
    for (let i = 0; i < PAYMENT_STATUS_IP_CAPACITY; i += 1) {
      const { passed } = await call(makeReq())
      expect(passed).toBe(true)
    }
  })

  it("KONTROLA NEGATYWNA: po przekroczeniu odrzuca 429 i NIE wola next()", async () => {
    for (let i = 0; i < PAYMENT_STATUS_IP_CAPACITY; i += 1) {
      await call(makeReq())
    }

    const { res, passed } = await call(makeReq())

    expect(passed).toBe(false)
    expect(res.statusCode).toBe(429)
    expect(res.headers["Retry-After"]).toBeDefined()
  })

  it("licznik per-`cart_id` dziala NIEZALEZNIE od adresu (rotacja IP nie omija dowodu)", async () => {
    // Atakujacy testujacy JEDEN dowod z wielu adresow nie moze byc niewidzialny.
    for (let i = 0; i < PAYMENT_STATUS_CART_CAPACITY; i += 1) {
      const { passed } = await call(makeReq({ ip: `198.51.100.${i}`, cartId: "cart_01SAME" }))
      expect(passed).toBe(true)
    }

    const { res, passed } = await call(
      makeReq({ ip: "198.51.100.200", cartId: "cart_01SAME" }),
    )
    expect(passed).toBe(false)
    expect(res.statusCode).toBe(429)
  })

  it("licznik per-IP dziala NIEZALEZNIE od dowodu (rotacja cart_id nie omija adresu)", async () => {
    for (let i = 0; i < PAYMENT_STATUS_IP_CAPACITY; i += 1) {
      const { passed } = await call(makeReq({ ip: "203.0.113.77", cartId: `cart_${i}` }))
      expect(passed).toBe(true)
    }

    const { passed } = await call(makeReq({ ip: "203.0.113.77", cartId: "cart_INNY" }))
    expect(passed).toBe(false)
  })

  it("kazdy dowod z listy `a,b` ma WLASNY licznik (nie da sie testowac dowodow hurtem)", async () => {
    // `parseCartProof` przyjmuje liste rozdzielona przecinkiem, wiec JEDNO zadanie
    // moze niesc kilka dowodow. Gdyby dzielily jeden budzet, atakujacy testowalby
    // je hurtem po koszcie jednej proby.
    for (let i = 0; i < PAYMENT_STATUS_CART_CAPACITY; i += 1) {
      await call(makeReq({ ip: `192.0.2.${i}`, cartId: "cart_A,cart_B" }))
    }

    const a = await call(makeReq({ ip: "192.0.2.250", cartId: "cart_A" }))
    const b = await call(makeReq({ ip: "192.0.2.251", cartId: "cart_B" }))
    expect(a.passed).toBe(false)
    expect(b.passed).toBe(false)
  })

  it("ksztalt tablicowy (`?cart_id=a&cart_id=b`) nie tworzy licznika dowodu", async () => {
    // `parseCartProof` ODRZUCA tablice zamiast zgadywac, ktory element jest
    // prawdziwy — wiec i tu nie ma czego liczyc. Zadanie zostaje objete
    // wylacznie licznikiem per-IP i globalnym; ten test utrwala, ze bramka NIE
    // wymysla klucza tam, gdzie kontrakt dowodu go nie daje.
    for (let i = 0; i < PAYMENT_STATUS_CART_CAPACITY; i += 1) {
      await call(makeReq({ ip: `198.51.100.${i}`, cartId: ["cart_TAB", "cart_TAB2"] }))
    }

    const still = await call(makeReq({ ip: "198.51.100.240", cartId: "cart_TAB" }))
    expect(still.passed).toBe(true)
  })

  it("odrzucenie NIE pali budzetu koszyka, ktory limitu nie przekroczyl", async () => {
    // Wyczerpujemy WYLACZNIE `cart_A`...
    for (let i = 0; i < PAYMENT_STATUS_CART_CAPACITY; i += 1) {
      await call(makeReq({ ip: `192.0.2.${i}`, cartId: "cart_A" }))
    }
    // ...a zadanie niosace oba dowody ma zostac odrzucone przez `cart_A`.
    await call(makeReq({ ip: "192.0.2.240", cartId: "cart_A,cart_B" }))

    // `cart_B` nie moze byc przez to obciazony — inaczej odmowa jednego klucza
    // paliłaby budzet drugiego i limit karalby niewinny dowod.
    const b = await call(makeReq({ ip: "192.0.2.241", cartId: "cart_B" }))
    expect(b.passed).toBe(true)
  })

  it("po przejsciu okna budzet wraca (blokada jest CZASOWA, nie trwala)", async () => {
    for (let i = 0; i < PAYMENT_STATUS_IP_CAPACITY; i += 1) {
      await call(makeReq())
    }
    expect((await call(makeReq())).passed).toBe(false)

    now += PAYMENT_STATUS_RATE_LIMIT_WINDOW_MS + 1

    expect((await call(makeReq())).passed).toBe(true)
  })

  it("log odmowy niesie RODZAJ limitu, nigdy adresu ani dowodu", async () => {
    const lines: string[] = []
    const req = {
      ip: "203.0.113.55",
      headers: {},
      query: { cart_id: "cart_01TAJNY" },
      scope: { resolve: () => ({ warn: (message: string) => lines.push(message) }) },
    } as never

    for (let i = 0; i < PAYMENT_STATUS_CART_CAPACITY + 1; i += 1) {
      await call(req)
    }

    expect(lines.length).toBeGreaterThan(0)
    const joined = lines.join("\n")
    expect(joined).toContain("rate_limited")
    expect(joined).not.toContain("cart_01TAJNY")
    expect(joined).not.toContain("203.0.113.55")
  })
})
