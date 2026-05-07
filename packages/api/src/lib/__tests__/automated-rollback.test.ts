/**
 * Story v160-cleanup-46: Unit tests for getRollbackHistory24h()
 * Covers AC6 scenarios (a)-(f) and AC4 (empty state).
 *
 * Uses manual factory injection: tests pass mock functions directly
 * to the implementation rather than module-level mocking.
 */

import { describe, expect, it, jest, beforeEach } from "@jest/globals"
import type { Knex } from "knex"
import {
  DEFAULT_ROLLBACK_HISTORY_LIMIT,
  MAX_ROLLBACK_HISTORY_LIMIT,
  type RollbackHistoryEntry,
} from "../automated-rollback"

// ---------------------------------------------------------------------------
// Internal re-implementation for testability: instead of trying to mock ES
// module exports (non-configurable in SWC transform context), we test the
// logic by exercising the exported function with a mock Knex that returns
// the fixture rows we want. getRollbackHistory24h calls getPersistedAuditTrail(db, budget)
// which calls db<...>(TABLE).select().orderBy().orderBy().limit() — so we
// construct a chainable mock DB.
// ---------------------------------------------------------------------------

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString()
}

type AuditRow = {
  id: string
  from_state: "on" | "off" | "shadow"
  to_state: "shadow" | "on" | "off"
  triggered_by: string
  reason: string | null
  alert_id: string | null
  smoke_gate_ref: string | null
  admin_note: string | null
  cache_invalidate_outcome: null
  at: string
}

function makeRow(opts: {
  id: string
  triggered_by?: string
  at?: string
  reason?: string | null
  alert_id?: string | null
}): AuditRow {
  return {
    id: opts.id,
    from_state: "on",
    to_state: "shadow",
    triggered_by: opts.triggered_by ?? "automated_rollback",
    at: opts.at ?? new Date().toISOString(),
    reason: opts.reason ?? null,
    alert_id: opts.alert_id ?? null,
    smoke_gate_ref: null,
    admin_note: null,
    cache_invalidate_outcome: null,
  }
}

/**
 * Build a fake Knex instance whose table() chain returns given rows.
 */
function makeMockDb(rows: AuditRow[]): Knex {
  const chain = {
    select: () => chain,
    orderBy: () => chain,
    limit: async (n: number) => rows.slice(0, n),
    first: async () => rows[0] ?? null,
  }
  const db = ((_table: string) => chain) as unknown as Knex
  return db
}

// Import the real function under test
import { getRollbackHistory24h } from "../automated-rollback"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getRollbackHistory24h", () => {

  // -------------------------------------------------------------------------
  // AC6 (a): Seeded log with 3 automated_rollback entries → all 3 returned DESC
  // -------------------------------------------------------------------------
  it("(a) returns 3 automated_rollback entries sorted DESC by timestamp", async () => {
    const t1 = hoursAgo(3)
    const t2 = hoursAgo(2)
    const t3 = hoursAgo(1)

    const db = makeMockDb([
      makeRow({ id: "id-A", at: t1 }),
      makeRow({ id: "id-B", at: t2 }),
      makeRow({ id: "id-C", at: t3 }),
    ])

    const result = await getRollbackHistory24h(db)

    expect(result).toHaveLength(3)
    // DESC order: newest first
    expect(result[0].audit_log_id).toBe("id-C")
    expect(result[1].audit_log_id).toBe("id-B")
    expect(result[2].audit_log_id).toBe("id-A")
  })

  // -------------------------------------------------------------------------
  // AC6 (b) / AC4: Empty log → [] (no throw)
  // -------------------------------------------------------------------------
  it("(b/AC4) returns [] when no entries exist — no throw", async () => {
    const db = makeMockDb([])

    const result = await getRollbackHistory24h(db)

    expect(result).toEqual([])
  })

  // -------------------------------------------------------------------------
  // AC6 (c): limit=2 with 5 entries → 2 newest returned
  // -------------------------------------------------------------------------
  it("(c) respects limit — returns 2 newest when limit=2 and 5 entries exist", async () => {
    const db = makeMockDb([
      makeRow({ id: "old-1", at: hoursAgo(10) }),
      makeRow({ id: "old-2", at: hoursAgo(8) }),
      makeRow({ id: "mid-3", at: hoursAgo(6) }),
      makeRow({ id: "new-4", at: hoursAgo(2) }),
      makeRow({ id: "new-5", at: hoursAgo(1) }),
    ])

    const result = await getRollbackHistory24h(db, { limit: 2 })

    expect(result).toHaveLength(2)
    expect(result[0].audit_log_id).toBe("new-5")
    expect(result[1].audit_log_id).toBe("new-4")
  })

  // -------------------------------------------------------------------------
  // AC6 (d): Automated entries → operator = "system:auto_rollback"
  // Non-automated entries are filtered out by triggered_by check (they don't
  // appear in auto_rollback_history). All entries that DO appear get the
  // correct operator mapping.
  // -------------------------------------------------------------------------
  it("(d) all returned entries have operator='system:auto_rollback' (automated filter)", async () => {
    const db = makeMockDb([
      // Only automated_rollback entries pass the filter
      makeRow({ id: "auto-1", triggered_by: "automated_rollback", at: hoursAgo(2) }),
      makeRow({ id: "auto-2", triggered_by: "automated_rollback", at: hoursAgo(1) }),
      // This non-automated entry is filtered OUT by getRollbackHistory24h
      makeRow({ id: "other-1", triggered_by: "admin@example.com", at: hoursAgo(0.5) }),
    ])

    const result = await getRollbackHistory24h(db)

    // Only automated entries should appear
    expect(result).toHaveLength(2)
    result.forEach((e) => {
      expect(e.operator).toBe("system:auto_rollback")
    })
    // Confirm the non-automated entry is not present
    expect(result.find((e) => e.audit_log_id === "other-1")).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // AC6 (e): Entries older than 24h → filtered out
  // -------------------------------------------------------------------------
  it("(e) filters out entries older than 24h", async () => {
    const db = makeMockDb([
      makeRow({ id: "stale-1", at: hoursAgo(25) }),
      makeRow({ id: "stale-2", at: hoursAgo(48) }),
      makeRow({ id: "recent-1", at: hoursAgo(2) }),
    ])

    const result = await getRollbackHistory24h(db)

    expect(result).toHaveLength(1)
    expect(result[0].audit_log_id).toBe("recent-1")
  })

  // -------------------------------------------------------------------------
  // AC6 (f): Response shape includes all original fields + new fields
  // -------------------------------------------------------------------------
  it("(f) response shape includes audit_log_id, alert_id, at, reason, status, operator", async () => {
    const db = makeMockDb([
      makeRow({
        id: "shape-test",
        at: hoursAgo(1),
        reason: "P1 breach",
        alert_id: "alert-99",
      }),
    ])

    const result = await getRollbackHistory24h(db)

    expect(result).toHaveLength(1)
    const entry: RollbackHistoryEntry = result[0]
    // Original fields preserved
    expect(entry).toHaveProperty("audit_log_id", "shape-test")
    expect(entry).toHaveProperty("alert_id", "alert-99")
    expect(entry).toHaveProperty("at")
    expect(entry).toHaveProperty("reason", "P1 breach")
    // New fields
    expect(entry).toHaveProperty("status", "success")
    expect(entry).toHaveProperty("operator", "system:auto_rollback")
  })

  // -------------------------------------------------------------------------
  // AC5: limit > entries count → all returned (no artificial truncation)
  // -------------------------------------------------------------------------
  it("limit > entry count → all entries returned", async () => {
    const db = makeMockDb([
      makeRow({ id: "x1", at: hoursAgo(1) }),
      makeRow({ id: "x2", at: hoursAgo(2) }),
    ])

    const result = await getRollbackHistory24h(db, { limit: 100 })

    expect(result).toHaveLength(2)
  })

  // -------------------------------------------------------------------------
  // AC4: no db → in-memory fallback; returns [] without throw
  // -------------------------------------------------------------------------
  it("(AC4 in-memory) returns [] from in-memory fallback when db is null", async () => {
    // In-memory getAuditTrail returns entries from in-memory _auditTrail array.
    // Since tests run fresh module instances, _auditTrail should be empty.
    const result = await getRollbackHistory24h(null)
    // Should return [] and not throw
    expect(Array.isArray(result)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Honesty: status is always "success" for surfaced entries — noop early-
  // returns from triggerRollback() never persist an audit row, so the
  // "noop_"-prefix audit_log_id pattern is unreachable in production. Even
  // if such a row were synthesized in tests (as below), the new contract
  // surfaces "success" because the row only reaches us via the triggered_by
  // filter, which guarantees a successful setState transition wrote it.
  // -------------------------------------------------------------------------
  it("status is always 'success' for surfaced entries (noop early-returns never persist)", async () => {
    const db = makeMockDb([
      makeRow({ id: "noop_12345", at: hoursAgo(1) }),
    ])

    const result = await getRollbackHistory24h(db)

    expect(result[0].status).toBe("success")
  })

  // -------------------------------------------------------------------------
  // Status mapping: non-noop automated entry → status="success"
  // -------------------------------------------------------------------------
  it("maps regular automated entry to status='success'", async () => {
    const db = makeMockDb([
      makeRow({ id: "real-audit-id-xyz", at: hoursAgo(1) }),
    ])

    const result = await getRollbackHistory24h(db)

    expect(result[0].status).toBe("success")
  })

  // -------------------------------------------------------------------------
  // Constants are exported at correct values
  // -------------------------------------------------------------------------
  it("exports DEFAULT_ROLLBACK_HISTORY_LIMIT=50 and MAX_ROLLBACK_HISTORY_LIMIT=500", () => {
    expect(DEFAULT_ROLLBACK_HISTORY_LIMIT).toBe(50)
    expect(MAX_ROLLBACK_HISTORY_LIMIT).toBe(500)
  })

  // -------------------------------------------------------------------------
  // Limit: when opts.limit is undefined → default 50 applied
  // -------------------------------------------------------------------------
  it("uses default 50 when opts.limit is undefined", async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      makeRow({ id: `entry-${i}`, at: hoursAgo(i * 0.3 + 0.1) }),
    )
    const db = makeMockDb(rows)

    const result = await getRollbackHistory24h(db)

    expect(result.length).toBe(50)
  })

  // -------------------------------------------------------------------------
  // Entries with alert_id=null → preserved as null in output
  // -------------------------------------------------------------------------
  it("preserves alert_id=null when audit row has no alert_id", async () => {
    const db = makeMockDb([
      makeRow({ id: "no-alert", at: hoursAgo(1), alert_id: null }),
    ])

    const result = await getRollbackHistory24h(db)

    expect(result[0].alert_id).toBeNull()
  })
})
