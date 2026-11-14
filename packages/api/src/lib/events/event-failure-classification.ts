/**
 * event-failure-classification.ts — v1.16.0 Story 4.6 (FR-14, AD-32, NFR-4; ADR-239).
 *
 * Rozłączna klasyfikacja porażki przetwarzania zdarzenia. Trzy klasy, każda
 * NAZWANA, żadna nie jest domyślnym „spróbuj jeszcze raz”:
 *
 *  - `transient_retry`       — wada przejściowa (timeout, deadlock, utrata
 *                              połączenia). Skutek: ponowienie, NIGDY DLQ.
 *  - `permanent_data_defect` — trwała wada danych (nazwany błąd wejścia
 *                              konsumenta albo SQLSTATE klasy 22/23). Skutek: DLQ.
 *  - `unknown_fail_closed`   — wszystko inne. Skutek: DLQ do przeglądu ops,
 *                              nie ponowienie w nieskończoność.
 *
 * Mapowanie na pola nośnika (`tier`, `failure_mode`, `sqlstate`) bierze
 * istniejący, total-owy klasyfikator `modules/mor-policy/dlq.ts` — ta funkcja go
 * nie powiela, tylko rozstrzyga klasę zdarzenia.
 */
import { classifyFailure, type DlqClassification } from "../../modules/mor-policy/dlq"

export const EVENT_FAILURE_CLASSES = [
  "transient_retry",
  "permanent_data_defect",
  "unknown_fail_closed",
] as const

export type EventFailureClass = (typeof EVENT_FAILURE_CLASSES)[number]

export type EventFailureClassification = {
  event_class: EventFailureClass
  /** Powód klasyfikacji (niepusty) — trafia do `reason` wiersza DLQ. */
  reason: string
  /** Wynik klasyfikatora nośnika (tier/failure_mode/sqlstate). */
  dlq: DlqClassification
}

/**
 * Nazwana trwała wada danych zgłaszana przez konsumenta. Konsument, który
 * WIE, że wejście jest nieodtwarzalne, rzuca (albo opakowuje) tym typem —
 * zamiast liczyć na heurystykę po komunikacie.
 */
export class PermanentEventDataDefectError extends Error {
  constructor(
    readonly defect_code: string,
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = "PermanentEventDataDefectError"
  }
}

/** SQLSTATE klas oznaczających wadę DANYCH (22 data exception, 23 integrity). */
const DATA_DEFECT_SQLSTATE_CLASSES = new Set(["22", "23"])

export type ClassifyOptions = {
  /** Predykat konsumenta: zwraca kod wady, gdy błąd jest jego nazwaną trwałą wadą danych. */
  permanentDefectCode?: (err: unknown) => string | null
}

/**
 * Kody błędów systemowych gniazda (node `net`/`dns`), z którymi node-pg
 * zgłasza utratę połączenia BEZ SQLSTATE. To wady przejściowe — bez tego
 * rozpoznania szły do DLQ jako `non-PG error` (runda fix 1, R-5).
 */
export const TRANSIENT_SOCKET_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
])

/** Komunikaty node-pg / pg-pool o zerwanym albo nienawiązanym połączeniu (bez `code`). */
const TRANSIENT_CONNECTION_MESSAGES = [
  // Knex (executeQuery) przepisuje message na `<sql> - <komunikat>`: początek albo sufiks po ` - `.
  /(?:^| - )connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /client has encountered a connection error and is not queryable/i,
  /client was closed and is not queryable/i,
]

/** Kod błędu gniazda, gdy `err` jest utratą połączenia bez SQLSTATE; inaczej `null`. */
export function transientConnectionSignal(err: unknown): string | null {
  if (err === null || typeof err !== "object") return null
  const code = (err as { code?: unknown }).code
  if (typeof code === "string" && TRANSIENT_SOCKET_ERROR_CODES.has(code)) return code
  // Kod SQLSTATE (5 znaków) rozstrzyga klasyfikator nośnika — nie nadpisujemy go.
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return null
  const message = String((err as { message?: unknown }).message ?? "")
  return TRANSIENT_CONNECTION_MESSAGES.some((re) => re.test(message)) ? "connection_lost" : null
}

export function classifyEventFailure(
  err: unknown,
  options: ClassifyOptions = {}
): EventFailureClassification {
  const dlq = classifyFailure(err)
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)

  const consumerCode =
    err instanceof PermanentEventDataDefectError
      ? err.defect_code
      : options.permanentDefectCode?.(err) ?? null
  if (consumerCode) {
    return {
      event_class: "permanent_data_defect",
      reason: `permanent_data_defect:${consumerCode}: ${message}`,
      dlq: terminal(dlq),
    }
  }

  const socket = transientConnectionSignal(err)
  if (socket) {
    return {
      event_class: "transient_retry",
      reason: `transient_retry: connection ${socket}: ${message}`,
      dlq: { ...dlq, tier: "transient", failure_mode: "FM-71-RT-7", is_retryable: true },
    }
  }

  if (dlq.tier === "transient") {
    return { event_class: "transient_retry", reason: `transient_retry: ${dlq.reason}`, dlq }
  }

  if (dlq.sqlstate && DATA_DEFECT_SQLSTATE_CLASSES.has(dlq.sqlstate.slice(0, 2))) {
    return {
      event_class: "permanent_data_defect",
      reason: `permanent_data_defect:sqlstate_${dlq.sqlstate}: ${message}`,
      dlq,
    }
  }

  return {
    event_class: "unknown_fail_closed",
    reason: `unknown_fail_closed: ${message}`,
    dlq: terminal(dlq),
  }
}

/** Czy klasa idzie do DLQ. Wyczerpujące `switch` — nowa klasa bez decyzji nie skompiluje się. */
export function isDeadLetterClass(eventClass: EventFailureClass): boolean {
  switch (eventClass) {
    case "transient_retry":
      return false
    case "permanent_data_defect":
    case "unknown_fail_closed":
      return true
    default: {
      const unreachable: never = eventClass
      throw new Error(`unclassified event failure class: ${String(unreachable)}`)
    }
  }
}

function terminal(dlq: DlqClassification): DlqClassification {
  return dlq.tier === "dlq_pending_ops_review"
    ? dlq
    : { ...dlq, tier: "dlq_pending_ops_review", is_retryable: false }
}
