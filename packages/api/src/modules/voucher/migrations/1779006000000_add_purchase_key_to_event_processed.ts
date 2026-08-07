import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story 3.3 (v1.15.0 Epic 3) — KLUCZ ZAKUPU jako KOLUMNA na wierszach pętli
 * wystawienia: `event_processed.purchase_key` (AD-16, ADR-190 amendment ADR-166).
 *
 * Dlaczego kolumna, a nie pole koperty: `envelope.v1`
 * (`specs/contracts/events/schemas/envelope.v1.schema.json`) ma
 * `additionalProperties: false`, więc `assertEventEnvelopeMatchesContract`
 * ODRZUCIŁBY kopertę z dodatkowym `purchase_key`, a ADR-166 zachowuje v1.
 * AD-16 rozstrzyga: nośnikiem jest kolumna na wierszach pętli. Wierszem pętli
 * jest rekord `event_processed` — jeden na skonsumowaną kopertę, czyli jeden na
 * zamówienie zakupu.
 *
 * Dlaczego nie wystarczał `external_id`: związek z zakupem dawał się odzyskać
 * WYŁĄCZNIE przez parsowanie stringa `external_id` (= `payment_intent.id:order_id`)
 * po separatorze `:` — czyli przez konkatenację, którą sam moduł nazywa kruchą
 * (`models/event-processed.ts`, `inMemoryDedupeKey`). Kolumna zdejmuje parsowanie:
 * „pokaż wszystkie wystawienia tego zakupu" = `WHERE purchase_key = $1`.
 *
 * Wartością jest `payment_intent_id` (ta sama, którą niesie `correlation_id`
 * koperty — ADR-190 pkt 2), NIE podciąg wycinany z `external_id`.
 *
 * NUMERACJA (AC3): znacznik `1779006000000` pochodzi z rejestru
 * `specs/releases/v1.15.0/migration-registry.yaml` (Story 2.1, PRD §9, ADR-177),
 * a NIE z generatora uruchomionego w worktree. Rodzina epoch-ms (13 cyfr), bo
 * nośnikiem jest tabela modułu `voucher` — wpis rejestru dla story 3.3 został
 * poprawiony z rodziny datetime14 na epoch-ms W TYM SAMYM commicie.
 *
 * NULLABLE świadomie: tabela jest zastana i niepusta na środowiskach, a wiersze
 * sprzed tej migracji nie mają skąd wziąć klucza zakupu. Backfill z `external_id`
 * byłby dokładnie tym parsowaniem separatora, które ta kolumna likwiduje.
 * Nowe zapisy przechodzą przez `buildEventProcessedDedupeInsert()`, który
 * wymaga `purchase_key` w typie (fail na etapie kompilacji, nie w runtime).
 *
 * `down()` NON-DESTRUKCYJNY (spójnie z `1778928000000` i wzorcem 2.6 D1):
 * `DROP COLUMN` gubiłby korelację zakupów już skonsumowanych. Cofnięcie = forward-fix.
 */
export class Migration1779006000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE event_processed
        ADD COLUMN IF NOT EXISTS purchase_key text
          CHECK (purchase_key IS NULL OR char_length(purchase_key) > 0)
    `)
    // Zapytanie „wszystkie wystawienia tego zakupu" jest po kolumnie, więc
    // kolumna dostaje indeks — bez niego call-site z AC2 skanowałby tabelę.
    this.addSql(`
      CREATE INDEX IF NOT EXISTS event_processed_purchase_key_idx
        ON event_processed (purchase_key)
        WHERE purchase_key IS NOT NULL
    `)
  }

  /**
   * NON-DESTRUKCYJNY rollback: CELOWO nie robi `DROP COLUMN` ani `DROP INDEX` —
   * usunięcie kolumny zniszczyłoby jedyny nieparsowany nośnik związku N kopert
   * z jednym zakupem. Świadomy, udokumentowany no-op (NIE pominięcie).
   */
  async down(): Promise<void> {
    // intencjonalnie puste — patrz docstring (append-only, NIE DROP).
  }
}
