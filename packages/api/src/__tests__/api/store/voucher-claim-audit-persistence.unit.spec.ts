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
