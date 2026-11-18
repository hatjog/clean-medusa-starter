/**
 * Story 8.7 fix round 2 (R-1) — named one-shot exception of the RLS pool hook
 * for the sales-channel -> market map read by `MarketContextCache`.
 *
 * Measured on the live gp-test stack (2026-11-18): without this exception the
 * cache read was denied (`missing_market_context`) and every `/store/*` request
 * answered 500. Every positive control is paired with a negative one: any other
 * query on the granted connection, a second acquisition, and any anonymous
 * connection outside the exception are still denied.
 */
import {
  _resetRlsPoolHook,
  installRlsPoolHook,
  readSalesChannelMarketMapWithoutMarketContext,
  RlsMarketContextRequiredError,
  SALES_CHANNEL_MARKET_MAP_EXCEPTION,
  SALES_CHANNEL_MARKET_MAP_SQL,
  PUBLISHABLE_KEY_SALES_CHANNELS_EXCEPTION,
  PUBLISHABLE_KEY_SALES_CHANNELS_SQL,
  readPublishableKeySalesChannelsWithoutMarketContext,
} from "../../lib/rls-pool-hook"

function setUp(opts: { sqlRun?: string[]; acquires?: number } = {}) {
  const sqlRun = opts.sqlRun ?? [SALES_CHANNEL_MARKET_MAP_SQL]
  const acquires = opts.acquires ?? 1
  const queries: string[] = []
  const connection: any = {
    query: async (sql: string | { text: string }) => {
      const text = typeof sql === "string" ? sql : sql.text
      queries.push(text)
      return { rows: [{ id: "sc_1", market_id: "bonbeauty" }] }
    },
    end: async () => undefined,
  }
  const client = {
    acquireConnection: async () => connection,
    releaseConnection: jest.fn(async (_c: unknown) => undefined),
    destroyRawConnection: jest.fn(async (_c: unknown) => undefined),
  }
  const logger = { error: jest.fn(), info: jest.fn() }
  installRlsPoolHook({ client }, logger)
  // Fake knex `raw`: acquires a pooled connection, sends the texts, releases it.
  const db = {
    raw: async (_sql: string) => {
      let last: any
      for (let i = 0; i < acquires; i++) {
        const c = await client.acquireConnection()
        try {
          for (const s of sqlRun) last = await c.query({ text: s } as any)
        } finally {
          await client.releaseConnection(c as any)
        }
      }
      return last
    },
  }
  return { client, db, queries, logger }
}

describe("Story 8.7 R-1 — SALES_CHANNEL_MARKET_MAP_EXCEPTION", () => {
  beforeEach(() => _resetRlsPoolHook())

  it("mapa kanał→rynek czytana BEZ kontekstu rynku: SET ROLE medusa_store, jedno stałe zapytanie", async () => {
    const h = setUp()
    await expect(readSalesChannelMarketMapWithoutMarketContext(h.db)).resolves.toEqual([
      { id: "sc_1", market_id: "bonbeauty" },
    ])
    expect(h.queries).toEqual(["SET ROLE medusa_store", SALES_CHANNEL_MARKET_MAP_SQL, "RESET ROLE"])
    expect(h.client.destroyRawConnection).not.toHaveBeenCalled()
    expect(h.logger.info).toHaveBeenCalledWith("RLS pool hook named exception", {
      exception: SALES_CHANNEL_MARKET_MAP_EXCEPTION,
    })
  })

  it("INNE zapytanie w oknie wyjątku ⇒ odmowa, tekst nie dociera do bazy, połączenie zniszczone", async () => {
    const h = setUp({ sqlRun: ["SELECT * FROM voucher"] })
    const err = await readSalesChannelMarketMapWithoutMarketContext(h.db).catch((e) => e)
    expect(err).toBeInstanceOf(RlsMarketContextRequiredError)
    expect(h.queries).not.toContain("SELECT * FROM voucher")
    expect(h.client.destroyRawConnection).toHaveBeenCalledTimes(1)
  })

  it("wyjątek jest jednorazowy: drugie połączenie ⇒ missing_market_context", async () => {
    const h = setUp({ acquires: 2 })
    await expect(readSalesChannelMarketMapWithoutMarketContext(h.db)).rejects.toThrow(
      "missing_market_context"
    )
  })

  it("poza wyjątkiem hook nadal odmawia anonimowego połączenia (przed i po odczycie)", async () => {
    const h = setUp()
    await expect(h.client.acquireConnection()).rejects.toBeInstanceOf(RlsMarketContextRequiredError)
    await readSalesChannelMarketMapWithoutMarketContext(h.db)
    await expect(h.client.acquireConnection()).rejects.toBeInstanceOf(RlsMarketContextRequiredError)
  })
})

describe("Story 8.7 R-1 — PUBLISHABLE_KEY_SALES_CHANNELS_EXCEPTION", () => {
  beforeEach(() => _resetRlsPoolHook())

  function keyDb(h: ReturnType<typeof setUp>, compiledSql: string | null, sent: string) {
    return {
      raw: (_sql: string, _bindings?: unknown[]) => {
        const p: any = {
          then: (a: any, b: any) =>
            (async () => {
              const c = await h.client.acquireConnection()
              try {
                return await c.query({ text: sent } as any)
              } finally {
                await h.client.releaseConnection(c as any)
              }
            })().then(a, b),
        }
        if (compiledSql !== null) p.toSQL = () => ({ toNative: () => ({ sql: compiledSql }) })
        return p
      },
    }
  }

  it("odczyt klucza bez kontekstu: przechodzi skompilowany tekst stałego zapytania", async () => {
    const h = setUp()
    const compiled = PUBLISHABLE_KEY_SALES_CHANNELS_SQL.replace("?", "$1")
    const rows = await readPublishableKeySalesChannelsWithoutMarketContext(keyDb(h, compiled, compiled), "pk_x")
    expect(rows).toEqual([{ id: "sc_1", market_id: "bonbeauty" }])
    expect(h.queries).toEqual(["SET ROLE medusa_store", compiled, "RESET ROLE"])
    expect(h.logger.info).toHaveBeenCalledWith("RLS pool hook named exception", {
      exception: PUBLISHABLE_KEY_SALES_CHANNELS_EXCEPTION,
    })
  })

  it("inny tekst albo builder bez kompilacji ⇒ odmowa (fail-closed)", async () => {
    const h = setUp()
    const compiled = PUBLISHABLE_KEY_SALES_CHANNELS_SQL.replace("?", "$1")
    await expect(
      readPublishableKeySalesChannelsWithoutMarketContext(keyDb(h, compiled, "SELECT * FROM voucher"), "pk_x")
    ).rejects.toBeInstanceOf(RlsMarketContextRequiredError)
    await expect(
      readPublishableKeySalesChannelsWithoutMarketContext(keyDb(h, null, compiled), "pk_x")
    ).rejects.toBeInstanceOf(RlsMarketContextRequiredError)
    expect(h.queries).not.toContain("SELECT * FROM voucher")
  })
})
