import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story 2.1 (v1.15.0, AC4) — runtime'owy nośnik hamulca ścieżki pieniądza.
 *
 * ── Po co ta kolumna ────────────────────────────────────────────────────────
 * Pięć wymagań tego wydania (FR-6/7, FR-9, FR-10, FR-12, FR-14) zmienia
 * zachowanie ścieżki pieniądza. Żadne nie ma dziś zapisanej drogi powrotnej,
 * a wycofanie przez wdrożenie jest NIEDOSTĘPNE: instancja produkcyjna powstaje
 * dopiero w v1.20.0 (AD-25, NFR-8). Hamulec musi więc żyć w warstwie RUNTIME,
 * per rynek — nie w `process.env` (nie jest per rynek i nie jest RUNTIME) i nie
 * jako pięć niezależnych flag (pięć nośników = pięć różnych prawd).
 *
 * Nośnikiem jest JEDNA kolumna jsonb na `market_runtime_config`, zasilana tym
 * samym kanałem co reszta konfiguracji rynku:
 *   gp-ops/markets/** (SOURCE)
 *     -> gp-ops config load --apply
 *     -> GP/config/** (RUNTIME, byte-verbatim)
 *     -> gp-config-sync-market-runtime --apply
 *     -> market_runtime_config.money_path_brakes
 *     -> readMoneyPathBrake() (lib/money-path-brakes.ts)
 *
 * Rejestr numeracji: znacznik `20260805120000` pochodzi z
 * `specs/releases/v1.15.0/migration-registry.yaml` (story 2.1), nie z
 * generatora uruchomionego w worktree — patrz PRD §9.
 *
 * ── Dlaczego NULL, a nie DEFAULT '{}' ───────────────────────────────────────
 * Brak wpisu i pusty obiekt to ta sama informacja („rynek nie zadeklarował
 * hamulców"), a odczyt jest fail-closed z wartością bezpieczną z ADR-177.
 * Wpisanie DEFAULT-u sugerowałoby, że brak konfiguracji jest konfiguracją.
 *
 * ── `down()` jest data-preserving ───────────────────────────────────────────
 * Zgodnie z konwencją `Migration20260730120000MarketRuntimeConfigTable`:
 * rollback nie kasuje konfiguracji rynku. Skasowanie kolumny skasowałoby
 * jedyną drogę powrotną dla pięciu zmian tego wydania.
 */
export class Migration20260805120000MoneyPathBrakesColumn extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE market_runtime_config
      ADD COLUMN IF NOT EXISTS money_path_brakes JSONB NULL
    `)
  }

  async down(): Promise<void> {
    // Data-preserving rollback — patrz nagłówek.
  }
}
