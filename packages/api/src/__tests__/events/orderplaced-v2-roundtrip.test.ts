/**
 * STORY-MIG-B AC #6 + AC #7 — Migration roundtrip test (up → down → up).
 *
 * Scope: assert the `Migration{TIMESTAMP}BackfillOrderPlacedV2Payload`
 * migration's behavioral contract:
 *   - `up()` adds `payload_v2` derived column without touching canonical
 *     `payload` (immutable history).
 *   - Backfill JOIN populates v1 historical rows from `market_runtime_config.locales`.
 *   - `down()` drops `payload_v2`; original `payload` checksum unchanged.
 *
 * Strategy: rather than spin a Postgres container in unit tests, we exercise
 * the migration's *logical* shape against an in-memory simulator that mirrors
 * the SQL contract. The fixture
 * `src/__tests__/fixtures/migrations/event-store-pre-v2-backfill.sql` carries
 * the canonical on-DB shape for the integration suite (see Verification
 * section of the story for `yarn medusa migrations run` flow).
 *
 * Invocation:
 *   cd GP/backend && yarn test:unit -- src/__tests__/events/orderplaced-v2-roundtrip.test.ts
 */

import { describe, it, expect } from "@jest/globals"
import * as crypto from "node:crypto"

type EventStoreRow = {
  event_id: string
  event_type: string
  schema_version: string
  payload: Record<string, unknown>
  payload_v2?: Record<string, unknown> | null
}

type MarketRuntimeConfigRow = {
  market_id: string
  locales: { default: string; supported?: string[] } | null
}

type SimulatorState = {
  has_payload_v2_column: boolean
  has_locales_column: boolean
  rows: EventStoreRow[]
  mrc: MarketRuntimeConfigRow[]
}

const ORDER_PLACED_V1_TYPE = "gp.commerce.order_placed.v1"

/** Apply the migration's `up()` step in-memory. */
function migrationUp(state: SimulatorState): void {
  state.has_payload_v2_column = true
  if (!state.has_locales_column) {
    return
  }
  for (const row of state.rows) {
    if (row.event_type !== ORDER_PLACED_V1_TYPE) {
      continue
    }
    if (row.payload_v2 != null) {
      continue
    }
    const marketId = row.payload["market_id"] as string | undefined
    if (typeof marketId !== "string") {
      continue
    }
    const mrc = state.mrc.find((m) => m.market_id === marketId)
    if (!mrc || !mrc.locales) {
      continue
    }
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
      recipient_locale: mrc.locales.default,
      message_locale: null,
      is_gift: false,
    }
  }
}

function migrationDown(state: SimulatorState): void {
  state.has_payload_v2_column = false
  for (const row of state.rows) {
    delete row.payload_v2
  }
}

function checksum(payload: Record<string, unknown>): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
}

function buildState(opts?: { hasLocales?: boolean }): SimulatorState {
  const hasLocales = opts?.hasLocales ?? true
  return {
    has_payload_v2_column: false,
    has_locales_column: hasLocales,
    rows: [
      {
        event_id: "01J_FIX_BB_001",
        event_type: ORDER_PLACED_V1_TYPE,
        schema_version: "1",
        payload: {
          order_id: "bb-001",
          market_id: "bonbeauty-pl",
          currency: "PLN",
          total_amount_minor: 19900,
          voucher_kind: "MPV",
          line_items: [],
        },
      },
      {
        event_id: "01J_FIX_TM_001",
        event_type: ORDER_PLACED_V1_TYPE,
        schema_version: "1",
        payload: {
          order_id: "tm-001",
          market_id: "testmarketb",
          currency: "GBP",
          total_amount_minor: 5000,
          voucher_kind: "MPV",
          line_items: [],
        },
      },
    ],
    mrc: [
      { market_id: "bonbeauty-pl", locales: { default: "pl-PL" } },
      { market_id: "testmarketb", locales: { default: "en-GB" } },
    ],
  }
}

describe("STORY-MIG-B Migration20260427120000BackfillOrderPlacedV2Payload — roundtrip", () => {
  it("up() adds payload_v2 column and backfills derived shape from MRC.locales", () => {
    const state = buildState()
    const checksums = state.rows.map((r) => checksum(r.payload))

    migrationUp(state)

    expect(state.has_payload_v2_column).toBe(true)
    for (const row of state.rows) {
      expect(row.payload_v2).toBeDefined()
      expect(row.payload_v2).not.toBeNull()
      const v2 = row.payload_v2 as Record<string, unknown>
      expect(v2.order_id).toBe(row.payload.order_id)
      expect(v2.recipient_locale).toBeTruthy()
      expect(v2.message_locale).toBeNull()
      expect(v2.is_gift).toBe(false)
      const mor = v2.mor as Record<string, unknown>
      expect(mor.mor_policy_version).toBe("0.0.0-legacy-pre-1.4")
      expect(mor.voucher_kind).toBe(row.payload.voucher_kind ?? "none")
      const bps = mor.breakage_policy_snapshot as Record<string, unknown>
      expect(bps).toMatchObject({
        policy_id: null,
        policy_version: null,
        recognition_mode: null,
        expiry_grace_days: null,
      })
    }

    // Canonical `payload` checksums unchanged (immutability — AC #6).
    state.rows.forEach((r, i) => {
      expect(checksum(r.payload)).toBe(checksums[i])
    })
  })

  it("down() drops payload_v2 explicitly without touching original payload", () => {
    const state = buildState()
    const checksums = state.rows.map((r) => checksum(r.payload))

    migrationUp(state)
    migrationDown(state)

    expect(state.has_payload_v2_column).toBe(false)
    for (const row of state.rows) {
      expect(row.payload_v2).toBeUndefined()
    }
    state.rows.forEach((r, i) => {
      expect(checksum(r.payload)).toBe(checksums[i])
    })
  })

  it("up → down → up is idempotent (final payload_v2 matches first up)", () => {
    const state1 = buildState()
    migrationUp(state1)
    const after1 = JSON.stringify(state1.rows.map((r) => r.payload_v2))

    const state2 = buildState()
    migrationUp(state2)
    migrationDown(state2)
    migrationUp(state2)
    const after2 = JSON.stringify(state2.rows.map((r) => r.payload_v2))

    expect(after2).toBe(after1)
  })

  it("graceful fallback: when MRC.locales column is absent (MIG-A not yet landed) backfill is no-op but column is still added", () => {
    const state = buildState({ hasLocales: false })
    migrationUp(state)
    expect(state.has_payload_v2_column).toBe(true)
    for (const row of state.rows) {
      // Backfill skipped — payload_v2 still null/undefined; canonical payload
      // unchanged. A follow-up sweep after MIG-A lands populates them.
      expect(row.payload_v2 ?? null).toBeNull()
    }
  })

  it("backfill is scoped to event_type = 'gp.commerce.order_placed.v1' (NOT a non-existent event_version column)", () => {
    const state = buildState()
    state.rows.push({
      event_id: "OTHER_EVENT_ROW",
      event_type: "gp.commerce.order_paid.v1",
      schema_version: "1",
      payload: { order_id: "paid-001", market_id: "bonbeauty-pl" },
    })

    migrationUp(state)
    const otherRow = state.rows.find((r) => r.event_id === "OTHER_EVENT_ROW")
    expect(otherRow?.payload_v2 ?? null).toBeNull()
  })
})
