import { marketContextStorage } from "../../../lib/market-context"
import {
  _clearAuditLog,
  _getAuditLog,
  appendClaimAuditWithFallback,
  ClaimMarketContextRequiredError,
  ClaimPersistenceUnavailableError,
} from "../../../api/store/vouchers/[code]/claim/helpers"

const row = {
  idempotency_key: "claim-key",
  code: "voucher-code",
  ip: "127.0.0.1",
  outcome: "rate_limited" as const,
  occurred_at: "2026-09-06T12:00:00.000Z",
}

function requestWithDb(db: unknown) {
  return { scope: { resolve: () => db } } as never
}

describe("voucher claim audit durability boundary", () => {
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    _clearAuditLog()
    process.env.NODE_ENV = "test"
    process.env.GP_ALLOW_IN_MEMORY_CLAIM_PERSISTENCE = "1"
  })

  afterEach(() => {
    _clearAuditLog()
    process.env.NODE_ENV = originalNodeEnv
    delete process.env.GP_ALLOW_IN_MEMORY_CLAIM_PERSISTENCE
  })

  it("nie zapisuje braku scope do auditLog, nawet gdy test dopuszcza fallback", async () => {
    const pg = {
      connect: async () => ({ query: async () => undefined, release: () => undefined }),
    }

    await expect(appendClaimAuditWithFallback(requestWithDb(pg), row)).rejects.toBeInstanceOf(
      ClaimMarketContextRequiredError
    )
    expect(_getAuditLog()).toEqual([])
  })

  it("przekazuje obie osie HTTP do trwałego writera claim", async () => {
    const calls: Array<{ sql: string; values: ReadonlyArray<unknown> | undefined }> = []
    const pg = {
      connect: async () => ({
        query: async (sql: string, values?: ReadonlyArray<unknown>) => {
          calls.push({ sql, values })
          return { rows: [], rowCount: 1 }
        },
        release: () => undefined,
      }),
    }

    await marketContextStorage.run(
      { market_id: "market-http", instance_id: "instance-http" },
      () => appendClaimAuditWithFallback(requestWithDb(pg), row),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(expect.objectContaining({
      sql: expect.stringContaining("INSERT INTO voucher_claim_audit"),
      values: expect.arrayContaining(["instance-http", "market-http"]),
    }))
  })

  it("odmawia HTTP contextu bez instance_id przed durable write", async () => {
    const pg = {
      connect: async () => ({ query: async () => ({ rows: [], rowCount: 1 }), release: () => undefined }),
    }

    await expect(
      marketContextStorage.run(
        { market_id: "market-http" },
        () => appendClaimAuditWithFallback(requestWithDb(pg), row),
      ),
    ).rejects.toBeInstanceOf(ClaimMarketContextRequiredError)
  })

  it("w produkcji błąd trwałego audytu propaguje się zamiast omijać RLS pamięcią", async () => {
    process.env.NODE_ENV = "production"
    delete process.env.GP_ALLOW_IN_MEMORY_CLAIM_PERSISTENCE

    await expect(appendClaimAuditWithFallback(requestWithDb(null), row)).rejects.toBeInstanceOf(
      ClaimPersistenceUnavailableError
    )
    expect(_getAuditLog()).toEqual([])
  })

  it("dopuszcza in-memory wyłącznie w jawnie włączonym trybie testowym", async () => {
    await marketContextStorage.run({ market_id: "market-test" }, () =>
      appendClaimAuditWithFallback(requestWithDb(null), row)
    )
    expect(_getAuditLog()).toEqual([row])
  })
})
