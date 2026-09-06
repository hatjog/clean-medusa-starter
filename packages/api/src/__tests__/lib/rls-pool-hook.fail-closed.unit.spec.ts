import { marketContextStorage } from "../../lib/market-context"
import {
  _resetRlsPoolHook,
  installRlsPoolHook,
  RlsMarketContextRequiredError,
} from "../../lib/rls-pool-hook"

type FakeConnection = {
  queries: Array<{ sql: string; params?: unknown[] }>
  ended: boolean
  query: (sql: string, params?: unknown[]) => Promise<void>
  end: () => Promise<void>
}

function installHarness() {
  const connection: FakeConnection = {
    queries: [],
    ended: false,
    query: async (sql, params) => {
      connection.queries.push({ sql, params })
    },
    end: async () => {
      connection.ended = true
    },
  }
  const releaseConnection = jest.fn(async (_connection: FakeConnection) => undefined)
  const destroyRawConnection = jest.fn(async () => undefined)
  const client = {
    acquireConnection: async () => connection,
    releaseConnection,
    destroyRawConnection,
  }
  const logger = { error: jest.fn() }
  installRlsPoolHook({ client }, logger)
  return { client, connection, destroyRawConnection, logger, releaseConnection }
}

describe("rls-pool-hook fail closed", () => {
  beforeEach(() => _resetRlsPoolHook())

  it.each(["HTTP", "job", "subscriber", "workflow", "script"])("odmawia %s bez jawnego market scope i niszczy connection", async () => {
    const harness = installHarness()

    await expect(harness.client.acquireConnection()).rejects.toEqual(
      expect.objectContaining({
        name: RlsMarketContextRequiredError.name,
        error_code: "GP_RLS_MARKET_CONTEXT_REQUIRED",
      })
    )

    expect(harness.connection.queries).toEqual([])
    expect(harness.connection.ended).toBe(true)
    expect(harness.destroyRawConnection).toHaveBeenCalledWith(harness.connection)
    expect(harness.releaseConnection).not.toHaveBeenCalled()
    expect(harness.logger.error).toHaveBeenCalledWith(
      "RLS pool hook acquire denied",
      expect.objectContaining({ reason: "missing_market_context" })
    )
  })

  it("odmawia niepoprawny market_id zamiast zwrócić nieuzbrojone connection", async () => {
    const harness = installHarness()

    await expect(
      marketContextStorage.run({ market_id: "invalid market", instance_id: "instance_a" }, () => harness.client.acquireConnection())
    ).rejects.toEqual(expect.objectContaining({ error_code: "GP_RLS_MARKET_CONTEXT_REQUIRED" }))

    expect(harness.connection.queries).toEqual([])
    expect(harness.connection.ended).toBe(true)
    expect(harness.logger.error).toHaveBeenCalledWith(
      "RLS pool hook acquire denied",
      expect.objectContaining({ reason: "invalid_market_id" })
    )
  })

  it("odmawia brak instance_id nawet przy poprawnym market_id", async () => {
    const harness = installHarness()

    await expect(
      marketContextStorage.run({ market_id: "market_a" }, () => harness.client.acquireConnection())
    ).rejects.toEqual(expect.objectContaining({ error_code: "GP_RLS_MARKET_CONTEXT_REQUIRED" }))

    expect(harness.connection.queries).toEqual([])
    expect(harness.connection.ended).toBe(true)
    expect(harness.logger.error).toHaveBeenCalledWith(
      "RLS pool hook acquire denied",
      expect.objectContaining({ reason: "missing_instance_id" })
    )
  })

  it("uzbraja tylko connection z poprawnym scope i czyści je przy release", async () => {
    const harness = installHarness()

    const connection = await marketContextStorage.run(
      { market_id: "market_a", instance_id: "instance_a" },
      () => harness.client.acquireConnection()
    )
    await harness.client.releaseConnection(connection)

    expect(harness.connection.queries).toEqual([
      { sql: "SET ROLE medusa_store", params: undefined },
      { sql: "SELECT set_config('app.gp_market_id', $1, false)", params: ["market_a"] },
      { sql: "SELECT set_config('app.gp_instance_id', $1, false)", params: ["instance_a"] },
      { sql: "RESET app.gp_market_id", params: undefined },
      { sql: "RESET app.gp_instance_id", params: undefined },
      { sql: "RESET ROLE", params: undefined },
    ])
    expect(harness.releaseConnection).toHaveBeenCalledWith(connection)
    expect(harness.destroyRawConnection).not.toHaveBeenCalled()
  })
})
