import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story 5.7 (v1.14.0, AC1) — `market_runtime_config` na WŁAŚCIWEJ powierzchni
 * migracji aplikacyjnych.
 *
 * ── Dlaczego ta migracja w ogóle powstaje ──────────────────────────────────
 * Kod produkcyjny czytał tę tabelę od v1.4.0 (`lib/read-market-locales.ts`,
 * `lib/events/orderplaced-v2-publisher.ts`), ale ŻADNA migracja jej nie
 * tworzyła: `CREATE TABLE` istniał wyłącznie w fixture'ach testowych
 * (`__tests__/fixtures/migrations/*.sql`) oraz w powierzchni `legacy-base`,
 * która tę tabelę tylko ROZSZERZA (`Migration20260427120000AddLocalesToMarketRuntimeConfig`
 * ma prerequisite „tabela musi istnieć" i była blokowana na czysto zbudowanej
 * bazie). Efekt: na żywej bazie dev `to_regclass('public.market_runtime_config')`
 * = NULL, a każdy odczyt degradował do shimu env `DEFAULT_LOCALE`. Degradacja
 * jest owinięta w try/catch, więc nic nigdy nie krzyczało — tabela była
 * WIDMEM, a e-maile voucherowe wychodziły bez konfiguracji rynku.
 *
 * Powierzchnią jest `packages/api/src/migrations` (runner
 * `scripts/run-app-migrations.ts`, `pnpm db:migrate:app`) — NIE `medusa
 * db:migrate`. Pomylenie tych dwóch powierzchni było przyczyną defektu, więc
 * migracja świadomie nie dokłada trzeciej.
 *
 * ── Idempotencja i tabela CZĘŚCIOWO istniejąca ──────────────────────────────
 * Na runtime'ach, które dostały tabelę z fixture'a / legacy-base, istnieje ona
 * z RÓŻNYMI zestawami kolumn (jedna wersja ma `locales` + `feature_flags`, inna
 * `status`/`version`/`currency`/`supported_locales`). Dlatego `CREATE TABLE IF
 * NOT EXISTS` NIE wystarcza — po nim idzie komplet `ADD COLUMN IF NOT EXISTS`
 * dla kolumn, których wymaga kontrakt Story 5.7. Migracja jest przez to
 * bezpiecznie re-runnable i nie traci danych.
 *
 * ── `down()` jest data-preserving ──────────────────────────────────────────
 * Konwencja lokalnych migracji aplikacyjnych (patrz ledger dostaw): rollback
 * nie kasuje tabeli ani kolumn niosących konfigurację rynku. `DROP TABLE`
 * skasowałby jedyne runtime'owe źródło `support_email`/`market_url` i
 * przywrócił dokładnie stan, który ta story zamyka.
 */
export class Migration20260730120000MarketRuntimeConfigTable extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS market_runtime_config (
        market_id      TEXT PRIMARY KEY,
        locales        JSONB NULL,
        support_email  TEXT NULL,
        market_url     TEXT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    // Tabela mogła już istnieć w wariancie fixture'owym / legacy-base — wtedy
    // brakuje jej dokładnie tych kolumn, dla których powstała ta migracja.
    for (const [column, definition] of [
      ["locales", "JSONB NULL"],
      ["support_email", "TEXT NULL"],
      ["market_url", "TEXT NULL"],
      ["created_at", "TIMESTAMPTZ NOT NULL DEFAULT now()"],
      ["updated_at", "TIMESTAMPTZ NOT NULL DEFAULT now()"],
    ] as const) {
      this.addSql(
        `ALTER TABLE market_runtime_config ADD COLUMN IF NOT EXISTS ${column} ${definition}`,
      )
    }
  }

  async down(): Promise<void> {
    // Data-preserving rollback: konfiguracja rynku jest danymi operacyjnymi,
    // a nie artefaktem tej migracji. Nic nie kasujemy.
  }
}
