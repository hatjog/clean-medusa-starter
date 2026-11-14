/**
 * Story 4.6 AC1/AC2 — rozłączna klasyfikacja porażki zdarzenia (ADR-239).
 */
import { describe, expect, it } from "@jest/globals"

import {
  classifyEventFailure,
  EVENT_FAILURE_CLASSES,
  isDeadLetterClass,
  PermanentEventDataDefectError,
  type EventFailureClass,
} from "../events/event-failure-classification"
import {
  DeadLetterRefusedError,
  INSERT_DLQ_ENTRY_SQL,
  recordEventDeadLetter,
} from "../events/event-dead-letter"

function pgError(code: string, message = "pg"): Error {
  return Object.assign(new Error(message), { code })
}

/** Zdarzenie skonstruowane pod KAŻDĄ klasę — klucz typu wymusza pokrycie całego enumu. */
const CONSTRUCTED: Record<EventFailureClass, unknown[]> = {
  transient_retry: [
    pgError("40P01", "deadlock detected"),
    pgError("57P03"),
    Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
  ],
  permanent_data_defect: [
    new PermanentEventDataDefectError("marker_missing_psp_occurred_at", "brak psp_occurred_at"),
    pgError("23505", "duplicate key"),
    pgError("22P02", "invalid input syntax"),
  ],
  unknown_fail_closed: [new Error("something odd"), "string thrown", null, pgError("42P01", "missing relation")],
}

describe("Story 4.6 — klasyfikacja porażki zdarzenia", () => {
  it("enum klas jest dokładnie pokryty tabelą przypadków (wyczerpanie enumu)", () => {
    expect(Object.keys(CONSTRUCTED).sort()).toEqual([...EVENT_FAILURE_CLASSES].sort())
  })

  for (const expected of EVENT_FAILURE_CLASSES) {
    it(`zdarzenie skonstruowane pod klasę ${expected} trafia dokładnie w nią`, () => {
      for (const err of CONSTRUCTED[expected]) {
        const result = classifyEventFailure(err)
        const hits = EVENT_FAILURE_CLASSES.filter((c) => c === result.event_class)
        expect(hits).toEqual([expected])
        expect(result.reason.startsWith(expected)).toBe(true)
      }
    })
  }

  it("nieznany błąd to nazwana klasa fail-closed, NIE ponowienie", () => {
    const result = classifyEventFailure(new Error("never seen before"))
    expect(result.event_class).toBe("unknown_fail_closed")
    expect(isDeadLetterClass(result.event_class)).toBe(true)
    expect(result.dlq.is_retryable).toBe(false)
    expect(result.dlq.tier).toBe("dlq_pending_ops_review")
  })

  it("tylko transient_retry omija DLQ", () => {
    expect(EVENT_FAILURE_CLASSES.filter((c) => !isDeadLetterClass(c))).toEqual(["transient_retry"])
  })

  it("predykat konsumenta wygrywa z heurystyką timeoutu (nazwana wada danych)", () => {
    const err = new Error("field psp timeout missing")
    const result = classifyEventFailure(err, { permanentDefectCode: () => "path_y_marker_psp_occurred_at" })
    expect(result.event_class).toBe("permanent_data_defect")
    expect(result.dlq.tier).toBe("dlq_pending_ops_review")
    expect(result.dlq.is_retryable).toBe(false)
  })
})

describe("Story 4.6 — writer DLQ", () => {
  function client() {
    const sent: { sql: string; values: unknown[] }[] = []
    return {
      sent,
      query: async (sql: string, values: ReadonlyArray<unknown> = []) => {
        sent.push({ sql, values: [...values] })
        if (sql === INSERT_DLQ_ENTRY_SQL) return { rows: [{ dlq_entry_id: values[0] }] as never[] }
        return { rows: [{ instance_id: null, market_id: null }] as never[] }
      },
    }
  }

  it("odmawia wady przejściowej — ta idzie do ponowienia", async () => {
    const c = client()
    await expect(
      recordEventDeadLetter(c, {
        instance_id: "i", market_id: "m", source_job: "s", event_id: "e", subject_id: "o",
        classification: classifyEventFailure(pgError("40001")), occurred_at: new Date(),
      })
    ).rejects.toMatchObject({ refusal: "transient_not_dead_letter" })
    expect(c.sent.some((q) => q.sql === INSERT_DLQ_ENTRY_SQL)).toBe(false)
  })

  it("odmawia wiersza bez scope'u (AD-44) — nie zgaduje rynku", async () => {
    const c = client()
    await expect(
      recordEventDeadLetter(c, {
        instance_id: "i", market_id: null, source_job: "s", event_id: "e", subject_id: "o",
        classification: classifyEventFailure(new Error("x")), occurred_at: new Date(),
      })
    ).rejects.toBeInstanceOf(DeadLetterRefusedError)
  })

  it("zapisuje wiersz z instance_id, market_id, powodem i terminem 24 h", async () => {
    const c = client()
    const occurred = new Date("2026-11-14T10:00:00Z")
    const out = await recordEventDeadLetter(c, {
      instance_id: "inst", market_id: "mkt", source_job: "src", event_id: "evt", subject_id: "ord",
      classification: classifyEventFailure(new PermanentEventDataDefectError("x", "bad")), occurred_at: occurred,
    })
    expect(out).toEqual({ dlq_entry_id: "src|evt|ord", inserted: true })
    const insert = c.sent.find((q) => q.sql === INSERT_DLQ_ENTRY_SQL)!
    expect(insert.values.slice(0, 3)).toEqual(["src|evt|ord", "inst", "mkt"])
    expect(insert.values[5]).toBe("2026-11-15T10:00:00.000Z")
    expect(String(insert.values[10])).toMatch(/^permanent_data_defect:x/)
    expect(insert.values[11]).toBe("permanent_data_defect")
  })
})
