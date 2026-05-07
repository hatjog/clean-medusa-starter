import { beforeEach, describe, expect, it } from "@jest/globals"

import {
  getCurrentState,
  getPersistedAuditTrail,
  getPersistedLastTransitionInfo,
  invalidateCachedState,
  setState,
} from "../../lib/feature-flag-tri-state"

type PersistedAuditRow = {
  id: string
  from_state: "off" | "shadow" | "on"
  to_state: "off" | "shadow" | "on"
  triggered_by: string
  reason: string | null
  alert_id: string | null
  smoke_gate_ref: string | null
  admin_note: string | null
  cache_invalidate_outcome: unknown
  at: string
}

/**
 * Story v160-cleanup-50 update: getCurrentState now reads from
 * `feature_flag_state` (DB-backed). The mock supports both:
 *   - feature_flag_state: keyed by flag_id, derived from latest audit row.
 *   - operator_multi_vendor_flag_audit: full audit history (legacy).
 *   - feature_flag_history: minimal value trail (cleanup-50 NEW).
 * setState writes via db.transaction so the mock exposes one too.
 */
function createFlagAuditDb(initialRows: PersistedAuditRow[] = []) {
  const rows = [...initialRows]
  const flagState = new Map<string, string>()
  const history: Array<Record<string, unknown>> = []

  // Seed flag_state from latest audit row so getCurrentState reflects it.
  const seed = [...rows].sort((a, b) => b.at.localeCompare(a.at))[0]
  if (seed) flagState.set("multi_vendor_pdp", seed.to_state)

  const buildTable = (table: string, isTrx: boolean) => {
    if (table === "feature_flag_state") {
      const builder: Record<string, unknown> = {
        select() {
          return this
        },
        where(_col: unknown, val: unknown) {
          ;(this as { _flagId?: unknown })._flagId = val
          return this
        },
        forUpdate() {
          return this
        },
        async first() {
          const v = flagState.get(
            ((this as { _flagId?: string })._flagId as string) ?? "multi_vendor_pdp",
          )
          return v ? { value: v } : undefined
        },
      }
      return builder
    }
    if (table === "feature_flag_history") {
      return {
        async insert(payload: Record<string, unknown>) {
          history.push(payload)
        },
      }
    }
    if (table === "operator_multi_vendor_flag_audit") {
      return {
        select() {
          return this
        },
        orderBy() {
          return this
        },
        async first() {
          return [...rows].sort((a, b) => b.at.localeCompare(a.at))[0] ?? null
        },
        async limit(limit: number) {
          return [...rows]
            .sort((a, b) => b.at.localeCompare(a.at))
            .slice(0, limit)
        },
        insert(payload: Omit<PersistedAuditRow, "id" | "at">) {
          const inserted: PersistedAuditRow = {
            id: `db_${rows.length + 1}`,
            at: new Date(1_700_000_000_000 + rows.length).toISOString(),
            ...payload,
          }
          rows.push(inserted)
          // Reflect into state map so subsequent getCurrentState observes it.
          if (isTrx) flagState.set("multi_vendor_pdp", inserted.to_state)
          return {
            async returning() {
              return [inserted]
            },
          }
        },
      }
    }
    throw new Error(`unexpected table ${table}`)
  }

  const buildDb = (isTrx: boolean) => {
    const fn = (table: string) => buildTable(table, isTrx)
    ;(fn as unknown as { raw: Function }).raw = async (
      _sql: string,
      bindings: unknown[],
    ) => {
      // upsertFlagState UPSERT path
      flagState.set(bindings[0] as string, bindings[1] as string)
    }
    if (!isTrx) {
      ;(fn as unknown as { transaction: Function }).transaction = async (
        cb: (trx: unknown) => Promise<void>,
      ) => {
        await cb(buildDb(true))
      }
    }
    return fn
  }

  const db = buildDb(false) as unknown as import("knex").Knex

  return { db, rows, history }
}

describe("feature-flag-tri-state persistence", () => {
  beforeEach(() => {
    invalidateCachedState("multi_vendor_pdp")
  })
  it("reads current state and last transition info from persisted audit rows", async () => {
    const { db } = createFlagAuditDb([
      {
        id: "db_1",
        from_state: "off",
        to_state: "shadow",
        triggered_by: "operator_a",
        reason: null,
        alert_id: null,
        smoke_gate_ref: null,
        admin_note: "prepare rollout",
        cache_invalidate_outcome: {},
        at: "2026-05-05T10:00:00.000Z",
      },
      {
        id: "db_2",
        from_state: "shadow",
        to_state: "on",
        triggered_by: "operator_b",
        reason: null,
        alert_id: null,
        smoke_gate_ref: "rat_1",
        admin_note: "go live",
        cache_invalidate_outcome: {},
        at: "2026-05-05T10:05:00.000Z",
      },
    ])

    await expect(getCurrentState(db)).resolves.toBe("on")
    await expect(getPersistedLastTransitionInfo(db)).resolves.toMatchObject({
      last_transitioned_at: "2026-05-05T10:05:00.000Z",
      last_admin: "operator_b",
    })
  })

  it("persists transitions into the durable audit table when db is provided", async () => {
    const { db, rows } = createFlagAuditDb()

    const result = await setState("shadow", {
      triggered_by: "operator_c",
      admin_note: "persist me",
      bypass_smoke_gate: true,
      db,
    })

    expect(result).toMatchObject({
      from: "off",
      to: "shadow",
      audit_log_id: "db_1",
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      from_state: "off",
      to_state: "shadow",
      triggered_by: "operator_c",
      admin_note: "persist me",
    })
    await expect(getPersistedAuditTrail(db, 10)).resolves.toMatchObject([
      {
        audit_log_id: "db_1",
        from: "off",
        to: "shadow",
      },
    ])
  })
})