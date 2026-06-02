import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story 3.2 (v1.11.0 Epic 3 / Wave 3) — ontologia FK (`market_id`/`sales_channel_id`)
 * + kolumna `vat_classification` na `entitlement_instance` (warstwa danych live-issue).
 *
 * Podstawa normatywna: FR21 (ontologia / izolacja per market), NFR3 (multi-tenant
 * fail-closed), FR32 / TSUE C-68/23 (VAT snapshot przy ISSUED), ADR-137 (live-issue).
 *
 * Zakres (AC1/AC2/AC3 — TYLKO struktura DB):
 *   1. `sales_channel_id text` — nowa kolumna ontologii scope (obok istniejącego
 *      `market_id`, dodanego w `1778925400000_add_market_id_to_entitlement_instance.ts`).
 *   2. `vat_classification text` — kolumna snapshotu SPV/MPV. Ta migracja DODAJE
 *      WYŁĄCZNIE kolumnę; LOGIKĘ snapshotu (zapis przy ISSUED + inwariant
 *      niereklasyfikacji po sprzedaży, FR32) implementuje Story 3.3. Domena SPV/MPV
 *      spójna z `vat-resolver.ts` (`VatClassification`) i `voucher_ledger_*` (2.6).
 *   3. Izolacja per market FAIL-CLOSED (AC2): CHECK `entitlement_instance_market_scope_chk`
 *      wymaga, by KAŻDA live-wystawiona encja (`order_id IS NOT NULL`) niosła
 *      niepusty `market_id` ORAZ `sales_channel_id`. Encja live bez scope ⇒ odrzucona
 *      w DB (NIE cichy zapis cross-market). Wiersze legacy/authored (`order_id IS NULL`,
 *      pre-Path-Y) są zwolnione — spójnie ze wzorcem partial-constraint z
 *      `1778925500000_add_line_item_id_to_entitlement_instance.ts`.
 *
 * Ontologia FK — konwencja modułu (Medusa 2 izolacja modułów):
 *   `entitlement_instance` należy do modułu `voucher`. Per izolację modułów Medusa
 *   2 (i istniejący `market_id` NULL bez FK, oraz `entitlement_profile_id` jako
 *   "free text, no FK") — `market_id`/`sales_channel_id` to kolumny scope BEZ
 *   cross-modułowego `REFERENCES` do `sales_channel`/`market` z innych modułów.
 *   Integralność ("FK egzekwowane w DB", AC2) realizują CHECK NOT NULL + char_length
 *   na kolumnach WŁASNEJ tabeli — bez sprzężenia DB między modułami (NFR6:
 *   migracja single-module, brak triggera STOP-i-pytaj).
 *
 * Bezpieczeństwo aplikacji na realnym PG (z danymi):
 *   - kolumny: `ADD COLUMN IF NOT EXISTS` (idempotentne, wartość NULL dla
 *     istniejących wierszy);
 *   - CHECK-i: dodane jako `NOT VALID` (egzekwowane na INSERT/UPDATE od teraz —
 *     fail-closed dla nowych live-issue z 3.3 — ale NIE walidują wstecznie
 *     istniejących wierszy, więc migracja stosuje się CZYSTO niezależnie od
 *     danych legacy). Promocja do VALIDATED po backfillu = Story 3.3 / pre-prod.
 *   - CHECK-i owinięte w idempotentny guard `pg_catalog.pg_constraint` (re-run `up()`
 *     bezpieczny — Postgres nie ma `ADD CONSTRAINT IF NOT EXISTS`).
 *
 * `down()` NON-DESTRUKCYJNY (Story 3.2 T1, append-only finance-adjacent — spójnie
 * z 2.6 D1): rollback NIE robi `DROP COLUMN`/`DROP CONSTRAINT`. `entitlement_instance`
 * jest finance-adjacent (entitlement = zobowiązanie); cofnięcie błędu = forward-fix.
 *
 * GRANICA (E3): migracja dostarcza WARSTWĘ DANYCH. NIE wypełnia `vat_classification`
 * (snapshot = 3.3), NIE implementuje query-scope/middleware (NFR3 — istniejący
 * middleware, konsumowany przez 3.3), NIE aktywuje postingu (`runtime_enabled` =
 * `false`, flip = E6/P6).
 *
 * Dane customer-level (AC3): pozostają w `customer.metadata.gp.*` (FR21) — ta
 * migracja ich NIE dotyka (dwa rozdzielne nośniki: ontologia encji entitlement tu,
 * customer-scope w metadanych customera).
 */
export class Migration1778928100000 extends Migration {
  async up(): Promise<void> {
    // ── kolumny ontologii / VAT (nullable; idempotentne) ────────────────────
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        ADD COLUMN IF NOT EXISTS sales_channel_id text NULL
    `)
    // vat_classification: snapshot SPV/MPV (logika = 3.3). NULL do czasu snapshotu.
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        ADD COLUMN IF NOT EXISTS vat_classification text NULL
    `)

    // ── domena vat_classification: SPV/MPV lub NULL (do snapshotu w 3.3) ─────
    // NOT VALID: egzekwowane na nowych zapisach, bez walidacji wstecznej.
    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint
          WHERE conname = 'entitlement_instance_vat_classification_chk'
        ) THEN
          ALTER TABLE entitlement_instance
            ADD CONSTRAINT entitlement_instance_vat_classification_chk
            CHECK (vat_classification IS NULL OR vat_classification IN ('SPV','MPV'))
            NOT VALID;
        END IF;
      END $$;
    `)

    // ── izolacja per market FAIL-CLOSED (AC2, FR21/NFR3) ─────────────────────
    // Live-wystawiona encja (order_id NOT NULL) MUSI nieść niepusty market_id i
    // sales_channel_id — encja bez scope ⇒ odrzucona w DB (brak cross-market leak).
    // Legacy/authored (order_id NULL, pre-Path-Y) zwolnione (wzorzec partial-constraint).
    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint
          WHERE conname = 'entitlement_instance_market_scope_chk'
        ) THEN
          ALTER TABLE entitlement_instance
            ADD CONSTRAINT entitlement_instance_market_scope_chk
            CHECK (
              order_id IS NULL
              OR (
                market_id IS NOT NULL AND char_length(market_id) > 0
                AND sales_channel_id IS NOT NULL AND char_length(sales_channel_id) > 0
              )
            )
            NOT VALID;
        END IF;
      END $$;
    `)

    // ── indeksy lookup per scope (izolacja per market_id / sales_channel_id) ──
    this.addSql(`
      CREATE INDEX IF NOT EXISTS entitlement_instance_market_id_idx
        ON entitlement_instance (market_id)
        WHERE market_id IS NOT NULL
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS entitlement_instance_sales_channel_id_idx
        ON entitlement_instance (sales_channel_id)
        WHERE sales_channel_id IS NOT NULL
    `)
  }

  /**
   * NON-DESTRUKCYJNY rollback (Story 3.2 T1 / 2.6 D1). CELOWO NIE wykonuje
   * `DROP COLUMN`/`DROP CONSTRAINT`/`DROP INDEX`: `entitlement_instance` jest
   * finance-adjacent (entitlement = zobowiązanie). Cofnięcie błędnego stanu =
   * forward-fix, NIGDY destrukcyjne usunięcie kolumny scope/VAT. Świadomy,
   * udokumentowany no-op.
   */
  async down(): Promise<void> {
    // intencjonalnie puste — patrz docstring (append-only finance-adjacent, NIE DROP).
  }
}
