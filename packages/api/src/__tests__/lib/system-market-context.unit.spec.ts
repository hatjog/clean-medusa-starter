/**
 * system-market-context — testy nośnika kontekstu systemowego
 * (v1.15.0 Story 2.1, AC1/AC2; FR-14d, AD-21, NFR-2).
 *
 * Testy są napisane tak, żeby CZERWIENIAŁY po usunięciu odmowy z nośnika
 * (test-the-test z AC2): każdy przypadek negatywny asertuje jednocześnie
 * wyjątek, kod błędu, wpis w logu i INKREMENTACJĘ METRYKI — kontrola, która
 * przechodzi także po zepsuciu mechanizmu, nie jest kontrolą.
 */

import { marketContextStorage } from "../../lib/market-context"
import {
  SYSTEM_MARKET_CONTEXT_DENIED_METRIC,
  SystemMarketContextError,
  _resetSystemMarketContextMetrics,
  getSystemMarketContextDenials,
  getSystemMarketContextMetrics,
  requireMarketContext,
  runInSystemMarketContext,
  type SystemExecutionOrigin,
} from "../../lib/system-market-context"

const ORIGIN: SystemExecutionOrigin = {
  surface: "subscriber",
  name: "test-consumer",
}

function makeLogger() {
  const errors: Array<{ message: string; meta?: Record<string, unknown> }> = []
  return {
    errors,
    error: (message: string, meta?: Record<string, unknown>) =>
      errors.push({ message, meta }),
  }
}

describe("runInSystemMarketContext — kontrola dodatnia", () => {
  beforeEach(() => _resetSystemMarketContextMetrics())

  it("uruchamia pracę w kontekście o tym samym kształcie co łańcuch /store/*", async () => {
    const seen: Array<string | undefined> = []

    const results = await runInSystemMarketContext(
      { markets: ["bonbeauty"], origin: ORIGIN },
      async (marketId) => {
        // DOKŁADNIE ten sam nośnik, który czyta rls-pool-hook.
        seen.push(marketContextStorage.getStore()?.market_id)
        return `done:${marketId}`
      },
    )

    expect(seen).toEqual(["bonbeauty"])
    expect(results).toEqual(["done:bonbeauty"])
    expect(getSystemMarketContextDenials()).toBe(0)
  })

  it("rozwija wykonanie po jednym przebiegu na każdy zadeklarowany rynek", async () => {
    const seen: Array<string | undefined> = []
    await runInSystemMarketContext(
      { markets: ["bonbeauty", "bonevent"], origin: ORIGIN },
      async () => {
        seen.push(marketContextStorage.getStore()?.market_id)
      },
    )
    expect(seen).toEqual(["bonbeauty", "bonevent"])
  })

  it("oznacza kontekst pochodzeniem systemowym, nie udaje requestu", async () => {
    await runInSystemMarketContext(
      { markets: ["bonbeauty"], origin: { surface: "job", name: "sweeper" } },
      async () => {
        expect(marketContextStorage.getStore()?.system).toEqual({
          surface: "job",
          name: "sweeper",
        })
      },
    )
  })

  it("zdejmuje kontekst po zakończeniu pracy", async () => {
    await runInSystemMarketContext({ markets: ["bonbeauty"], origin: ORIGIN }, async () => {})
    expect(marketContextStorage.getStore()).toBeUndefined()
  })
})

describe("runInSystemMarketContext — kontrola negatywna (odmowa, nie dostęp do wszystkiego)", () => {
  beforeEach(() => _resetSystemMarketContextMetrics())

  it("odmawia, gdy lista rynków nie została zadeklarowana", async () => {
    const logger = makeLogger()
    const work = jest.fn()

    await expect(
      runInSystemMarketContext(
        { markets: undefined as never, origin: ORIGIN, logger },
        work as never,
      ),
    ).rejects.toBeInstanceOf(SystemMarketContextError)

    // Praca NIE poleciała — brak listy to odmowa, nie „wszystkie rynki".
    expect(work).not.toHaveBeenCalled()
    expect(getSystemMarketContextDenials({ reason: "markets_not_declared" })).toBe(1)
    expect(logger.errors[0]?.meta?.metric).toBe(SYSTEM_MARKET_CONTEXT_DENIED_METRIC)
  })

  it("odmawia przy pustej liście rynków", async () => {
    const logger = makeLogger()
    const work = jest.fn()

    await expect(
      runInSystemMarketContext({ markets: [], origin: ORIGIN, logger }, work as never),
    ).rejects.toMatchObject({ error_code: "GP_SYSTEM_MARKET_CONTEXT_DENIED" })

    expect(work).not.toHaveBeenCalled()
    expect(getSystemMarketContextDenials({ reason: "markets_empty" })).toBe(1)
    expect(logger.errors).toHaveLength(1)
  })

  it("odmawia przy identyfikatorze, którego hook RLS by zignorował", async () => {
    const logger = makeLogger()
    const work = jest.fn()

    await expect(
      runInSystemMarketContext(
        { markets: ["bon beauty; DROP"], origin: ORIGIN, logger },
        work as never,
      ),
    ).rejects.toBeInstanceOf(SystemMarketContextError)

    expect(work).not.toHaveBeenCalled()
    expect(getSystemMarketContextDenials({ reason: "market_id_invalid" })).toBe(1)
  })

  it("odmawia CAŁEJ pracy, gdy choć jeden zadeklarowany rynek jest niepoprawny", async () => {
    const work = jest.fn()
    await expect(
      runInSystemMarketContext(
        { markets: ["bonbeauty", "zły rynek"], origin: ORIGIN },
        work as never,
      ),
    ).rejects.toBeInstanceOf(SystemMarketContextError)
    // Walidacja idzie PRZED pierwszym przebiegiem — inaczej połowa pracy
    // wykonałaby się przed odmową.
    expect(work).not.toHaveBeenCalled()
  })
})

describe("requireMarketContext — zapis bez kontekstu jest błędem, nie zapisem", () => {
  beforeEach(() => _resetSystemMarketContextMetrics())

  it("odmawia poza jakimkolwiek kontekstem i liczy odmowę", () => {
    const logger = makeLogger()

    expect(() => requireMarketContext("write:test", { logger })).toThrow(
      SystemMarketContextError,
    )
    expect(getSystemMarketContextDenials({ reason: "context_missing" })).toBe(1)
    expect(logger.errors[0]?.meta?.error_code).toBe("GP_SYSTEM_MARKET_CONTEXT_DENIED")
  })

  it("przepuszcza wewnątrz kontekstu systemowego", async () => {
    await runInSystemMarketContext({ markets: ["bonbeauty"], origin: ORIGIN }, async () => {
      expect(requireMarketContext("write:test").market_id).toBe("bonbeauty")
    })
    expect(getSystemMarketContextDenials()).toBe(0)
  })
})

describe("metryka odmów jest ODPYTYWALNA (NFR-2)", () => {
  beforeEach(() => _resetSystemMarketContextMetrics())

  it("eksponuje nazwany licznik z wymiarami reason i surface", async () => {
    await expect(
      runInSystemMarketContext(
        { markets: [], origin: { surface: "job", name: "x" } },
        async () => {},
      ),
    ).rejects.toBeInstanceOf(SystemMarketContextError)

    expect(getSystemMarketContextMetrics()).toEqual([
      {
        metric: SYSTEM_MARKET_CONTEXT_DENIED_METRIC,
        reason: "markets_empty",
        surface: "job",
        value: 1,
      },
    ])
  })
})
