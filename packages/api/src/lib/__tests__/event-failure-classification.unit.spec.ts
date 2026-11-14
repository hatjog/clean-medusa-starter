/**
 * Story 4.6 AC1/AC2 — rozłączna klasyfikacja porażki zdarzenia (ADR-239).
 */
import { describe, expect, it } from "@jest/globals"

import {
  classifyEventFailure,
  EVENT_FAILURE_CLASSES,
  isDeadLetterClass,
  PermanentEventDataDefectError,
  TRANSIENT_SOCKET_ERROR_CODES,
  type EventFailureClass,
} from "../events/event-failure-classification"
import {
  DeadLetterRefusedError,
  dlqEntryId,
  INSERT_DLQ_ENTRY_SQL,
  recordEventDeadLetter,
  SELECT_OWN_DLQ_ENTRY_SQL,
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
    expect(out).toEqual({ dlq_entry_id: "inst|mkt|src|evt|ord", inserted: true })
    const insert = c.sent.find((q) => q.sql === INSERT_DLQ_ENTRY_SQL)!
    expect(insert.values.slice(0, 3)).toEqual(["inst|mkt|src|evt|ord", "inst", "mkt"])
    expect(insert.values[5]).toBe("2026-11-15T10:00:00.000Z")
    expect(String(insert.values[10])).toMatch(/^permanent_data_defect:x/)
    expect(insert.values[11]).toBe("permanent_data_defect")
  })
})

describe("Story 4.6 runda fix 1 (R-5) — błędy gniazda node-pg bez SQLSTATE są przejściowe", () => {
  const sockets: [string, unknown][] = [
    ...[...TRANSIENT_SOCKET_ERROR_CODES].map(
      (code) => [code, Object.assign(new Error(`connect ${code} 127.0.0.1:5432`), { code, errno: -1, syscall: "connect" })] as [string, unknown]
    ),
    ["Connection terminated unexpectedly", new Error("Connection terminated unexpectedly")],
    ["Connection terminated due to connection timeout", new Error("Connection terminated due to connection timeout")],
    ["pg-pool: timeout exceeded when trying to connect", new Error("timeout exceeded when trying to connect")],
    ["Client has encountered a connection error", new Error("Client has encountered a connection error and is not queryable")],
  ]

  it.each(sockets)("%s → transient_retry (ponowienie, nie DLQ)", (_name, err) => {
    const result = classifyEventFailure(err)
    expect(result.event_class).toBe("transient_retry")
    expect(isDeadLetterClass(result.event_class)).toBe(false)
    expect(result.dlq.tier).toBe("transient")
    expect(result.dlq.is_retryable).toBe(true)
  })

  it("niesieciowy kod systemowy (ENOENT) nadal NIE jest ponowieniem — brak klasy domyślnej retry", () => {
    expect(classifyEventFailure(Object.assign(new Error("no such file"), { code: "ENOENT" })).event_class).toBe(
      "unknown_fail_closed"
    )
  })

  it("SQLSTATE wygrywa z komunikatem: 23505 z 'Connection terminated' w treści to wada danych", () => {
    expect(classifyEventFailure(pgError("23505", "Connection terminated by dup")).event_class).toBe(
      "permanent_data_defect"
    )
  })

  it("nazwana wada konsumenta wygrywa z kodem gniazda (klasy rozłączne)", () => {
    const err = Object.assign(new Error("x"), { code: "ECONNRESET" })
    expect(classifyEventFailure(err, { permanentDefectCode: () => "named" }).event_class).toBe("permanent_data_defect")
  })
})

describe("Story 4.6 runda fix 1 (R-7) — oś zakresu w kluczu i nazwana kolizja", () => {
  it("ten sam event/subject w dwóch zakresach daje RÓŻNE dlq_entry_id", () => {
    expect(dlqEntryId("i", "market-a", "s", "e", "o")).not.toBe(dlqEntryId("i", "market-b", "s", "e", "o"))
    expect(dlqEntryId("i-a", "m", "s", "e", "o")).not.toBe(dlqEntryId("i-b", "m", "s", "e", "o"))
  })

  function conflicting(ownVisible: boolean) {
    const sent: string[] = []
    return {
      sent,
      query: async (sql: string, values: ReadonlyArray<unknown> = []) => {
        sent.push(sql)
        if (sql === INSERT_DLQ_ENTRY_SQL) return { rows: [] as never[] }
        if (sql === SELECT_OWN_DLQ_ENTRY_SQL) return { rows: (ownVisible ? [{ dlq_entry_id: values[0] }] : []) as never[] }
        return { rows: [{ instance_id: null, market_id: null }] as never[] }
      },
    }
  }
  const input = {
    instance_id: "inst", market_id: "mkt", source_job: "src", event_id: "evt", subject_id: "ord",
    classification: classifyEventFailure(new PermanentEventDataDefectError("x", "bad")), occurred_at: new Date(),
  }

  it("konflikt z wierszem WŁASNEGO zakresu = powtórka: inserted=false bez błędu", async () => {
    await expect(recordEventDeadLetter(conflicting(true), input)).resolves.toEqual({
      dlq_entry_id: "inst|mkt|src|evt|ord",
      inserted: false,
    })
  })

  it("konflikt z wierszem niewidocznym pod RLS = nazwana odmowa scope_collision, nie ciche inserted=false", async () => {
    await expect(recordEventDeadLetter(conflicting(false), input)).rejects.toMatchObject({
      name: "DeadLetterRefusedError",
      refusal: "scope_collision",
    })
  })
})

describe("Story 4.6 runda fix 2 — błąd połączenia w kształcie z Knexa (`<sql> - <komunikat>`)", () => {
  // Realny executeQuery z knex 3.2.8 — ten sam kod, który przepisuje err.message na ścieżce PG_CONNECTION.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { executeQuery } = require("knex/lib/execution/internal/query-executioner")
  const knexError = async (message: string): Promise<unknown> => {
    const client = {
      config: { compileSqlOnError: false },
      _query: () => Promise.reject(new Error(message)),
      emit: () => undefined,
    }
    try {
      await executeQuery({}, { sql: "select 1", bindings: [] }, client)
    } catch (err) {
      return err
    }
    throw new Error("executeQuery nie odrzucił")
  }

  it.each([
    ["Connection terminated unexpectedly"],
    ["Connection terminated due to connection timeout"],
    ["Client was closed and is not queryable"],
    ["Client has encountered a connection error and is not queryable"],
    ["timeout exceeded when trying to connect"],
  ])("select 1 - %s → transient_retry", async (msg) => {
    const err = (await knexError(msg)) as Error
    expect(err.message).toBe(`select 1 - ${msg}`)
    expect(classifyEventFailure(err).event_class).toBe("transient_retry")
  })

  it("tekst 'connection terminated' w środku SQL (bez separatora ` - `) nie jest retry — brak rozszerzenia na dowolny tekst", () => {
    expect(classifyEventFailure(new Error("select 'xconnection terminated'")).event_class).toBe("unknown_fail_closed")
  })
})
