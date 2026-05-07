/**
 * Story v160-cleanup-40-nudge-dedup — lib-level unit tests for
 * findRecentNotificationLog + assertNotificationLogTableReady +
 * resolveNudgeCooldownHours.
 *
 * All DB calls are mocked via Knex query-builder stubs.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  findRecentNotificationLog,
  assertNotificationLogTableReady,
  resolveNudgeCooldownHours,
  NotificationLogTableUnavailableError,
  NUDGE_DEDUP_COOLDOWN_HOURS_DEFAULT,
  NUDGE_DEDUP_WINDOW_MAX_DAYS,
} from "../../../src/lib/vendor-notification-log"

type AnyFn = (...args: unknown[]) => unknown

// ---------------------------------------------------------------------------
// Knex mock factory
// ---------------------------------------------------------------------------

function makeQueryChain(resolveWith: unknown[] | Error) {
  const orderByMock = jest.fn().mockReturnThis()
  const whereMock = jest.fn().mockReturnThis()
  const limitMock = jest.fn().mockReturnThis()
  const selectMock = jest.fn().mockReturnThis()

  const thenable = {
    then: (resolve: AnyFn, reject: AnyFn) => {
      if (resolveWith instanceof Error) {
        return reject ? reject(resolveWith) : Promise.reject(resolveWith)
      }
      return resolve ? resolve(resolveWith) : Promise.resolve(resolveWith)
    },
    catch: () => undefined,
  }

  const chain: Record<string, unknown> = {
    ...thenable,
    select: selectMock,
    where: whereMock,
    orderBy: orderByMock,
    limit: limitMock,
  }

  selectMock.mockReturnValue(chain)
  whereMock.mockReturnValue(chain)
  orderByMock.mockReturnValue(chain)
  limitMock.mockReturnValue(chain)

  return { chain, selectMock, whereMock, orderByMock, limitMock }
}

function makeKnexStub(resolveWith: unknown[] | Error) {
  const queryChain = makeQueryChain(resolveWith)
  const knex = jest.fn(() => queryChain.chain)
  return { knex, ...queryChain }
}

function makeScope(knex: AnyFn) {
  return {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return knex
      return undefined
    },
  }
}

// ---------------------------------------------------------------------------
// resolveNudgeCooldownHours
// ---------------------------------------------------------------------------

describe("resolveNudgeCooldownHours", () => {
  afterEach(() => {
    delete process.env.GP_NUDGE_DEDUP_COOLDOWN_JSON
  })

  it("returns NUDGE_DEDUP_COOLDOWN_HOURS_DEFAULT (24) when no overrides", () => {
    expect(resolveNudgeCooldownHours("t21")).toBe(NUDGE_DEDUP_COOLDOWN_HOURS_DEFAULT)
    expect(resolveNudgeCooldownHours("t14")).toBe(24)
  })

  it("uses per-step override from caller-supplied map", () => {
    expect(resolveNudgeCooldownHours("t3", { t3: 12 })).toBe(12)
    expect(resolveNudgeCooldownHours("t21", { t3: 12 })).toBe(24)
  })

  it("uses env-level override when set", () => {
    process.env.GP_NUDGE_DEDUP_COOLDOWN_JSON = JSON.stringify({ t7: 6 })
    expect(resolveNudgeCooldownHours("t7")).toBe(6)
    expect(resolveNudgeCooldownHours("t21")).toBe(24)
  })

  it("falls back to default on malformed env JSON", () => {
    process.env.GP_NUDGE_DEDUP_COOLDOWN_JSON = "NOT_JSON"
    expect(resolveNudgeCooldownHours("t21")).toBe(24)
  })
})

// ---------------------------------------------------------------------------
// findRecentNotificationLog
// ---------------------------------------------------------------------------

describe("findRecentNotificationLog", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    jest.setSystemTime(new Date("2026-05-07T12:00:00Z"))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("returns rows from DB when sent_at is within cooldown", async () => {
    const row = {
      id: "log-uuid-1",
      vendor_id: "v_1",
      notification_type: "nudge_t21",
      sent_at: "2026-05-07T10:00:00Z",
      status: "sent",
      locale: "pl",
      recipient_email: "v@ex.com",
      triggered_by: "admin_1",
    }
    const { knex, whereMock } = makeKnexStub([row])
    const scope = makeScope(knex)

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const result = await findRecentNotificationLog(scope, {
      vendor_id: "v_1",
      notification_type: "nudge_t21",
      since_iso: since.toISOString(),
    })

    expect(result).toEqual([row])
    // Should filter on status=sent only (failed/deduplicated do not block)
    expect(whereMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "sent" }),
    )
  })

  it("clamps since_iso to now-7d when cooldown exceeds max window (AC6)", async () => {
    const { knex, whereMock } = makeKnexStub([])
    const scope = makeScope(knex)

    // Provide a since_iso that is older than 7 days
    const wayBack = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    await findRecentNotificationLog(scope, {
      vendor_id: "v_1",
      notification_type: "nudge_t21",
      since_iso: wayBack.toISOString(),
    })

    const expectedClamped = new Date(
      Date.now() - NUDGE_DEDUP_WINDOW_MAX_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString()

    expect(whereMock).toHaveBeenCalledWith("sent_at", ">=", expectedClamped)
  })

  it("does NOT clamp since_iso when within 7-day window", async () => {
    const { knex, whereMock } = makeKnexStub([])
    const scope = makeScope(knex)

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000) // 24h ago
    await findRecentNotificationLog(scope, {
      vendor_id: "v_1",
      notification_type: "nudge_t21",
      since_iso: since.toISOString(),
    })

    expect(whereMock).toHaveBeenCalledWith("sent_at", ">=", since.toISOString())
  })

  it("returns empty array when no matching rows", async () => {
    const { knex } = makeKnexStub([])
    const scope = makeScope(knex)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const result = await findRecentNotificationLog(scope, {
      vendor_id: "v_new",
      notification_type: "nudge_t14",
      since_iso: since.toISOString(),
    })

    expect(result).toEqual([])
  })

  it("boundary — row at now-24h+1s is WITHIN cooldown window (blocks dispatch)", async () => {
    // now = 2026-05-07T12:00:00Z; cooldown = 24h; boundary = 2026-05-06T12:00:00Z
    // Row at boundary+1s: WITHIN window → should appear in results
    const sentAt = new Date(Date.now() - 24 * 60 * 60 * 1000 + 1000).toISOString()
    const row = { id: "log-1", vendor_id: "v_1", notification_type: "nudge_t21", sent_at: sentAt, status: "sent", locale: "pl", recipient_email: "v@ex.com", triggered_by: "a" }
    const { knex } = makeKnexStub([row])
    const scope = makeScope(knex)

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const result = await findRecentNotificationLog(scope, {
      vendor_id: "v_1",
      notification_type: "nudge_t21",
      since_iso: since.toISOString(),
    })

    expect(result.length).toBe(1)
    expect(result[0].id).toBe("log-1")
  })

  it("boundary — row at now-24h-1s is OUTSIDE cooldown window (does not block)", async () => {
    // Row at boundary-1s: OUTSIDE window → DB returns nothing (WHERE filters it)
    const { knex } = makeKnexStub([]) // DB returns empty
    const scope = makeScope(knex)

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const result = await findRecentNotificationLog(scope, {
      vendor_id: "v_1",
      notification_type: "nudge_t21",
      since_iso: since.toISOString(),
    })

    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// assertNotificationLogTableReady
// ---------------------------------------------------------------------------

describe("assertNotificationLogTableReady", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("resolves without error when table is accessible", async () => {
    const { knex } = makeKnexStub([])
    const scope = makeScope(knex)

    await expect(assertNotificationLogTableReady(scope)).resolves.toBeUndefined()
  })

  it("throws NotificationLogTableUnavailableError when table missing (AC7)", async () => {
    const dbErr = new Error("relation \"vendor_notification_log\" does not exist")
    const { knex } = makeKnexStub(dbErr)
    const scope = makeScope(knex)

    await expect(assertNotificationLogTableReady(scope)).rejects.toThrow(
      NotificationLogTableUnavailableError,
    )
  })

  it("NotificationLogTableUnavailableError.code === NUDGE_DEDUP_UNAVAILABLE", async () => {
    const dbErr = new Error("relation does not exist")
    const { knex } = makeKnexStub(dbErr)
    const scope = makeScope(knex)

    let caughtErr: unknown
    try {
      await assertNotificationLogTableReady(scope)
    } catch (err) {
      caughtErr = err
    }

    expect(caughtErr).toBeInstanceOf(NotificationLogTableUnavailableError)
    expect((caughtErr as NotificationLogTableUnavailableError).code).toBe("NUDGE_DEDUP_UNAVAILABLE")
  })

  // -------------------------------------------------------------------------
  // Review F2 — only reclassify "missing table" errors; rethrow transient/auth
  // -------------------------------------------------------------------------

  it("rethrows non-missing-table errors so global handler surfaces them as 500 (Review F2)", async () => {
    const transientErr = new Error("connection terminated unexpectedly") as Error & { code?: string }
    transientErr.code = "ECONNRESET"
    const { knex } = makeKnexStub(transientErr)
    const scope = makeScope(knex)

    await expect(assertNotificationLogTableReady(scope)).rejects.toThrow(
      "connection terminated unexpectedly",
    )
    await expect(assertNotificationLogTableReady(scope)).rejects.not.toBeInstanceOf(
      NotificationLogTableUnavailableError,
    )
  })

  it("identifies missing table via SQLSTATE 42P01 (Review F2)", async () => {
    const pgErr = new Error("relation \"vendor_notification_log\" does not exist") as Error & { code?: string }
    pgErr.code = "42P01"
    const { knex } = makeKnexStub(pgErr)
    const scope = makeScope(knex)

    await expect(assertNotificationLogTableReady(scope)).rejects.toBeInstanceOf(
      NotificationLogTableUnavailableError,
    )
  })

  it("does NOT misclassify auth failure as missing table (Review F2)", async () => {
    const authErr = new Error("password authentication failed for user \"medusa\"") as Error & { code?: string }
    authErr.code = "28P01"
    const { knex } = makeKnexStub(authErr)
    const scope = makeScope(knex)

    await expect(assertNotificationLogTableReady(scope)).rejects.not.toBeInstanceOf(
      NotificationLogTableUnavailableError,
    )
  })
})

// ---------------------------------------------------------------------------
// Review F3 — resolveNudgeCooldownHours rejects invalid values
// ---------------------------------------------------------------------------

describe("resolveNudgeCooldownHours — Review F3 invalid value handling", () => {
  afterEach(() => {
    delete process.env.GP_NUDGE_DEDUP_COOLDOWN_JSON
  })

  it("falls through to default when env override is negative", () => {
    process.env.GP_NUDGE_DEDUP_COOLDOWN_JSON = JSON.stringify({ t21: -1 })
    expect(resolveNudgeCooldownHours("t21")).toBe(NUDGE_DEDUP_COOLDOWN_HOURS_DEFAULT)
  })

  it("falls through to default when env override is zero", () => {
    process.env.GP_NUDGE_DEDUP_COOLDOWN_JSON = JSON.stringify({ t21: 0 })
    expect(resolveNudgeCooldownHours("t21")).toBe(NUDGE_DEDUP_COOLDOWN_HOURS_DEFAULT)
  })

  it("falls through to default when env override is non-finite (Infinity)", () => {
    // JSON.stringify turns Infinity into null, so simulate by writing raw
    process.env.GP_NUDGE_DEDUP_COOLDOWN_JSON = '{"t21": null}'
    expect(resolveNudgeCooldownHours("t21")).toBe(NUDGE_DEDUP_COOLDOWN_HOURS_DEFAULT)
  })

  it("falls through to default when caller-supplied override is negative", () => {
    expect(resolveNudgeCooldownHours("t21", { t21: -5 })).toBe(NUDGE_DEDUP_COOLDOWN_HOURS_DEFAULT)
  })

  it("falls through to default when caller-supplied override is NaN", () => {
    expect(resolveNudgeCooldownHours("t21", { t21: NaN })).toBe(NUDGE_DEDUP_COOLDOWN_HOURS_DEFAULT)
  })
})
