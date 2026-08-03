import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story 2.5 (v1.14.0, R-2.5-M9) — indeks wspierający skan reconciliation
 * sweepa.
 *
 * Oba zapytania sweepa wchodzą przez `entitlement_instance` i filtrują po
 * `(entitlement_type, state)` z oknem po `created_at`, sortując po `created_at`:
 *   - `scanDeliveryGaps` — `state IN (…) AND entitlement_type IN (…) AND
 *     created_at < … AND created_at >= …`, `ORDER BY … created_at`;
 *   - `countGapsBeyondSourceStates` — `state NOT IN (…)` (negacja NIE użyje
 *     `entitlement_instance_state_idx`) z tym samym oknem.
 *
 * Zastane indeksy to `entitlement_profile_id`, częściowy `order_id` i sam
 * `state` — żaden nie pozwala wypchnąć `LIMIT`, więc planner musiał zebrać
 * i posortować CAŁY zbiór ISSUED/ACTIVE co 15 minut. Kolejność kolumn
 * `(entitlement_type, state, created_at)` obsługuje oba kształty: równościowy
 * prefiks + zakres/sortowanie na ogonie.
 *
 * Migracja jest idempotentna i odwracalna; nie zmienia żadnych danych.
 */
export class Migration1778934000000AddEntitlementInstanceSweepScanIndex extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE INDEX IF NOT EXISTS entitlement_instance_type_state_created_idx
        ON entitlement_instance (entitlement_type, state, created_at)
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      DROP INDEX IF EXISTS entitlement_instance_type_state_created_idx
    `)
  }
}
