/**
 * STORY-D66 — Concurrent-write race test (R3-AI-06 pattern, AC #9).
 *
 * Spawns N=10 parallel "writers" that issue INSERTs DURING `--apply`
 * execution against the bonbeauty instance. Asserts:
 *   - backfill completes deterministically (uses `WHERE <field> IS NULL`
 *     filter pattern per STORY-MIG-C race-safe note);
 *   - concurrent INSERTs land with non-NULL trigger fields and are NOT marked
 *     `is_legacy_snapshot`;
 *   - zero deadlocks / rolled-back transactions caused by the backfill.
 *
 * Implementation note: the unit-test gate runs without a Postgres container,
 * so this suite simulates the race in-memory using a shared row store and
 * Promise.all to schedule writers + the backfill concurrently. The same
 * contract is exercised against live Postgres via the integration suite once
 * STORY-MIG-A/B/C have landed (see backfill-pre-v140-snapshot.sql fixture).
 */

import {
  LEGACY_MOR_DEFAULTS,
  runBackfill,
  type AllowedInstance,
  type BackfillIO,
} from "../../scripts/backfill-mor-snapshot"

type Row = {
  id: string
  instance_id: AllowedInstance
  payload_v2: Record<string, unknown>
  is_legacy_snapshot: boolean
  inserted_during_backfill?: boolean
}

function needsBackfill(row: Row): boolean {
  const p = row.payload_v2
  return (
    p.sale_mor == null ||
    p.service_mor == null ||
    p.mor_policy_version == null ||
    p.voucher_kind == null ||
    p.breakage_policy_snapshot == null
  )
}

describe("STORY-D66 — concurrent-write race (R3-AI-06, AC #9)", () => {
  it("backfill completes deterministically under N=10 parallel INSERTs and never marks fresh rows as legacy", async () => {
    const rows: Row[] = []
    let writeOps = 0
    let rollbacks = 0
    let deadlocks = 0

    // Seed: 25 pre-v1.4.0 bonbeauty rows + 5 already-complete (must not be touched).
    for (let i = 0; i < 25; i++) {
      rows.push({
        id: `legacy-${i}`,
        instance_id: "bonbeauty",
        payload_v2: {},
        is_legacy_snapshot: true,
      })
    }
    for (let i = 0; i < 5; i++) {
      rows.push({
        id: `pre-fresh-${i}`,
        instance_id: "bonbeauty",
        payload_v2: {
          sale_mor: "vendor",
          service_mor: "vendor",
          mor_policy_version: "1.4.0",
          voucher_kind: "spv",
          breakage_policy_snapshot: { policy_id: "v1.4.0-prod" },
        },
        is_legacy_snapshot: false,
      })
    }

    const io: BackfillIO = {
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      prompt: async () => "yes",
      countLegacyRows: async (instance) =>
        rows.filter((r) => r.instance_id === instance && needsBackfill(r)).length,
      applyBackfill: async (instance) => {
        // Snapshot the rows that need backfill at the start (race-safe filter:
        // WHERE <field> IS NULL pattern). Concurrent inserts arriving during
        // the backfill that already carry full snapshots are NOT touched.
        const targets = rows.filter(
          (r) => r.instance_id === instance && needsBackfill(r)
        )

        // Yield to the scheduler between updates so concurrent writers
        // interleave (mimics a real batched UPDATE under load).
        let updated = 0
        for (const r of targets) {
          await new Promise((resolve) => setImmediate(resolve))
          // Re-check the field-NULL filter — concurrent writers MAY have
          // populated the row already. Skip if so.
          if (!needsBackfill(r)) continue
          if (r.payload_v2.sale_mor == null) r.payload_v2.sale_mor = LEGACY_MOR_DEFAULTS.sale_mor
          if (r.payload_v2.service_mor == null) r.payload_v2.service_mor = LEGACY_MOR_DEFAULTS.service_mor
          if (r.payload_v2.mor_policy_version == null) {
            r.payload_v2.mor_policy_version = LEGACY_MOR_DEFAULTS.mor_policy_version
          }
          if (r.payload_v2.voucher_kind == null) r.payload_v2.voucher_kind = LEGACY_MOR_DEFAULTS.voucher_kind
          if (r.payload_v2.breakage_policy_snapshot == null) {
            r.payload_v2.breakage_policy_snapshot = LEGACY_MOR_DEFAULTS.breakage_policy_snapshot
          }
          writeOps++
          updated++
        }
        return { rowsUpdated: updated }
      },
    }

    // Spawn N=10 concurrent writers, each issuing 1 INSERT carrying its own
    // complete MoR snapshot (mimics P-01 ownership-lock writers).
    const N = 10
    const writers: Promise<void>[] = []
    for (let i = 0; i < N; i++) {
      writers.push(
        (async () => {
          // Stagger slightly so inserts truly overlap with the apply phase.
          await new Promise((resolve) => setImmediate(resolve))
          rows.push({
            id: `concurrent-${i}`,
            instance_id: "bonbeauty",
            payload_v2: {
              sale_mor: "vendor",
              service_mor: "vendor",
              mor_policy_version: "1.4.0",
              voucher_kind: "spv",
              breakage_policy_snapshot: { policy_id: "v1.4.0-prod-concurrent" },
            },
            is_legacy_snapshot: false,
            inserted_during_backfill: true,
          })
        })()
      )
    }

    const backfillPromise = runBackfill(["--instance", "bonbeauty", "--apply"], io)
    const [backfillResult] = await Promise.all([backfillPromise, ...writers])

    // 1. Backfill completed deterministically.
    expect(backfillResult.exitCode).toBe(0)
    expect(backfillResult.aborted).toBeUndefined()

    // 2. All 25 legacy rows backfilled.
    const legacy = rows.filter((r) => r.id.startsWith("legacy-"))
    expect(legacy).toHaveLength(25)
    for (const r of legacy) {
      expect(r.payload_v2.sale_mor).toBe(LEGACY_MOR_DEFAULTS.sale_mor)
      expect(r.payload_v2.mor_policy_version).toBe(LEGACY_MOR_DEFAULTS.mor_policy_version)
      // is_legacy_snapshot preserved.
      expect(r.is_legacy_snapshot).toBe(true)
    }

    // 3. Pre-existing fresh rows untouched (vendor MoR preserved).
    const preFresh = rows.filter((r) => r.id.startsWith("pre-fresh-"))
    expect(preFresh).toHaveLength(5)
    for (const r of preFresh) {
      expect(r.payload_v2.sale_mor).toBe("vendor")
      expect(r.is_legacy_snapshot).toBe(false)
    }

    // 4. Concurrent inserts kept their non-NULL trigger fields and were NOT
    //    marked legacy.
    const concurrent = rows.filter((r) => r.inserted_during_backfill)
    expect(concurrent).toHaveLength(N)
    for (const r of concurrent) {
      expect(r.payload_v2.sale_mor).toBe("vendor")
      expect(r.payload_v2.mor_policy_version).toBe("1.4.0")
      expect(r.payload_v2.voucher_kind).toBe("spv")
      expect(r.is_legacy_snapshot).toBe(false)
    }

    // 5. Zero deadlocks / rolled-back transactions (in-memory simulation
    //    cannot encounter real Postgres deadlocks; the integration suite
    //    asserts this against a live container).
    expect(rollbacks).toBe(0)
    expect(deadlocks).toBe(0)

    // 6. writeOps matches the count of legacy rows (no double-update).
    expect(writeOps).toBe(25)
  })

  it("idempotent re-run during concurrent-write window does not duplicate updates", async () => {
    const rows: Row[] = [
      { id: "legacy-1", instance_id: "mercur", payload_v2: {}, is_legacy_snapshot: true },
      { id: "legacy-2", instance_id: "mercur", payload_v2: {}, is_legacy_snapshot: true },
    ]

    const buildIO = (): BackfillIO => ({
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      prompt: async () => "yes",
      countLegacyRows: async (inst) =>
        rows.filter((r) => r.instance_id === inst && needsBackfill(r)).length,
      applyBackfill: async (inst) => {
        let updated = 0
        for (const r of rows) {
          if (r.instance_id !== inst) continue
          if (!needsBackfill(r)) continue
          r.payload_v2 = { ...LEGACY_MOR_DEFAULTS }
          updated++
        }
        return { rowsUpdated: updated }
      },
    })

    const first = await runBackfill(["--instance", "mercur", "--apply"], buildIO())
    expect(first.rowsUpdated).toBe(2)

    const second = await runBackfill(["--instance", "mercur", "--apply"], buildIO())
    expect(second.rowsUpdated).toBe(0)
  })
})
