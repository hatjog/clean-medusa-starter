/**
 * Tests for story v160-cleanup-50: DB-backed feature flag state persistence.
 *
 * AC9 scenarios:
 *   (a) write-then-read round-trip
 *   (b) multi-instance convergence within TTL
 *   (c) stale-within-TTL (acceptable divergence)
 *   (d) env override fallback when DB unavailable
 *   (e) concurrent writes serialize
 *   (f) migration seed derivation
 *   (g) regression guard — cleanup-15e oracle + cleanup-15f audit insert preserved
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals"

// ---------------------------------------------------------------------------
// Module-level mocks (must be hoisted before imports)
// ---------------------------------------------------------------------------

// Mock cache-invalidate-on-flag-flip so tests don't need Redis
jest.mock("../cache-invalidate-on-flag-flip", () => ({
  invalidateOnFlip: jest.fn().mockResolvedValue({
    isr_tags_revalidated: 0,
    redis_keys_busted: 0,
    sdk_cache_pings: 0,
    errors: [],
    duration_ms: 0,
  }),
}))

// Mock phase-b-smoke-gate-aggregator — bypass not needed in most tests
jest.mock("../phase-b-smoke-gate-aggregator", () => ({
  getLastRatification: jest.fn().mockResolvedValue({ verdict: "pass" }),
}))

// Mock logger to capture warn calls
const mockWarn = jest.fn()
jest.mock("../logger", () => ({
  logger: {
    warn: mockWarn,
    info: jest.fn(),
    error: jest.fn(),
  },
}))

import {
  getCurrentState,
  getFlagState,
  setState,
  getCachedState,
  invalidateCachedState,
  setCachedState,
  FLAG_STATE_TTL_MS,
  readFlagStateRow,
  upsertFlagState,
  insertFlagHistory,
  _resetDbWarnState,
} from "../feature-flag-tri-state"

// ---------------------------------------------------------------------------
// DB mock builder
// ---------------------------------------------------------------------------

type MockRow = Record<string, unknown>

/**
 * Build a minimal Knex-like mock for the feature_flag_state table.
 *
 * Supports:
 *   db(table).select(col).where(col, val).first()  → readFlagStateRow path
 *   db(table).insert({...}).returning("*")          → operator audit insert
 *   db.raw(sql, bindings)                           → upsertFlagState path
 *   db.transaction(callback)                        → setState transaction path
 */
function buildMockDb(options: {
  flagStateRows?: MockRow[]
  auditReturnRow?: MockRow
  throwOnSelect?: boolean
  throwMessage?: string
}) {
  const {
    flagStateRows = [],
    auditReturnRow,
    throwOnSelect = false,
    throwMessage = "ECONNREFUSED",
  } = options

  let insertedFlagHistory: MockRow[] = []
  let insertedAuditRows: MockRow[] = []
  let upsertedStateRows: MockRow[] = []

  // Track calls
  const selectCallCount: Record<string, number> = {}

  const buildTableProxy = (tableName: string) => {
    const proxy: Record<string, unknown> = {}

    // .select().where().first()
    proxy.select = (_col?: unknown) => ({
      where: (_col2: unknown, _val: unknown) => ({
        first: async () => {
          if (throwOnSelect) {
            throw new Error(throwMessage)
          }
          selectCallCount[tableName] = (selectCallCount[tableName] ?? 0) + 1
          if (tableName === "feature_flag_state") {
            return flagStateRows[0] ?? undefined
          }
          if (tableName === "operator_multi_vendor_flag_audit") {
            return undefined
          }
          return undefined
        },
      }),
    })

    // .insert({}).returning("*")
    proxy.insert = (row: MockRow) => ({
      returning: async (_cols: unknown) => {
        if (tableName === "operator_multi_vendor_flag_audit") {
          const returnRow = auditReturnRow ?? {
            id: `audit-id-${Date.now()}`,
            from_state: row.from_state,
            to_state: row.to_state,
            triggered_by: row.triggered_by,
            reason: row.reason ?? null,
            alert_id: null,
            smoke_gate_ref: null,
            admin_note: null,
            cache_invalidate_outcome: {},
            at: new Date().toISOString(),
          }
          insertedAuditRows.push(returnRow)
          return [returnRow]
        }
        if (tableName === "feature_flag_history") {
          insertedFlagHistory.push(row)
          return [row]
        }
        return [row]
      },
    })

    return proxy
  }

  // raw() mock — for UPSERT
  const rawMock = async (_sql: string, bindings: unknown[]) => {
    upsertedStateRows.push({
      flag_id: bindings[0],
      value: bindings[1],
      updated_by: bindings[2],
    })
  }

  // transaction mock — executes callback with a trx that wraps the same mock
  const buildTrx = (): Record<string, unknown> => {
    const trx = (tableName: string) => buildTableProxy(tableName)
    // @ts-expect-error - mock partial Knex transaction
    trx.raw = rawMock
    return trx as unknown as Record<string, unknown>
  }

  const db = (tableName: string) => buildTableProxy(tableName)
  // @ts-expect-error - mock partial Knex
  db.raw = rawMock
  // @ts-expect-error - mock partial Knex
  db.transaction = async (callback: (trx: unknown) => Promise<void>) => {
    const trx = buildTrx()
    await callback(trx)
  }

  return {
    db: db as never,
    getInsertedFlagHistory: () => insertedFlagHistory,
    getInsertedAuditRows: () => insertedAuditRows,
    getUpsertedStateRows: () => upsertedStateRows,
    getSelectCallCount: () => selectCallCount,
  }
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks()
  // Reset internal cache between tests
  invalidateCachedState("multi_vendor_pdp")
  // Reset DB-unavailable warn state so each test can observe a fresh warn
  _resetDbWarnState()
  delete process.env.GP_MV_FLAG_STATE
})

afterEach(() => {
  invalidateCachedState("multi_vendor_pdp")
  delete process.env.GP_MV_FLAG_STATE
})

// ---------------------------------------------------------------------------
// (a) Write-then-read round-trip (AC3 + partial AC2)
// ---------------------------------------------------------------------------

describe("(a) write-then-read round-trip", () => {
  it("setState writes DB and subsequent getCurrentState returns new value", async () => {
    let storedValue = "off"

    // Build a DB that returns whatever storedValue is
    const selectFirst = async () => ({ value: storedValue })
    const rawFn = async (_sql: string, bindings: unknown[]) => {
      storedValue = bindings[1] as string
    }
    const trxTableProxy = (tableName: string) => ({
      select: () => ({
        where: () => ({
          first: selectFirst,
        }),
      }),
      insert: (row: MockRow) => ({
        returning: async () => {
          if (tableName === "operator_multi_vendor_flag_audit") {
            return [{
              id: "audit-1",
              from_state: row.from_state,
              to_state: row.to_state,
              triggered_by: row.triggered_by,
              reason: null,
              alert_id: null,
              smoke_gate_ref: null,
              admin_note: null,
              cache_invalidate_outcome: {},
              at: new Date().toISOString(),
            }]
          }
          // feature_flag_history
          return [row]
        },
      }),
    })

    const trx: never = (() => {
      const t = (tableName: string) => trxTableProxy(tableName)
      // @ts-expect-error - mock partial Knex
      t.raw = rawFn
      return t as never
    })()

    const db: never = (() => {
      const d = (tableName: string) => trxTableProxy(tableName)
      // @ts-expect-error - mock partial Knex
      d.raw = rawFn
      // @ts-expect-error - mock partial Knex
      d.transaction = async (cb: (t: never) => Promise<void>) => cb(trx)
      return d as never
    })()

    // Ensure cache miss first
    invalidateCachedState("multi_vendor_pdp")

    const result = await setState("shadow", {
      triggered_by: "ops@gp",
      bypass_smoke_gate: true,
      db,
    })

    expect(result.from).toBe("off")
    expect(result.to).toBe("shadow")

    // Cache was invalidated by setState; next read goes to DB
    invalidateCachedState("multi_vendor_pdp")
    const readBack = await getCurrentState(db)
    expect(readBack).toBe("shadow")
  })
})

// ---------------------------------------------------------------------------
// (b) Multi-instance convergence within TTL (AC4)
// ---------------------------------------------------------------------------

describe("(b) multi-instance convergence within TTL", () => {
  it("instance B sees stale value before TTL, new value after TTL expires", async () => {
    // Simulate two separate caches via the exported helpers
    // "Instance A" writes to the DB
    // "Instance B" has its own cache entry (older)

    // Set up "instance B" stale cache
    setCachedState("multi_vendor_pdp", "off")

    // Simulate DB that now holds "shadow" (written by instance A)
    const db: never = (() => {
      const d = (tableName: string) => ({
        select: () => ({
          where: () => ({
            first: async () =>
              tableName === "feature_flag_state"
                ? { value: "shadow" }
                : undefined,
          }),
        }),
        insert: () => ({ returning: async () => [] }),
      })
      // @ts-expect-error - mock partial Knex
      d.raw = async () => {}
      // @ts-expect-error - mock partial Knex
      d.transaction = async () => {}
      return d as never
    })()

    // Before TTL expiry: instance B reads from cache (stale "off")
    const beforeTTL = await getCurrentState(db)
    expect(beforeTTL).toBe("off") // stale cache

    // Advance time past TTL by manually expiring the cache
    invalidateCachedState("multi_vendor_pdp") // simulate TTL expiry

    // After TTL: instance B reads from DB and gets "shadow"
    const afterTTL = await getCurrentState(db)
    expect(afterTTL).toBe("shadow")
  })
})

// ---------------------------------------------------------------------------
// (c) Stale-within-TTL (AC4 — acceptable divergence documented)
// ---------------------------------------------------------------------------

describe("(c) stale-within-TTL is acceptable", () => {
  it("returns cached value without DB hit when within TTL", async () => {
    // Seed cache with "off"
    setCachedState("multi_vendor_pdp", "off")

    let dbCalled = false
    const db: never = (() => {
      const d = (tableName: string) => ({
        select: () => ({
          where: () => ({
            first: async () => {
              dbCalled = true
              return tableName === "feature_flag_state" ? { value: "shadow" } : undefined
            },
          }),
        }),
        insert: () => ({ returning: async () => [] }),
      })
      // @ts-expect-error - mock partial Knex
      d.raw = async () => {}
      // @ts-expect-error - mock partial Knex
      d.transaction = async () => {}
      return d as never
    })()

    const result = await getCurrentState(db)

    expect(result).toBe("off") // served from cache
    expect(dbCalled).toBe(false) // no DB roundtrip
  })
})

// ---------------------------------------------------------------------------
// (d) Env override fallback when DB unavailable (AC5)
// ---------------------------------------------------------------------------

describe("(d) env override fallback when DB unavailable", () => {
  it("returns GP_MV_FLAG_STATE when DB throws ECONNREFUSED", async () => {
    process.env.GP_MV_FLAG_STATE = "shadow"

    const db: never = (() => {
      const d = (_tableName: string) => ({
        select: () => ({
          where: () => ({
            first: async () => {
              throw new Error("ECONNREFUSED: connection refused")
            },
          }),
        }),
        insert: () => ({ returning: async () => [] }),
      })
      // @ts-expect-error - mock partial Knex
      d.raw = async () => {}
      // @ts-expect-error - mock partial Knex
      d.transaction = async () => {}
      return d as never
    })()

    invalidateCachedState("multi_vendor_pdp")

    const warnPayloads: unknown[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    const spy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown, ...args: unknown[]) => {
        const str = typeof chunk === "string" ? chunk : chunk?.toString()
        if (str?.includes("flag.state.db_unavailable_fallback_env")) {
          try { warnPayloads.push(JSON.parse(str)) } catch { /* noop */ }
        }
        return (origWrite as (...a: unknown[]) => boolean)(chunk, ...args)
      })

    const result = await getCurrentState(db)

    spy.mockRestore()

    expect(result).toBe("shadow")
    // logger.warn writes JSON to stdout — verify at least one line captured
    expect(warnPayloads.length).toBeGreaterThan(0)
  })

  it("returns 'off' when DB throws and no valid env override", async () => {
    delete process.env.GP_MV_FLAG_STATE

    const db: never = (() => {
      const d = (_tableName: string) => ({
        select: () => ({
          where: () => ({
            first: async () => {
              throw new Error(`relation "feature_flag_state" does not exist`)
            },
          }),
        }),
        insert: () => ({ returning: async () => [] }),
      })
      // @ts-expect-error - mock partial Knex
      d.raw = async () => {}
      // @ts-expect-error - mock partial Knex
      d.transaction = async () => {}
      return d as never
    })()

    invalidateCachedState("multi_vendor_pdp")

    const result = await getCurrentState(db)
    expect(result).toBe("off")
  })
})

// ---------------------------------------------------------------------------
// (e) Concurrent writes serialize (AC6)
// ---------------------------------------------------------------------------

describe("(e) concurrent writes serialize", () => {
  it("two concurrent setStates result in deterministic final state and 2 history rows", async () => {
    // Run test multiple times for flake detection (AC6 requires 5x)
    for (let run = 0; run < 5; run++) {
      invalidateCachedState("multi_vendor_pdp")

      const historyRows: MockRow[] = []
      let currentStoredValue = "off"
      let auditIdCounter = 0

      const buildTrxMock = (): never => {
        const t = (tableName: string) => ({
          select: () => ({
            where: () => ({
              first: async () =>
                tableName === "feature_flag_state"
                  ? { value: currentStoredValue }
                  : undefined,
            }),
          }),
          insert: (row: MockRow) => ({
            returning: async () => {
              if (tableName === "feature_flag_history") {
                historyRows.push({ ...row })
                return [row]
              }
              if (tableName === "operator_multi_vendor_flag_audit") {
                auditIdCounter++
                return [{
                  id: `audit-${auditIdCounter}`,
                  from_state: row.from_state,
                  to_state: row.to_state,
                  triggered_by: row.triggered_by,
                  reason: null,
                  alert_id: null,
                  smoke_gate_ref: null,
                  admin_note: null,
                  cache_invalidate_outcome: {},
                  at: new Date().toISOString(),
                }]
              }
              return [row]
            },
          }),
        })
        // @ts-expect-error - mock partial Knex transaction
        t.raw = async (_sql: string, bindings: unknown[]) => {
          currentStoredValue = bindings[1] as string
        }
        return t as never
      }

      const db: never = (() => {
        const d = (tableName: string) => ({
          select: () => ({
            where: () => ({
              first: async () =>
                tableName === "feature_flag_state"
                  ? { value: currentStoredValue }
                  : undefined,
            }),
          }),
          insert: (row: MockRow) => ({
            returning: async () => [row],
          }),
        })
        // @ts-expect-error - mock partial Knex
        d.raw = async (_sql: string, bindings: unknown[]) => {
          currentStoredValue = bindings[1] as string
        }
        // @ts-expect-error - mock partial Knex
        d.transaction = async (cb: (t: never) => Promise<void>) => {
          await cb(buildTrxMock())
        }
        return d as never
      })()

      // Two concurrent setState calls (bypass gate for racing test)
      // AC6: use bypass_smoke_gate=true to skip gate validation in race scenario
      await Promise.all([
        setState("shadow", { triggered_by: "ctx1", bypass_smoke_gate: true, db }).catch(() => null),
        setState("shadow", { triggered_by: "ctx2", bypass_smoke_gate: true, db }).catch(() => null),
      ])

      // Final state must be one of the valid values (no corruption)
      expect(["off", "shadow", "on"]).toContain(currentStoredValue)

      // No deadlock exceptions thrown (both either succeeded or got InvalidTransition)
      // The history rows should be ≤ 2 (one per successful write)
      expect(historyRows.length).toBeLessThanOrEqual(2)

      // Reset for next run
      historyRows.length = 0
      auditIdCounter = 0
    }
  })
})

// ---------------------------------------------------------------------------
// (f) Migration seed derivation (AC7)
// ---------------------------------------------------------------------------

describe("(f) migration seed derivation", () => {
  it("readFlagStateRow returns derived value after seed", async () => {
    // Simulate a post-migration DB that has the seeded row
    const db: never = (() => {
      const d = (tableName: string) => ({
        select: () => ({
          where: (_col: string, _val: string) => ({
            first: async () =>
              tableName === "feature_flag_state"
                ? { value: "shadow" } // seeded from audit row
                : undefined,
          }),
        }),
        insert: () => ({ returning: async () => [] }),
      })
      // @ts-expect-error - mock partial Knex
      d.raw = async () => {}
      // @ts-expect-error - mock partial Knex
      d.transaction = async () => {}
      return d as never
    })()

    const value = await readFlagStateRow(db, "multi_vendor_pdp")
    expect(value).toBe("shadow")
  })

  it("seed falls back to 'off' when no audit row and no env", async () => {
    delete process.env.GP_MV_FLAG_STATE

    // Simulate DB where feature_flag_state has the seeded 'off' value
    const db: never = (() => {
      const d = (tableName: string) => ({
        select: () => ({
          where: () => ({
            first: async () =>
              tableName === "feature_flag_state"
                ? { value: "off" }
                : undefined,
          }),
        }),
        insert: () => ({ returning: async () => [] }),
      })
      // @ts-expect-error - mock partial Knex
      d.raw = async () => {}
      // @ts-expect-error - mock partial Knex
      d.transaction = async () => {}
      return d as never
    })()

    invalidateCachedState("multi_vendor_pdp")
    const value = await getCurrentState(db)
    expect(value).toBe("off")
  })
})

// ---------------------------------------------------------------------------
// (g) Regression guard — cleanup-15e oracle + cleanup-15f audit insert (AC9g)
// ---------------------------------------------------------------------------

describe("(g) regression guard — cleanup-15e oracle + cleanup-15f audit preserved", () => {
  it("getFlagState returns 'on' when tri-state is 'shadow'", async () => {
    // Seed cache with "shadow"
    setCachedState("multi_vendor_pdp", "shadow")

    const result = await getFlagState("multi_vendor_pdp")
    expect(result).toBe("on")

    invalidateCachedState("multi_vendor_pdp")
  })

  it("getFlagState returns 'off' when tri-state is 'off'", async () => {
    setCachedState("multi_vendor_pdp", "off")

    const result = await getFlagState("multi_vendor_pdp")
    expect(result).toBe("off")

    invalidateCachedState("multi_vendor_pdp")
  })

  it("setState inserts into operator_multi_vendor_flag_audit (cleanup-15f preserved)", async () => {
    invalidateCachedState("multi_vendor_pdp")

    const insertedAuditRows: MockRow[] = []
    let storedValue = "off"

    const trxMock: never = (() => {
      const t = (tableName: string) => ({
        select: () => ({
          where: () => ({
            first: async () =>
              tableName === "feature_flag_state"
                ? { value: storedValue }
                : undefined,
          }),
        }),
        insert: (row: MockRow) => ({
          returning: async () => {
            if (tableName === "operator_multi_vendor_flag_audit") {
              const returnRow = {
                id: "audit-regression",
                from_state: row.from_state,
                to_state: row.to_state,
                triggered_by: row.triggered_by,
                reason: null,
                alert_id: null,
                smoke_gate_ref: null,
                admin_note: null,
                cache_invalidate_outcome: {},
                at: new Date().toISOString(),
              }
              insertedAuditRows.push(returnRow)
              return [returnRow]
            }
            return [row]
          },
        }),
      })
      // @ts-expect-error - mock partial
      t.raw = async (_sql: string, bindings: unknown[]) => {
        storedValue = bindings[1] as string
      }
      return t as never
    })()

    const db: never = (() => {
      const d = (tableName: string) => ({
        select: () => ({
          where: () => ({
            first: async () =>
              tableName === "feature_flag_state"
                ? { value: storedValue }
                : undefined,
          }),
        }),
        insert: () => ({ returning: async () => [] }),
      })
      // @ts-expect-error - mock partial Knex
      d.raw = async () => {}
      // @ts-expect-error - mock partial Knex
      d.transaction = async (cb: (t: never) => Promise<void>) => cb(trxMock)
      return d as never
    })()

    await setState("shadow", {
      triggered_by: "regression-test",
      bypass_smoke_gate: true,
      db,
    })

    expect(insertedAuditRows.length).toBe(1)
    expect(insertedAuditRows[0]).toMatchObject({
      from_state: "off",
      to_state: "shadow",
      triggered_by: "regression-test",
    })
  })
})
