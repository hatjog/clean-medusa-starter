/**
 * STORY-D66 — Audit-flag preservation test (AC #4 + AC #8).
 *
 * Scope: assert that the backfill orchestrator's contract preserves
 * `is_legacy_snapshot=true` on pre-v1.4.0 rows and never marks fresh
 * concurrent writes as legacy.
 *
 * The test uses an in-memory row store as a stand-in for `event_store` so the
 * behavioral contract can be asserted without a live Postgres. The
 * backfill-pre-v140-snapshot.sql fixture mirrors the same logical shape for
 * integration-suite parity (see fixture file's leading comment).
 *
 * Invocation:
 *   cd GP/backend && yarn test:unit -- src/__tests__/scripts/backfill-3-instances-audit-flag.test.ts
 */

import {
  LEGACY_MOR_DEFAULTS,
  runBackfill,
  type AllowedInstance,
  type BackfillIO,
} from "../../scripts/backfill-mor-snapshot"

type FixtureRow = {
  id: string
  instance_id: AllowedInstance
  payload_v2: Record<string, unknown>
  is_legacy_snapshot: boolean
}

function buildFixture(): FixtureRow[] {
  return [
    // bonbeauty — pre-v1.4.0 (is_legacy_snapshot=true, missing MoR fields)
    { id: "bb-01", instance_id: "bonbeauty", payload_v2: {}, is_legacy_snapshot: true },
    { id: "bb-02", instance_id: "bonbeauty", payload_v2: { sale_mor: "operator" }, is_legacy_snapshot: true },
    { id: "bb-03", instance_id: "bonbeauty", payload_v2: {}, is_legacy_snapshot: true },
    // bonbeauty — fresh v1.4.0+ writers (must not be touched)
    {
      id: "bb-fresh",
      instance_id: "bonbeauty",
      payload_v2: {
        sale_mor: "vendor",
        service_mor: "vendor",
        mor_policy_version: "1.4.0",
        voucher_kind: "spv",
        breakage_policy_snapshot: { policy_id: "v1.4.0-prod" },
      },
      is_legacy_snapshot: false,
    },
    // mercur
    { id: "mc-01", instance_id: "mercur", payload_v2: {}, is_legacy_snapshot: true },
    {
      id: "mc-fresh",
      instance_id: "mercur",
      payload_v2: {
        sale_mor: "vendor",
        service_mor: "vendor",
        mor_policy_version: "1.4.0",
        voucher_kind: "spv",
        breakage_policy_snapshot: { policy_id: "v1.4.0-sandbox" },
      },
      is_legacy_snapshot: false,
    },
    // testmarketb
    { id: "tb-01", instance_id: "testmarketb", payload_v2: {}, is_legacy_snapshot: true },
  ]
}

function needsBackfill(row: FixtureRow): boolean {
  const p = row.payload_v2 as Record<string, unknown>
  return (
    p.sale_mor == null ||
    p.service_mor == null ||
    p.mor_policy_version == null ||
    p.voucher_kind == null ||
    p.breakage_policy_snapshot == null
  )
}

function makeFakeStore(rows: FixtureRow[]): {
  io: Pick<BackfillIO, "countLegacyRows" | "applyBackfill">
  rows: FixtureRow[]
} {
  return {
    rows,
    io: {
      countLegacyRows: async (instance) =>
        rows.filter((r) => r.instance_id === instance && needsBackfill(r)).length,
      applyBackfill: async (instance) => {
        let updated = 0
        for (const r of rows) {
          if (r.instance_id !== instance) continue
          if (!needsBackfill(r)) continue

          // Race-safe filter: only fill missing fields. Existing partial values
          // are preserved (mimics the Postgres COALESCE pattern).
          const p = r.payload_v2 as Record<string, unknown>
          if (p.sale_mor == null) p.sale_mor = LEGACY_MOR_DEFAULTS.sale_mor
          if (p.service_mor == null) p.service_mor = LEGACY_MOR_DEFAULTS.service_mor
          if (p.mor_policy_version == null) p.mor_policy_version = LEGACY_MOR_DEFAULTS.mor_policy_version
          if (p.voucher_kind == null) p.voucher_kind = LEGACY_MOR_DEFAULTS.voucher_kind
          if (p.breakage_policy_snapshot == null) {
            p.breakage_policy_snapshot = LEGACY_MOR_DEFAULTS.breakage_policy_snapshot
          }
          // is_legacy_snapshot is NEVER modified by backfill — preserved verbatim.
          updated++
        }
        return { rowsUpdated: updated }
      },
    },
  }
}

function buildIO(
  fakeStore: ReturnType<typeof makeFakeStore>,
  promptAnswer: string
): BackfillIO {
  return {
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
    prompt: async () => promptAnswer,
    countLegacyRows: fakeStore.io.countLegacyRows,
    applyBackfill: fakeStore.io.applyBackfill,
  }
}

describe("STORY-D66 — audit-flag preservation (AC #4)", () => {
  it("preserves is_legacy_snapshot=true on pre-v1.4.0 rows after --apply", async () => {
    const fixture = buildFixture()
    const fake = makeFakeStore(fixture)
    const result = await runBackfill(
      ["--instance", "bonbeauty", "--apply"],
      buildIO(fake, "yes")
    )
    expect(result.exitCode).toBe(0)

    const legacy = fixture.filter(
      (r) => r.instance_id === "bonbeauty" && r.id !== "bb-fresh"
    )
    for (const r of legacy) {
      expect(r.is_legacy_snapshot).toBe(true)
    }
  })

  it("populates new MoR snapshot fields with legacy defaults on backfilled rows", async () => {
    const fixture = buildFixture()
    const fake = makeFakeStore(fixture)
    await runBackfill(["--instance", "bonbeauty", "--apply"], buildIO(fake, "yes"))

    const bb01 = fixture.find((r) => r.id === "bb-01")!
    expect(bb01.payload_v2.sale_mor).toBe(LEGACY_MOR_DEFAULTS.sale_mor)
    expect(bb01.payload_v2.service_mor).toBe(LEGACY_MOR_DEFAULTS.service_mor)
    expect(bb01.payload_v2.mor_policy_version).toBe(LEGACY_MOR_DEFAULTS.mor_policy_version)
    expect(bb01.payload_v2.voucher_kind).toBe(LEGACY_MOR_DEFAULTS.voucher_kind)
    expect(bb01.payload_v2.breakage_policy_snapshot).toEqual(
      LEGACY_MOR_DEFAULTS.breakage_policy_snapshot
    )
  })

  it("preserves partial pre-existing values (e.g. sale_mor already set)", async () => {
    const fixture = buildFixture()
    const fake = makeFakeStore(fixture)
    await runBackfill(["--instance", "bonbeauty", "--apply"], buildIO(fake, "yes"))

    const bb02 = fixture.find((r) => r.id === "bb-02")!
    // Pre-existing value preserved
    expect(bb02.payload_v2.sale_mor).toBe("operator")
    // Missing fields populated with legacy defaults
    expect(bb02.payload_v2.service_mor).toBe(LEGACY_MOR_DEFAULTS.service_mor)
    expect(bb02.payload_v2.voucher_kind).toBe(LEGACY_MOR_DEFAULTS.voucher_kind)
  })

  it("does NOT touch fresh v1.4.0+ rows (already-complete payload_v2)", async () => {
    const fixture = buildFixture()
    const fake = makeFakeStore(fixture)
    await runBackfill(["--instance", "bonbeauty", "--apply"], buildIO(fake, "yes"))

    const fresh = fixture.find((r) => r.id === "bb-fresh")!
    expect(fresh.is_legacy_snapshot).toBe(false)
    // Vendor MoR not flipped to legacy "operator"
    expect(fresh.payload_v2.sale_mor).toBe("vendor")
    expect(fresh.payload_v2.mor_policy_version).toBe("1.4.0")
    expect(fresh.payload_v2.voucher_kind).toBe("spv")
  })

  it("isolates per-instance scope — running --apply on bonbeauty does not affect mercur or testmarketb", async () => {
    const fixture = buildFixture()
    const fake = makeFakeStore(fixture)
    await runBackfill(["--instance", "bonbeauty", "--apply"], buildIO(fake, "yes"))

    const mc01 = fixture.find((r) => r.id === "mc-01")!
    const tb01 = fixture.find((r) => r.id === "tb-01")!
    // mercur + testmarketb still missing MoR snapshot fields (untouched)
    expect(mc01.payload_v2.sale_mor).toBeUndefined()
    expect(tb01.payload_v2.sale_mor).toBeUndefined()
  })

  it("idempotent re-run on the same instance is a no-op (zero additional updates)", async () => {
    const fixture = buildFixture()
    const fake = makeFakeStore(fixture)
    const first = await runBackfill(
      ["--instance", "mercur", "--apply"],
      buildIO(fake, "yes")
    )
    expect(first.exitCode).toBe(0)
    expect((first.rowsUpdated ?? 0) >= 1).toBe(true)

    const second = await runBackfill(
      ["--instance", "mercur", "--apply"],
      buildIO(fake, "yes")
    )
    expect(second.exitCode).toBe(0)
    expect(second.rowsUpdated).toBe(0)
  })
})
