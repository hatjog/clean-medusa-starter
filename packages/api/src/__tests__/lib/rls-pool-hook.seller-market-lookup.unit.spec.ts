/**
 * Story 5.4 fix (DW-15-300) — named one-shot exception of the RLS pool hook for
 * the seller-market read on `/vendor/*` BEFORE a market context exists.
 * Pairs every positive control with a negative one: the hook still denies any
 * other connection without market context.
 */
import {
  _resetRlsPoolHook,
  installRlsPoolHook,
  lookupSellerMarketIdWithoutMarketContext,
  RlsMarketContextRequiredError,
  SELLER_MARKET_LOOKUP_EXCEPTION,
} from "../../lib/rls-pool-hook"
import { resolveSellerMarketId } from "../../lib/http-market-context"

function setUp(acquiresPerQuery = 1) {
  const queries: string[] = []
  const connection = {
    query: async (sql: string) => {
      queries.push(sql)
    },
    end: async () => undefined,
  }
  const client = {
    acquireConnection: async () => connection,
    releaseConnection: jest.fn(async () => undefined),
    destroyRawConnection: jest.fn(async () => undefined),
  }
  const logger = { error: jest.fn(), info: jest.fn() }
  installRlsPoolHook({ client }, logger)
  const seen: Array<{ table: string; where: [string, string] }> = []
  const db: any = (table: string) => ({
    select: () => ({
      where: (col: string, val: string) => ({
        first: async () => {
          seen.push({ table, where: [col, val] })
          for (let i = 0; i < acquiresPerQuery; i++) {
            const c = await client.acquireConnection()
            await client.releaseConnection(c as any)
          }
          return { market_id: "market_a" }
        },
      }),
    }),
  })
  db.raw = (sql: string) => sql
  return { client, db, queries, logger, seen }
}

describe("Story 5.4 fix — SELLER_MARKET_LOOKUP_EXCEPTION", () => {
  beforeEach(() => _resetRlsPoolHook())

  it("odczyt rynku sprzedawcy przechodzi BEZ kontekstu rynku (jedno połączenie, bez SET ROLE)", async () => {
    const h = setUp()
    await expect(resolveSellerMarketId(h.db, "sel_a")).resolves.toBe("market_a")
    expect(h.seen).toEqual([{ table: "seller", where: ["id", "sel_a"] }])
    expect(h.queries).toEqual([])
    expect(h.logger.info).toHaveBeenCalledWith(
      "RLS pool hook named exception",
      { exception: SELLER_MARKET_LOOKUP_EXCEPTION }
    )
  })

  it("wyjątek jest JEDNORAZOWY: drugie połączenie w tym samym zakresie ⇒ missing_market_context", async () => {
    const h = setUp(2)
    await expect(lookupSellerMarketIdWithoutMarketContext(h.db, "sel_a")).rejects.toBeInstanceOf(
      RlsMarketContextRequiredError
    )
  })

  it("poza wyjątkiem hook nadal odmawia anonimowego połączenia (także PO odczycie)", async () => {
    const h = setUp()
    await expect(h.client.acquireConnection()).rejects.toBeInstanceOf(RlsMarketContextRequiredError)
    await resolveSellerMarketId(h.db, "sel_a")
    await expect(h.client.acquireConnection()).rejects.toBeInstanceOf(RlsMarketContextRequiredError)
  })
})
