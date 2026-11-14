/**
 * owed-unit-effect-barrier.ts — Story 3.3 (v1.16.0, Epic 3; FR-9, AD-33, AD-47,
 * NFR-3, AD-44; ADR-166 amendment przez ADR-242 Proposed).
 *
 * WSPÓLNA bariera idempotencji SKUTKU per należna jednostka biznesowa
 * (`owed_business_unit_key` = `payment_intent_id:order_id`, ADR-166).
 *
 * Do v1.16.0 każda trasa pilnowała skutku własnym zapisem (`event_processed`
 * po `(external_id, event_type)`), więc „ta sama jednostka" była jednym
 * wierszem tylko dopóki obie trasy pisały ten sam `event_type`. Tabela
 * `owed_unit_effect_barrier` ma klucz BEZ `event_type` i BEZ `provider`:
 * jedna jednostka = jeden wiersz, niezależnie od trasy, która ją rozlicza.
 *
 * ── Atomowość (AC1) ────────────────────────────────────────────────────────
 * Rezerwacja klucza jednostki i zapis jej znacznika skutku (`event_processed`)
 * to JEDNA instrukcja SQL (data-modifying CTE) wykonywana w tej samej
 * transakcji, co INSERT-y entitlementów. Nie istnieje stan pośredni
 * „klucz zarezerwowany, skutku brak" widoczny dla innej transakcji:
 *  - współbieżna trasa blokuje się na PK bariery do COMMIT/ROLLBACK pierwszej;
 *  - po COMMIT dostaje `DO NOTHING` ⇒ 0 wierszy ⇒ no-op (bez duplikatu);
 *  - po ROLLBACK (np. porażka linii) wstawia sama ⇒ brak braku.
 *
 * Granica: moduł zawiera wyłącznie budowniczy SQL (bez I/O) — wykonanie
 * należy do konsumenta (`live-issue-from-payment-intent.ts`).
 */

/** Tabela wspólnej bariery skutku (migracja `Migration20261114140000SharedIdempotencyBarrier`). */
export const OWED_UNIT_EFFECT_BARRIER_TABLE = "owed_unit_effect_barrier" as const

/**
 * Wersja kontraktu bariery (SemVer, ADR-242). 1.0.0 = kontrakt Story 3.1
 * (dwa poziomy klucza, ACK tylko przy PASS). 1.1.0 = dodana wspólna tabela
 * skutku per jednostka; kształt kluczy poziomu 1 i 2 bez zmian (MINOR).
 */
export const OWED_UNIT_EFFECT_BARRIER_CONTRACT_VERSION = "1.1.0" as const

export type OwedUnitEffectClaim = {
  /** `payment_intent_id:order_id` — TEN SAM kształt co `event_processed.external_id`. */
  owed_business_unit_key: string
  payment_intent_id: string
  order_id: string
  instance_id: string
  market_id: string
  /** Trasa, która rozliczyła jednostkę (ślad, nie część klucza). */
  claimed_by_path: string
}

export type EventProcessedMarker = {
  external_id: string
  event_type: string
  processed_at: number
  purchase_key: string
  instance_id: string
  market_id: string
}

function requireNonBlank(field: string, value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`owed-unit-effect-barrier: ${field} wymagany (niepusty)`)
  }
}

/**
 * Jedna instrukcja: rezerwacja klucza jednostki w barierze ORAZ znacznik
 * skutku w `event_processed`. `rowCount` = liczba wstawionych wierszy
 * `event_processed` (1 = ta transakcja rozlicza jednostkę; 0 = jednostka już
 * rozliczona — przez tę albo inną trasę). Kolejność parametrów $1..$6 jest
 * identyczna z `buildEventProcessedDedupeInsert` (zgodność konsumentów).
 */
export function buildOwedUnitEffectBarrierInsert(
  marker: EventProcessedMarker,
  claim: OwedUnitEffectClaim
): { sql: string; params: [string, string, number, string, string, string, string, string, string] } {
  requireNonBlank("owed_business_unit_key", claim.owed_business_unit_key)
  requireNonBlank("payment_intent_id", claim.payment_intent_id)
  requireNonBlank("order_id", claim.order_id)
  requireNonBlank("instance_id", claim.instance_id)
  requireNonBlank("market_id", claim.market_id)
  requireNonBlank("claimed_by_path", claim.claimed_by_path)
  if (claim.owed_business_unit_key !== marker.external_id) {
    throw new Error(
      "owed-unit-effect-barrier: klucz jednostki musi być równy external_id znacznika skutku"
    )
  }
  if (claim.instance_id !== marker.instance_id || claim.market_id !== marker.market_id) {
    throw new Error("owed-unit-effect-barrier: scope bariery i znacznika skutku musi być ten sam")
  }
  return {
    sql:
      `WITH barrier_claim AS (` +
      `INSERT INTO ${OWED_UNIT_EFFECT_BARRIER_TABLE} ` +
      `(owed_business_unit_key, payment_intent_id, order_id, instance_id, market_id, claimed_by_path) ` +
      `VALUES ($1, $7, $8, $5, $6, $9) ` +
      `ON CONFLICT (owed_business_unit_key) DO NOTHING RETURNING owed_business_unit_key) ` +
      `INSERT INTO event_processed ` +
      `(external_id, event_type, processed_at, purchase_key, instance_id, market_id) ` +
      `SELECT $1, $2, $3, $4, $5, $6 WHERE EXISTS (SELECT 1 FROM barrier_claim) ` +
      `ON CONFLICT (external_id, event_type) DO NOTHING`,
    params: [
      marker.external_id,
      marker.event_type,
      marker.processed_at,
      marker.purchase_key,
      marker.instance_id,
      marker.market_id,
      claim.payment_intent_id,
      claim.order_id,
      claim.claimed_by_path,
    ],
  }
}

/** Odczyt rozliczonych jednostek zakupu z bariery (dowód równości skutków). */
export function buildOwedUnitEffectBarrierPurchaseQuery(paymentIntentId: string): {
  sql: string
  params: [string]
} {
  return {
    sql:
      `SELECT owed_business_unit_key FROM ${OWED_UNIT_EFFECT_BARRIER_TABLE} ` +
      `WHERE payment_intent_id = $1 ORDER BY owed_business_unit_key`,
    params: [paymentIntentId],
  }
}
