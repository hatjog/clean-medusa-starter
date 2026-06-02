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
 *
 * ── RELACJA DO `webhook_event_processed` (review AI-02 / MEDIUM) ─────────────
 * Istnieje JUŻ aktywna tabela `webhook_event_processed`
 * (`packages/api/src/migrations/Migration20260516000000StripePathYWebhookEventProcessed.ts`,
 * PK `(event_id, provider)`), wpięta w żywą ścieżkę Path Y (`stripe-payment-audit.ts`,
 * `on-order-placed-stripe-retry.ts`). `event_processed` (ta story, PK
 * `(external_id, event_type)`) jest wobec niej KOMPLEMENTARNA, NIE redundantna —
 * to DWIE ORTOGONALNE WARSTWY idempotencji z RÓŻNYMI kluczami:
 *
 *   • `webhook_event_processed`  — dedupe DOSTAWY WEBHOOKA (transport).
 *       Klucz: Stripe `event_id` (`evt_...`) + `provider`. Chroni przed ponowną
 *       dostawą tego samego webhooka (retry Stripe, multi-replica). Warstwa
 *       transportowa: „czy ten konkretny pakiet webhooka był już odebrany?".
 *
 *   • `event_processed`          — dedupe KONSUMPCJI BIZNESOWEJ (issuance).
 *       Klucz: `external_id` (= `payment_intent.id`, `pi_...`) + `event_type`.
 *       Chroni przed PODWOJENIEM ISSUE dla tego samego faktu płatności, nawet
 *       gdy dotarł innym kanałem/innym `event_id` (np. webhook vs reconcile job).
 *       Warstwa domenowa: „czy ten payment_intent był już skonsumowany do issue?".
 *
 * Klucze są semantycznie ROZŁĄCZNE (`evt_...` ≠ `pi_...`): jeden `payment_intent.id`
 * może pojawić się w wielu Stripe `event_id`, więc dedupe webhooka NIE wystarcza do
 * idempotencji issuance i odwrotnie. Audyt ADR-137 („brak `event_processed`") był
 * literalnie poprawny (brak tabeli o tej nazwie), ale `webhook_event_processed`
 * istniał — stąd to doprecyzowanie.
 *
 * KONTRAKT DLA 3.3 (subscriber Path Y) — używa OBU warstw, w kolejności:
 *   1. `webhook_event_processed` (event_id+provider) — wczesny guard transportu
 *      (już dziś wpięty w stripe-payment-audit, story 3.3 go NIE zastępuje);
 *   2. `event_processed` (external_id+event_type) — guard konsumpcji jako PIERWSZY
 *      krok transakcji issuance (INSERT ... ON CONFLICT DO NOTHING; 0 affected ⇒
 *      event już skonsumowany ⇒ pomiń tworzenie entitlementów);
 *   3. `entitlement_dedupe_key` unique (per-entitlement, FR10) — ostatnia bariera
 *      przed podwojeniem pojedynczego entitlementu (Story 3.3).
 * `event_processed` NIE zastępuje `webhook_event_processed` — warstwy współistnieją.
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
