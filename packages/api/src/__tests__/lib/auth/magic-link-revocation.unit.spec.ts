import {
  PostgresMagicLinkStore,
  createMagicLinkRuntimeBindings,
} from "../../../lib/auth/magic-link-revocation"

type AnyFn = (...args: unknown[]) => unknown

describe("PostgresMagicLinkStore", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("records issued links with subject metadata for revoke-all lookup", async () => {
    const ignore = jest.fn().mockResolvedValue(undefined)
    const onConflict = jest.fn(() => ({ ignore }))
    const insert = jest.fn(() => ({ onConflict }))
    const db = jest.fn(() => ({ insert })) as unknown as AnyFn
    const store = new PostgresMagicLinkStore(db as never)

    await store.recordIssued({
      token_jti: "00000000-0000-4000-8000-000000000001",
      purpose: "recover",
      subject: {
        email: "Customer@Example.test",
      },
      subject_customer_id: "cus_1",
      subject_email: "Customer@Example.test",
      market_id: "bonbeauty",
      issued_at: new Date("2026-05-18T08:00:00.000Z"),
      expires_at: new Date("2026-05-25T08:00:00.000Z"),
    })

    expect(insert).toHaveBeenCalledWith({
      token_jti: "00000000-0000-4000-8000-000000000001",
      purpose: "recover",
      subject: {
        email: "Customer@Example.test",
      },
      subject_customer_id: "cus_1",
      subject_seller_id: null,
      subject_email: "customer@example.test",
      market_id: "bonbeauty",
      issued_at: new Date("2026-05-18T08:00:00.000Z"),
      expires_at: new Date("2026-05-25T08:00:00.000Z"),
    })
    const insertCalls = insert.mock.calls as unknown[][]
    const insertedPayload = insertCalls[0]?.[0] as
      | Record<string, unknown>
      | undefined
    expect(insertedPayload).toBeDefined()
    expect(onConflict).toHaveBeenCalledWith("token_jti")
    expect(ignore).toHaveBeenCalledTimes(1)
  })

  it("filters revoke-all by customer, market, expiry, and unrevoke state", async () => {
    const issuedRows = [
      { token_jti: "00000000-0000-4000-8000-000000000001" },
      { token_jti: "00000000-0000-4000-8000-000000000002" },
    ]

    const pendingQuery = {
      leftJoin: jest.fn(),
      select: jest.fn(),
      where: jest.fn(),
      whereRaw: jest.fn(),
      whereNull: jest.fn(),
    }
    pendingQuery.leftJoin.mockReturnValue(pendingQuery)
    pendingQuery.select.mockReturnValue(pendingQuery)
    pendingQuery.where.mockReturnValue(pendingQuery)
    pendingQuery.whereRaw.mockReturnValue(pendingQuery)
    pendingQuery.whereNull.mockResolvedValue(issuedRows)

    const ignore = jest.fn().mockResolvedValue(undefined)
    const onConflict = jest.fn(() => ({ ignore }))
    const insert = jest.fn(() => ({ onConflict }))

    const db = jest.fn((table: string) => {
      if (table === "magic_link_issued as issued") {
        return pendingQuery
      }

      if (table === "magic_link_revocation") {
        return { insert }
      }

      throw new Error(`unexpected table ${table}`)
    }) as unknown as AnyFn

    const store = new PostgresMagicLinkStore(db as never)
    const now = new Date("2026-05-18T08:00:00.000Z")
    const result = await store.revokePendingForCustomer({
      customer_id: "cus_1",
      customer_email: "Customer@Example.test",
      market_id: "bonbeauty",
      reason: "user_revoke",
      revoked_by: "cus_1",
      now,
    })

    expect(result).toEqual({ revoked_count: 2 })
    expect(pendingQuery.whereRaw).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("issued.subject_customer_id = ?"),
      [
        "cus_1",
        "cus_1",
        "customer@example.test",
        "customer@example.test",
        "customer@example.test",
        "customer@example.test",
      ]
    )
    expect(pendingQuery.where).toHaveBeenNthCalledWith(
      1,
      "issued.expires_at",
      ">",
      now
    )
    expect(pendingQuery.whereRaw).toHaveBeenNthCalledWith(
      2,
      "(issued.market_id = ? OR issued.market_id IS NULL)",
      ["bonbeauty"]
    )
    expect(pendingQuery.whereNull).toHaveBeenCalledWith("revoked.token_jti")
    expect(insert).toHaveBeenCalledWith([
      {
        token_jti: "00000000-0000-4000-8000-000000000001",
          reason: "user_revoke",
          revoked_by: "cus_1",
          actor_type: "customer",
        },
        {
          token_jti: "00000000-0000-4000-8000-000000000002",
          reason: "user_revoke",
          revoked_by: "cus_1",
          actor_type: "customer",
        },
    ])
    expect(onConflict).toHaveBeenCalledWith("token_jti")
    expect(ignore).toHaveBeenCalledTimes(1)
  })

  it("fails closed when revoke-all is called without market scope", async () => {
    const db = jest.fn() as unknown as AnyFn
    const store = new PostgresMagicLinkStore(db as never)

    await expect(
      store.revokePendingForCustomer({
        customer_id: "cus_1",
        market_id: "",
        reason: "user_revoke",
        revoked_by: "cus_1",
      })
    ).rejects.toThrow(/market_id is required/)
  })

  it("cleans up revocation and issued ledgers with explicit SQL predicates", async () => {
    const revocationDelete = jest.fn().mockResolvedValue(3)
    const revocationWhereRaw = jest.fn(() => ({ delete: revocationDelete }))
    const issuedDelete = jest.fn().mockResolvedValue(5)
    const issuedWhereRaw = jest.fn(() => ({ delete: issuedDelete }))
    const db = jest.fn((table: string) => {
      if (table === "magic_link_revocation") {
        return { whereRaw: revocationWhereRaw }
      }

      if (table === "magic_link_issued") {
        return { whereRaw: issuedWhereRaw }
      }

      throw new Error(`unexpected table ${table}`)
    }) as unknown as AnyFn

    const store = new PostgresMagicLinkStore(db as never)

    await expect(store.cleanupExpiredRevocations()).resolves.toBe(3)
    await expect(store.cleanupExpiredIssued()).resolves.toBe(5)
    expect(revocationWhereRaw).toHaveBeenCalledWith(
      "revoked_at < now() - interval '30 days'"
    )
    expect(issuedWhereRaw).toHaveBeenCalledWith("expires_at < now()")
  })
})

describe("createMagicLinkRuntimeBindings", () => {
  it("adapts store methods into default runtime bindings", async () => {
    const store = {
      isJtiRevoked: jest.fn().mockResolvedValue(true),
      recordIssued: jest.fn().mockResolvedValue(undefined),
    }
    const bindings = createMagicLinkRuntimeBindings(store)

    await expect(bindings.isJtiRevoked("jti-1")).resolves.toBe(true)
    await bindings.recordIssued({
      token: "token",
      claims: {
        jti: "00000000-0000-4000-8000-000000000001",
        purpose: "recover",
        subject: {
          customer_id: "cus_1",
          market_id: "bonbeauty",
          email: "customer@example.test",
        },
        iat: 1_747_556_800,
        exp: 1_748_161_600,
      },
    })

    expect(store.isJtiRevoked).toHaveBeenCalledWith("jti-1")
    expect(store.recordIssued).toHaveBeenCalledWith({
      token_jti: "00000000-0000-4000-8000-000000000001",
      purpose: "recover",
      subject: {
        customer_id: "cus_1",
        market_id: "bonbeauty",
        email: "customer@example.test",
      },
      subject_customer_id: "cus_1",
      subject_seller_id: null,
      subject_email: "customer@example.test",
      market_id: "bonbeauty",
      issued_at: new Date("2025-05-18T08:26:40.000Z"),
      expires_at: new Date("2025-05-25T08:26:40.000Z"),
    })
  })
})
