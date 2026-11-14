/**
 * Story 5.4 fix (DW-15-300, ADR-241) — named one-shot exception of the RLS pool
 * hook for the seller-market read on `/vendor/*` BEFORE a market context exists.
 * Pairs every positive control with a negative one: the hook still denies any
 * other connection without market context, and (fix round 2, R-13) any query
 * on the granted connection other than the ONE fixed `seller`-by-id read.
 */
import {
  _resetRlsPoolHook,
  installRlsPoolHook,
  lookupSellerMarketIdWithoutMarketContext,
  RlsMarketContextRequiredError,
  SELLER_MARKET_LOOKUP_EXCEPTION,
} from "../../lib/rls-pool-hook"
import { resolveSellerMarketId } from "../../lib/http-market-context"

const FIXED_SQL =
  `select metadata->'gp'->>'market_id' as market_id from "seller" where "id" = $1 limit $2`

/**
 * `sqlRun` = texts the fake builder sends on the acquired connection;
 * `FIXED` stands for the builder's own compiled text (what knex would send).
 */
function setUp(opts: { acquires?: number; sqlRun?: string[]; compiles?: boolean } = {}) {
  const acquires = opts.acquires ?? 1
  const sqlRun = opts.sqlRun ?? ["FIXED"]
  const compiles = opts.compiles ?? true
  const queries: string[] = []
  const connection: any = {
    query: async (sql: string) => {
      queries.push(sql)
      return { rows: [] }
    },
    end: async () => undefined,
  }
  const client = {
    acquireConnection: async () => connection,
    releaseConnection: jest.fn(async (_connection: unknown) => undefined),
    destroyRawConnection: jest.fn(async (_connection: unknown) => undefined),
  }
  const logger = { error: jest.fn(), info: jest.fn() }
  installRlsPoolHook({ client }, logger)
  const seen: Array<{ table: string; where: [string, string] }> = []
  const db: any = (table: string) => ({
    select: () => ({
      where: (col: string, val: string) => {
        const run = async () => {
          seen.push({ table, where: [col, val] })
          for (let i = 0; i < acquires; i++) {
            const c = await client.acquireConnection()
            try {
              for (const s of sqlRun) {
                await c.query(s === "FIXED" ? FIXED_SQL : s, [val, 1])
              }
            } finally {
              await client.releaseConnection(c as any)
            }
          }
          return { market_id: "market_a" }
        }
        let p: Promise<unknown> | undefined
        const q: any = {
          then: (a: any, b: any) => (p ??= run()).then(a, b),
          first: () => q,
        }
        if (compiles) q.toSQL = () => ({ toNative: () => ({ sql: FIXED_SQL }) })
        return q
      },
    }),
  })
  db.raw = (sql: string) => sql
  return { client, db, queries, logger, seen, connection }
}

describe("Story 5.4 fix — SELLER_MARKET_LOOKUP_EXCEPTION", () => {
  beforeEach(() => _resetRlsPoolHook())

  it("odczyt rynku sprzedawcy przechodzi BEZ kontekstu rynku: jedno połączenie, SET ROLE medusa_store, jedno stałe zapytanie", async () => {
    const h = setUp()
    await expect(resolveSellerMarketId(h.db, "sel_a")).resolves.toBe("market_a")
    expect(h.seen).toEqual([{ table: "seller", where: ["id", "sel_a"] }])
    expect(h.queries).toEqual(["SET ROLE medusa_store", FIXED_SQL, "RESET ROLE"])
    expect(h.client.destroyRawConnection).not.toHaveBeenCalled()
    expect(h.logger.info).toHaveBeenCalledWith(
      "RLS pool hook named exception",
      { exception: SELLER_MARKET_LOOKUP_EXCEPTION }
    )
  })

  it("R-13: INNE zapytanie w oknie wyjątku ⇒ odmowa seller_lookup_query_not_allowed, połączenie zniszczone", async () => {
    const h = setUp({ sqlRun: ["SELECT * FROM voucher"] })
    const err = await lookupSellerMarketIdWithoutMarketContext(h.db, "sel_a").catch((e) => e)
    expect(err).toBeInstanceOf(RlsMarketContextRequiredError)
    expect(String(err.message)).toContain("seller_lookup_query_not_allowed")
    expect(h.queries).not.toContain("SELECT * FROM voucher")
    expect(h.client.destroyRawConnection).toHaveBeenCalledTimes(1)
  })

  it("R-13: DRUGIE zapytanie (nawet tym samym tekstem) na połączeniu wyjątku ⇒ odmowa", async () => {
    const h = setUp({ sqlRun: ["FIXED", "FIXED"] })
    await expect(lookupSellerMarketIdWithoutMarketContext(h.db, "sel_a")).rejects.toThrow(
      "seller_lookup_query_not_allowed"
    )
    expect(h.queries.filter((q) => q === FIXED_SQL)).toHaveLength(1)
  })

  it("R-13: builder bez kompilowalnego tekstu ⇒ każde zapytanie odmówione (fail-closed)", async () => {
    const h = setUp({ compiles: false })
    await expect(lookupSellerMarketIdWithoutMarketContext(h.db, "sel_a")).rejects.toThrow(
      "seller_lookup_query_not_allowed"
    )
  })

  it("po zwolnieniu połączenia wyjątku sterownik ma z powrotem pierwotne query (bez strażnika)", async () => {
    const h = setUp()
    const original = h.connection.query
    await resolveSellerMarketId(h.db, "sel_a")
    expect(h.connection.query).toBe(original)
  })

  it("wyjątek jest JEDNORAZOWY: drugie połączenie w tym samym zakresie ⇒ missing_market_context", async () => {
    const h = setUp({ acquires: 2 })
    await expect(lookupSellerMarketIdWithoutMarketContext(h.db, "sel_a")).rejects.toThrow(
      "missing_market_context"
    )
  })

  it("poza wyjątkiem hook nadal odmawia anonimowego połączenia (także PO odczycie)", async () => {
    const h = setUp()
    await expect(h.client.acquireConnection()).rejects.toBeInstanceOf(RlsMarketContextRequiredError)
    await resolveSellerMarketId(h.db, "sel_a")
    await expect(h.client.acquireConnection()).rejects.toBeInstanceOf(RlsMarketContextRequiredError)
  })
})
