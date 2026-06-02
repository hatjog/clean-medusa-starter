/**
 * event-processed-migration.test.ts — Story 3.2 AC1 (infra idempotencji event-level).
 *
 * Asercja na poziomie emitowanego DDL (bez live PG — quick-gate, wzorzec
 * `voucher-ledger-migration.test.ts`) + semantyka idempotencji (replay ⇒ no-op)
 * na referencyjnym in-memory modelu i prymitywie dedupe-insert.
 *
 * Kontrakt: ADR-137 §Decyzja pkt 3 / DEC-5 pkt 3.i — dedupe po (external_id,
 * event_type), composite PK, `down()` NON-DESTRUKCYJNY (idempotencja append-only).
 */

import { describe, it, expect } from "@jest/globals"
import { Migration1778928000000 } from "../migrations/1778928000000_create_event_processed_table"
import {
  EVENT_PROCESSED_TABLE,
  EVENT_PROCESSED_PK_COLUMNS,
  buildEventProcessedDedupeInsert,
  applyEventProcessedDedup,
  type EventProcessedRow,
} from "../models/event-processed"

function collectSql(method: "up" | "down"): string {
  const sqls: string[] = []
  const fakeThis = { addSql: (s: string) => sqls.push(s) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(Migration1778928000000.prototype as any)[method].call(fakeThis)
  return sqls.join("\n")
}

describe("Story 3.2 AC1 — migracja event_processed (ADR-137 DEC-5 pkt 3.i)", () => {
  const up = collectSql("up")

  it("tworzy tabelę event_processed (event-level dedupe, single-module voucher)", () => {
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS event_processed/)
  })

  it("dedupe po composite PK (external_id, event_type) — gwarant idempotencji", () => {
    expect(up).toMatch(/PRIMARY KEY \(external_id, event_type\)/)
    expect(EVENT_PROCESSED_PK_COLUMNS).toEqual(["external_id", "event_type"])
  })

  it("kolumny minimalne: external_id + event_type (NOT NULL, niepuste) + processed_at epoch-ms", () => {
    expect(up).toMatch(/external_id\s+text NOT NULL CHECK \(char_length\(external_id\) > 0\)/)
    expect(up).toMatch(/event_type\s+text NOT NULL CHECK \(char_length\(event_type\) > 0\)/)
    expect(up).toMatch(/processed_at\s+bigint NOT NULL CHECK \(processed_at > 0\)/)
  })

  it("NIE wprowadza per-entitlement dedupe (entitlement_dedupe_key = Story 3.3, FR10)", () => {
    expect(up).not.toMatch(/entitlement_dedupe_key/)
  })

  it("down() NON-DESTRUKCYJNY: NIE DROP / NIE DELETE / NIE TRUNCATE (idempotencja append-only)", () => {
    const down = collectSql("down")
    expect(down).not.toMatch(/DROP\s+TABLE/i)
    expect(down).not.toMatch(/\bDELETE\b/i)
    expect(down).not.toMatch(/\bTRUNCATE\b/i)
    expect(down.trim()).toBe("")
  })
})

describe("Story 3.2 AC1 — prymityw dedupe-insert (ON CONFLICT DO NOTHING)", () => {
  it("buduje parametryzowany INSERT z ON CONFLICT (external_id, event_type) DO NOTHING", () => {
    const { sql, params } = buildEventProcessedDedupeInsert({
      external_id: "pi_123",
      event_type: "gp.stripe.payment_intent_succeeded.v1",
      processed_at: 1_780_000_000_000,
    })
    expect(sql).toContain(`INSERT INTO ${EVENT_PROCESSED_TABLE}`)
    expect(sql).toContain("ON CONFLICT (external_id, event_type) DO NOTHING")
    expect(params).toEqual([
      "pi_123",
      "gp.stripe.payment_intent_succeeded.v1",
      1_780_000_000_000,
    ])
  })
})

describe("Story 3.2 — idempotencja konsumenta: replay tego samego eventu ⇒ NO-OP", () => {
  const event: EventProcessedRow = {
    external_id: "pi_replay_1",
    event_type: "gp.stripe.payment_intent_succeeded.v1",
    processed_at: 1_780_000_000_000,
  }

  it("pierwsza dostawa: processed=true (nowy wiersz)", () => {
    const store = new Map<string, EventProcessedRow>()
    const first = applyEventProcessedDedup(store, event)
    expect(first.processed).toBe(true)
    expect(store.size).toBe(1)
  })

  it("ponowna dostawa tego samego (external_id, event_type): processed=false (no-op, nie podwaja)", () => {
    const store = new Map<string, EventProcessedRow>()
    applyEventProcessedDedup(store, event)
    const replay = applyEventProcessedDedup(store, {
      ...event,
      processed_at: 1_780_000_999_999, // późniejszy retry
    })
    expect(replay.processed).toBe(false)
    // pierwotny processed_at zachowany (ON CONFLICT DO NOTHING):
    expect(replay.row.processed_at).toBe(1_780_000_000_000)
    expect(store.size).toBe(1) // brak podwojenia
  })

  it("ten sam external_id, INNY event_type ⇒ osobny wiersz (dedupe jest per para)", () => {
    const store = new Map<string, EventProcessedRow>()
    applyEventProcessedDedup(store, event)
    const other = applyEventProcessedDedup(store, {
      ...event,
      event_type: "gp.stripe.payment_intent_succeeded.v2",
    })
    expect(other.processed).toBe(true)
    expect(store.size).toBe(2)
  })
})
