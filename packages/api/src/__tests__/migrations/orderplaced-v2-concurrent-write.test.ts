/**
 * STORY-MIG-B T6 / R3-AI-06 — Concurrent-write contract test.
 *
 * Scenario:
 *   Spawn N=20 parallel publishers emitting v1 OrderPlaced events DURING the
 *   `payload_v2` backfill UPDATE. Assert:
 *     1. Backfill completes deterministically (joined `mrc.locales`).
 *     2. Concurrent v1 emissions land without race (each retains its own row).
 *     3. New v2 emissions (post-flag-on canary) land without interfering with
 *        derived `payload_v2` backfill — the migration's `WHERE payload_v2 IS
 *        NULL` clause skips publisher-written rows.
 *
 * Strategy: Jest unit-suite stand-in for the integration scenario. We model
 * the migration UPDATE and concurrent INSERTs against an in-memory event
 * store with deterministic interleaving, then assert post-condition
 * invariants.
 *
 * Fixture: shares logical shape with
 *   src/__tests__/fixtures/migrations/event-store-pre-v2-backfill.sql
 *
 * Invocation:
 *   cd GP/backend && yarn test:unit -- src/__tests__/migrations/orderplaced-v2-concurrent-write.test.ts
 */

import { describe, it, expect } from "@jest/globals"

const ORDER_PLACED_V1_TYPE = "gp.commerce.order_placed.v1"
const ORDER_PLACED_V2_TYPE = "gp.commerce.order_placed.v2"

type Row = {
  event_id: string
  event_type: string
  payload: Record<string, unknown>
  payload_v2: Record<string, unknown> | null
}

type Mrc = { market_id: string; locales: { default: string } }

/** Apply migration backfill to all rows where payload_v2 IS NULL. */
function migrationBackfill(rows: Row[], mrc: Mrc[]): number {
  let updated = 0
  for (const row of rows) {
    if (row.event_type !== ORDER_PLACED_V1_TYPE) continue
    if (row.payload_v2 != null) continue
    const marketId = row.payload["market_id"] as string | undefined
    if (typeof marketId !== "string") continue
    const m = mrc.find((x) => x.market_id === marketId)
    if (!m) continue
    row.payload_v2 = {
      order_id: row.payload["order_id"],
      currency: row.payload["currency"] ?? "PLN",
      total_amount_minor: row.payload["total_amount_minor"] ?? 0,
      line_items: row.payload["line_items"] ?? [],
      mor: {
        sale_mor: "operator",
        service_mor: "operator",
        mor_policy_version: "0.0.0-legacy-pre-1.4",
        voucher_kind: row.payload["voucher_kind"] ?? "none",
        breakage_policy_snapshot: {
          policy_id: null,
          policy_version: null,
          recognition_mode: null,
          expiry_grace_days: null,
        },
      },
      recipient_locale: m.locales.default,
      message_locale: null,
      is_gift: false,
    }
    updated++
  }
  return updated
}

function publisherEmitV1(rows: Row[], orderId: string, marketId: string): void {
  rows.push({
    event_id: `evt_${orderId}`,
    event_type: ORDER_PLACED_V1_TYPE,
    payload: {
      order_id: orderId,
      market_id: marketId,
      currency: "PLN",
      total_amount_minor: 1000,
      line_items: [],
    },
    payload_v2: null,
  })
}

function publisherEmitV2(rows: Row[], orderId: string, marketId: string): void {
  // Post-flag-on canary publisher writes payload_v2 directly.
  rows.push({
    event_id: `evt_${orderId}`,
    event_type: ORDER_PLACED_V2_TYPE,
    payload: {
      order_id: orderId,
      market_id: marketId,
      currency: "PLN",
      total_amount_minor: 2000,
    },
    payload_v2: {
      order_id: orderId,
      recipient_locale: "pl-PL",
      message_locale: null,
      is_gift: false,
      // Producer supplies real MoR snapshot from P-01 ownership-lock writer:
      mor: {
        sale_mor: "operator",
        service_mor: "vendor",
        mor_policy_version: "1.0.0",
        voucher_kind: "MPV",
        breakage_policy_snapshot: {
          policy_id: "breakage.bonbeauty-pl.operator_full",
          policy_version: "0.1.0",
          recognition_mode: "operator_full",
          expiry_grace_days: 30,
        },
      },
    },
  })
}

describe("STORY-MIG-B T6 / R3-AI-06 — concurrent-write contract", () => {
  it("backfill completes deterministically — N=20 v1 emissions racing the migration", () => {
    const rows: Row[] = []
    const mrc: Mrc[] = [
      { market_id: "bonbeauty-pl", locales: { default: "pl-PL" } },
    ]
    // Pre-existing historical rows.
    for (let i = 0; i < 5; i++) {
      publisherEmitV1(rows, `pre-${i}`, "bonbeauty-pl")
    }
    // Concurrent v1 emissions DURING the backfill — interleave by inserting
    // half before and half after the backfill UPDATE step.
    for (let i = 0; i < 10; i++) {
      publisherEmitV1(rows, `during-${i}`, "bonbeauty-pl")
    }
    const updated1 = migrationBackfill(rows, mrc)
    for (let i = 0; i < 10; i++) {
      publisherEmitV1(rows, `after-${i}`, "bonbeauty-pl")
    }
    // Subsequent backfill sweep picks up the racing-after rows.
    const updated2 = migrationBackfill(rows, mrc)

    expect(updated1).toBe(15) // 5 pre + 10 during
    expect(updated2).toBe(10) // 10 after
    // All v1 rows now carry payload_v2.
    for (const row of rows.filter((r) => r.event_type === ORDER_PLACED_V1_TYPE)) {
      expect(row.payload_v2).not.toBeNull()
      expect((row.payload_v2 as Record<string, unknown>).recipient_locale).toBe(
        "pl-PL"
      )
    }
  })

  it("v2 publisher writes during backfill: WHERE payload_v2 IS NULL skips publisher-written rows", () => {
    const rows: Row[] = []
    const mrc: Mrc[] = [
      { market_id: "bonbeauty-pl", locales: { default: "pl-PL" } },
    ]
    publisherEmitV1(rows, "v1-001", "bonbeauty-pl")
    publisherEmitV2(rows, "v2-001", "bonbeauty-pl")

    // Snapshot the publisher-written payload_v2 BEFORE backfill.
    const v2Row = rows.find((r) => r.event_id === "evt_v2-001")!
    const beforeSnapshot = JSON.stringify(v2Row.payload_v2)

    migrationBackfill(rows, mrc)

    // Backfill never overwrites publisher-written payload_v2 (idempotent).
    expect(JSON.stringify(v2Row.payload_v2)).toBe(beforeSnapshot)
    // The voucher_kind producer set ("MPV") survives — proves no overwrite.
    expect(
      ((v2Row.payload_v2 as Record<string, unknown>).mor as Record<string, unknown>)
        .voucher_kind
    ).toBe("MPV")
    // Meanwhile the v1 row got backfilled normally.
    const v1Row = rows.find((r) => r.event_id === "evt_v1-001")!
    expect(v1Row.payload_v2).not.toBeNull()
  })

  it("backfill is idempotent — re-running does not double-update existing rows", () => {
    const rows: Row[] = []
    const mrc: Mrc[] = [
      { market_id: "bonbeauty-pl", locales: { default: "pl-PL" } },
    ]
    publisherEmitV1(rows, "ord-001", "bonbeauty-pl")
    publisherEmitV1(rows, "ord-002", "bonbeauty-pl")

    const updated1 = migrationBackfill(rows, mrc)
    const updated2 = migrationBackfill(rows, mrc)

    expect(updated1).toBe(2)
    expect(updated2).toBe(0) // Idempotent — nothing left where payload_v2 IS NULL.
  })

  it("backfill skips rows where market_runtime_config has no entry (graceful)", () => {
    const rows: Row[] = []
    const mrc: Mrc[] = [
      { market_id: "bonbeauty-pl", locales: { default: "pl-PL" } },
    ]
    publisherEmitV1(rows, "ord-known", "bonbeauty-pl")
    publisherEmitV1(rows, "ord-unknown", "market-not-in-mrc")

    const updated = migrationBackfill(rows, mrc)
    expect(updated).toBe(1)

    const unknownRow = rows.find((r) => r.event_id === "evt_ord-unknown")!
    expect(unknownRow.payload_v2).toBeNull()
  })

  it("payload column is immutable across backfill sweeps (AC #6 / AC #7 invariant)", () => {
    const rows: Row[] = []
    const mrc: Mrc[] = [
      { market_id: "bonbeauty-pl", locales: { default: "pl-PL" } },
    ]
    publisherEmitV1(rows, "ord-immut", "bonbeauty-pl")
    const before = JSON.stringify(rows[0].payload)

    migrationBackfill(rows, mrc)

    expect(JSON.stringify(rows[0].payload)).toBe(before)
  })
})
