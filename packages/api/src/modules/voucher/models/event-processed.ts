/**
 * event-processed.ts — Story 3.2 (v1.11.0 Epic 3) — kontrakt warstwy danych dla
 * EVENT-LEVEL idempotencji konsumpcji eventów (ADR-137 §Decyzja pkt 3 / DEC-5 pkt 3.i).
 *
 * Towarzyszy migracji `1778928000000_create_event_processed_table.ts`. Dostarcza:
 *   - stałą nazwy tabeli + kolumn PK (single source-of-truth dla zapytań 3.3);
 *   - typ wiersza `EventProcessedRow`;
 *   - prymityw idempotentnego zapisu `buildEventProcessedDedupeInsert()` (INSERT
 *     ... ON CONFLICT DO NOTHING) — kanoniczny dedupe-write konsumowany przez
 *     subscriber 3.3 wewnątrz jego transakcji (atomicity, ADR-137);
 *   - referencyjny in-memory model `applyEventProcessedDedup()` odwzorowujący
 *     semantykę ON CONFLICT DO NOTHING (replay ⇒ no-op) — do testów i in-memory
 *     store'ów (wzorzec `InMemory*Store` z workflows/).
 *
 * GRANICA (E3): to WARSTWA DANYCH / prymityw idempotencji. NIE jest subscriberem
 * Path Y (3.3), NIE okablowuje maszyny stanów (3.4), NIE aktywuje postingu. Dedupe
 * PER-ENTITLEMENT (`entitlement_dedupe_key`, FR10) jest oddzielny i należy do 3.3.
 */

/** Nazwa tabeli event-level idempotencji (zgodna z migracją + allowlistą). */
export const EVENT_PROCESSED_TABLE = "event_processed" as const

/**
 * Kolumny composite PK = klucz dedupe event-level (ADR-137 DEC-5 pkt 3.i):
 * `external_id` (= `payment_intent.id`, kontrakt Story 3.1) + `event_type`
 * (envelope event_type, naming AR-EVENTS).
 */
export const EVENT_PROCESSED_PK_COLUMNS = ["external_id", "event_type"] as const

/** Persisted shape `event_processed` (1:1 z DDL migracji). */
export interface EventProcessedRow {
  /** external_id = payment_intent.id (envelope.v1 payload, Story 3.1). */
  external_id: string
  /** event_type, np. `gp.stripe.payment_intent_succeeded.v1` (AR-EVENTS). */
  event_type: string
  /** epoch-ms pierwszego przetworzenia (konflikt PK zachowuje pierwotny). */
  processed_at: number
}

/**
 * Parametryzowany, idempotentny INSERT do `event_processed`. `ON CONFLICT
 * (external_id, event_type) DO NOTHING` sprawia, że ponowna dostawa tego samego
 * eventu (retry webhooka) jest NO-OP-em na poziomie DB — to gwarant idempotencji
 * event-level. Subscriber 3.3 wykonuje ten INSERT jako PIERWSZY krok swojej
 * transakcji; gdy nic nie wstawiono (0 affected rows), event był już przetworzony
 * i tworzenie entitlementów jest pomijane (nie podwaja issue).
 *
 * Zwraca SQL + params (kolejność: external_id, event_type, processed_at). Czysta
 * funkcja — nie wykonuje zapytania (wykonanie należy do warstwy persystencji 3.3).
 */
export function buildEventProcessedDedupeInsert(row: EventProcessedRow): {
  sql: string
  params: [string, string, number]
} {
  return {
    sql:
      `INSERT INTO ${EVENT_PROCESSED_TABLE} (external_id, event_type, processed_at) ` +
      `VALUES ($1, $2, $3) ` +
      `ON CONFLICT (external_id, event_type) DO NOTHING`,
    params: [row.external_id, row.event_type, row.processed_at],
  }
}

/**
 * Klucz dedupe użyty TYLKO w referencyjnym in-memory modelu (kodowanie odporne
 * na separator — NIE konkatenacja). DB egzekwuje dedupe przez composite PK, nie
 * przez ten string; helper istnieje wyłącznie po stronie pamięci.
 */
function inMemoryDedupeKey(externalId: string, eventType: string): string {
  return JSON.stringify([externalId, eventType])
}

/**
 * Referencyjny in-memory odpowiednik `INSERT ... ON CONFLICT DO NOTHING`:
 * `processed: true`  — wiersz NOWY (pierwsze przetworzenie),
 * `processed: false` — klucz (external_id, event_type) JUŻ istnieje ⇒ NO-OP
 *                       (replay). Pierwotny `processed_at` jest zachowany.
 *
 * Mutuje przekazany `store` (jak DB). Służy testom idempotencji oraz in-memory
 * store'om 3.3 (mirror `InMemory*Store`). NIE jest ścieżką produkcyjną — produkcja
 * używa `buildEventProcessedDedupeInsert()` na realnym PG.
 */
export function applyEventProcessedDedup(
  store: Map<string, EventProcessedRow>,
  row: EventProcessedRow
): { processed: boolean; row: EventProcessedRow } {
  const key = inMemoryDedupeKey(row.external_id, row.event_type)
  const existing = store.get(key)
  if (existing !== undefined) {
    // ON CONFLICT DO NOTHING — zachowaj pierwotny wiersz (w tym processed_at).
    return { processed: false, row: existing }
  }
  store.set(key, row)
  return { processed: true, row }
}
