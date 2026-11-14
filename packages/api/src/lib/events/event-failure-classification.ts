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
