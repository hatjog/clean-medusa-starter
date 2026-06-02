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
 *      niepusty `market_id`. Encja live bez `market_id` ⇒ odrzucona w DB (NIE cichy
 *      zapis cross-market). Wiersze legacy/authored (`order_id IS NULL`, pre-Path-Y)
 *      są zwolnione — spójnie ze wzorcem partial-constraint z
 *      `1778925500000_add_line_item_id_to_entitlement_instance.ts`.
 *
 *      ZAKRES FAIL-CLOSED W 3.2 = `market_id` (review AI-01 / HIGH).
 *      `sales_channel_id` jest CELOWO POZA tym CHECK-iem w Story 3.2:
 *        - AKTYWNY writer live-issue `issueEntitlementWithinPaymentTransaction`
 *          (`workflows/entitlements/issue-entitlement.ts`, wołany przez zarejestrowany
 *          subscriber `subscribers/stripe-payment-audit.ts` na `payment.captured`)
 *          ustawia `order_id` + `market_id`, ale NIE `sales_channel_id` (kolumna jest
 *          net-new w tej story; payload eventu Story 3.1 jej nie przenosi do issuance).
 *        - Gdyby CHECK wymagał `sales_channel_id NOT NULL` dla `order_id NOT NULL`,
 *          REALNY `db:migrate` ZŁAMAŁBY każde live-wystawienie/refund/redeem
 *          (`INSERT`/`UPDATE entitlement_instance` ⇒ constraint violation), bo żaden
 *          writer tej kolumny jeszcze nie wypełnia.
 *        - Egzekwujemy fail-closed TYLKO to, co istniejący writer realnie produkuje
 *          (`market_id`). Pełny wymóg `sales_channel_id NOT NULL` (na ścieżce live)
 *          przenosi się do Story 3.3 (subscriber Path Y), GDZIE writer wypełni
 *          `sales_channel_id` ze snapshotu/payloadu — wtedy CHECK zostanie zaostrzony
 *          (promocja constraintu na live-issued).
 *      Kolumna `sales_channel_id` + jej index lookup są dodane TERAZ (warstwa danych
 *      pod 3.3), ale NIE są wymagane przez CHECK na ścieżce live w 3.2.
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
 * MIESZANA SEMANTYKA ROLLBACK NA `entitlement_instance` (review AI-05 / LOW):
 *   Ta tabela ma DWA reżimy `down()` w zależności od migracji — operator MUSI być
 *   tego świadomy przy częściowym rollbacku:
 *     - DESTRUKCYJNE `down()` (starsze migracje, drop kolumn/indeksów):
 *         `1778925400000_add_market_id...`  → `DROP COLUMN IF EXISTS market_id`,
 *         `1778925500000_add_line_item_id...` → `DROP INDEX ...` + `DROP COLUMN line_item_id`.
 *     - FORWARD-FIX-ONLY (no-op `down()`, ta migracja `1778928100000`): NIE drop'uje
 *       `sales_channel_id`/`vat_classification` ani CHECK-ów (finance-adjacent).
 *   Konsekwencje:
 *     - Rollback DO punktu PRZED `1778928100000` (no-op down) ZOSTAWIA
 *       `sales_channel_id`, `vat_classification` oraz CHECK `entitlement_instance_market_scope_chk`
 *       w miejscu (CHECK nadal egzekwuje `market_id` na live-issued — co writer produkuje, AI-01).
 *     - GŁĘBSZY rollback drop'ujący `market_id` (starsza `1778925400000`) auto-usunie
 *       zależny CHECK `entitlement_instance_market_scope_chk` przez dependency (benign,
 *       Postgres `DROP COLUMN` kaskaduje constraint), ale jest to efekt uboczny starszej
 *       migracji, NIE tej — operator nie jest o tym uprzedzany przez `down()` tutaj.
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
    // Live-wystawiona encja (order_id NOT NULL) MUSI nieść niepusty market_id —
    // encja live bez market_id ⇒ odrzucona w DB (brak cross-market leak).
    // Legacy/authored (order_id NULL, pre-Path-Y) zwolnione (wzorzec partial-constraint).
    //
    // AI-01 (HIGH): `sales_channel_id` CELOWO NIE jest tu wymagany — aktywny writer
    // live-issue (issue-entitlement.ts via stripe-payment-audit subscriber) ustawia
    // market_id, ale NIE sales_channel_id (kolumna net-new). Wymóg sales_channel_id
    // NOT NULL złamałby realny db:migrate (każdy live INSERT/UPDATE → violation).
    // Pełny wymóg sales_channel_id na ścieżce live = Story 3.3 (writer wypełni kolumnę,
    // wtedy CHECK zostanie zaostrzony).
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
              OR (market_id IS NOT NULL AND char_length(market_id) > 0)
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
