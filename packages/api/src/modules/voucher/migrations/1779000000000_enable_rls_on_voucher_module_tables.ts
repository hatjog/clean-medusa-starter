import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.15.0 Story 2.6 (FR-14e, AD-22, NFR-5; ADR-192, wzorzec ADR-141) —
 * polityki RLS dla tabel modułu voucher PO usunięciu własnej puli połączeń
 * z `modules/voucher/service.ts`.
 *
 * Znacznik `1779000000000` POBRANY z `specs/releases/v1.15.0/migration-registry.yaml`
 * (wpis `story_id: "2.6"`), nie wygenerowany w worktree — patrz ADR-177.
 *
 * ── Dlaczego obie połowy są jedną zmianą ────────────────────────────────────
 * Sama zamiana puli daje MECHANIZM BEZ SKUTKU: hook ustawi
 * `SET ROLE medusa_store` i `app.gp_market_id`, a `SELECT * FROM voucher`
 * nadal zwróci wiersze wszystkich rynków, bo na tych tabelach NIE MA polityki.
 * Same polityki bez zamiany puli też nic nie dają, bo połączenie serwisu nigdy
 * nie przechodziło przez `SET ROLE`. Dopiero razem dają izolację.
 *
 * ── Enumeracja tabel WRAZ Z WYKLUCZENIAMI (ADR-141 §3) ──────────────────────
 * Tabele dotykane przez `modules/voucher/service.ts` (zmierzone, nie przepisane):
 *
 *   POD RLS (ta migracja):
 *     - `entitlement_instance`  (16 wystąpień)  — `market_id text NULL`
 *     - `voucher_event`         (11 wystąpień)  — BEZ kolumny scope, patrz niżej
 *     - `voucher`               ( 9 wystąpień)  — `market_id text NULL`
 *
 *   POZA RLS TĄ MIGRACJĄ, z powodem:
 *     - `customer`              — polityka istnieje od `infra/postgres/migrations/005`
 *                                 i `010`; SSOT tamtej tabeli jest poza modułem.
 *                                 Do dziś była OMIJANA, bo join serwisu jechał
 *                                 własną pulą — zamiana puli z AC1 włącza ją
 *                                 bez zmiany DDL.
 *     - `seller`, `seller_address`
 *                               — encje sprzedawcy są celowo współdzielone między
 *                                 rynkami (`__tests__/rls/seller-scoping.integration.spec.ts`);
 *                                 zawężenie ich jest decyzją o zasięgu katalogu,
 *                                 nie skutkiem ubocznym tej story.
 *     - `order`, `order_line_item`, `order_item`, `order_address`
 *                               — tabele rdzenia Medusy; ich prowizjonowanie nie
 *                                 należy do migracji modułu voucher. Nazwane jako
 *                                 pozostający zasięg AD-22, nie przemilczane.
 *     - pozostałe tabele modułu (`voucher_ledger*`, `voucher_redemption`,
 *       `voucher_delivery_dispatch`, `voucher_claim_store`, `event_processed`)
 *                               — `service.ts` ich NIE dotyka; wchodzą przez story,
 *                                 które otwierają ich ścieżkę (m.in. 5.7 / FR-12).
 *                                 Rozszerzenie zakresu tutaj zabudowałoby pas ruchu,
 *                                 którego 2.6 ma tylko nie zamykać (AC5).
 *
 * ── `voucher_event`: EXISTS zamiast denormalizacji (decyzja z uzasadnieniem) ─
 * `voucher_event` nie ma kolumny `market_id`, a jego wiersze są scope'owane
 * DWOJAKO: `voucher_code` (eventy vouchera) albo `entitlement_id` (eventy cyklu
 * życia entitlementu — `voucher_code` jest tam NULL, patrz migracja
 * `1778925265229`). Polityka idzie więc przez FK, alternatywą sumy.
 *
 * Uzasadnienie WYDAJNOŚCIOWE (RLS liczy predykat na każdym wierszu):
 *   - oba `EXISTS` to trafienia w KLUCZ GŁÓWNY (`voucher.code`,
 *     `entitlement_instance.id`) — koszt to index lookup, nie skan;
 *   - alternatywa (denormalizacja `market_id` + backfill) wymagałaby zmiany
 *     KAŻDEGO `INSERT INTO voucher_event` w `service.ts` — czyli rozjechania
 *     powierzchni pliku, który zaraz przejmuje Story 5.7 (PRD §9). To koszt
 *     merge'owy zapłacony za mikrooptymalizację predykatu na kluczu głównym.
 * Jeśli pomiar pokaże realny koszt, denormalizacja jest osobną story — nie
 * doklejką do tej.
 *
 * ── ZAKAZ furtki `OR market_id IS NULL` (ADR-141 §4, P1) ────────────────────
 * `voucher.market_id` jest `text NULL` z komentarzem „NULL = global voucher
 * (E2E fixtures only)". Te wiersze stają się NIEWIDOCZNE pod polityką i tak ma
 * być: fallback `OR market_id IS NULL` byłby furtką, przez którą każdy wiersz
 * bez rynku widać ze WSZYSTKICH rynków. Jeśli fixture E2E przestaje działać,
 * naprawia się fixture, nie politykę.
 *
 * ── `FORCE` nie jest ozdobnikiem ────────────────────────────────────────────
 * `ENABLE ROW LEVEL SECURITY` nie dotyczy WŁAŚCICIELA tabeli. Tabele modułu
 * tworzy rola z `DATABASE_URL`, która obsługuje też część ruchu — bez
 * `FORCE ROW LEVEL SECURITY` polityka byłaby po prostu pomijana (zielony
 * `pg_policies`, zerowa izolacja). `FORCE` jest zarazem tym, co daje
 * fail-closed dla wykonania BEZ kontekstu rynku: bez `app.gp_market_id`
 * predykat nie ma prawdy, więc zapytanie zwraca ZERO wierszy zamiast wszystkich
 * (AC4). Rola z `BYPASSRLS`/superuser omija to zawsze — dlatego kontrola
 * negatywna nigdy nie jest mierzona jako `postgres`.
 */
const RLS_TABLES = ["voucher", "voucher_event", "entitlement_instance"] as const

const MARKET_SETTING = `current_setting('app.gp_market_id', true)`

export class Migration1779000000000 extends Migration {
  async up(): Promise<void> {
    // Rola runtime bez BYPASSRLS. `infra/postgres/migrations/003` tworzy ją
    // dla dev/bootstrap, ale `infra/` jest jawnie NIE-SSOT (ADR-141 §1);
    // migracja modułu nie może zakładać, że tamten mirror się wykonał.
    //
    // WYMAGANIA UPRAWNIEŃ ROLI MIGRACYJNEJ (v1.15.0 Story 2.6 cykl 1, MEDIUM):
    //   - `CREATEROLE` (albo superuser) — TYLKO gdy rola `medusa_store` jeszcze
    //     nie istnieje; jeśli istnieje (np. z `infra/postgres/migrations/003`
    //     albo z provisioningu środowiska), migracja jej nie tworzy i uprawnienie
    //     nie jest potrzebne;
    //   - własność tabel modułu albo `WITH GRANT OPTION` — dla `GRANT … ON <table>`.
    // W suicie integracyjnej te instrukcje wykonuje superuser z kontenera, więc
    // TEST NIE MOŻE wykryć braku uprawnień na środowisku docelowym. Dlatego brak
    // uprawnienia kończy się komunikatem, który NAZYWA brakujące uprawnienie,
    // a nie surowym `permission denied to create role` w połowie migracji.
    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medusa_store') THEN
          BEGIN
            CREATE ROLE medusa_store NOLOGIN;
          EXCEPTION WHEN insufficient_privilege THEN
            RAISE EXCEPTION
              'GP_RLS_MIGRATION_REQUIRES_CREATEROLE: rola migracyjna "%" nie ma '
              'uprawnienia CREATEROLE, a rola runtime "medusa_store" nie istnieje. '
              'Utwórz ją poza migracją (CREATE ROLE medusa_store NOLOGIN) albo nadaj '
              'roli migracyjnej CREATEROLE — patrz ADR-192 i runbook operatora.',
              current_user;
          END;
        END IF;
      END
      $$;
    `)
    this.addSql(`
      DO $$
      BEGIN
        GRANT USAGE ON SCHEMA public TO medusa_store;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE EXCEPTION
          'GP_RLS_MIGRATION_REQUIRES_GRANT: rola migracyjna "%" nie może nadać '
          'USAGE ON SCHEMA public roli medusa_store — wymagana jest własność '
          'schematu albo WITH GRANT OPTION (ADR-192).',
          current_user;
      END
      $$;
    `)

    for (const table of RLS_TABLES) {
      // Bez GRANTU przepięcie puli zamieniłoby ciszę na `permission denied`
      // NA PRODUKCJI: `ALTER DEFAULT PRIVILEGES` z migracji 003 działa tylko
      // dla roli, która je zadeklarowała, a te tabele tworzy migracja modułu.
      this.addSql(`
        DO $$
        BEGIN
          GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO medusa_store;
        EXCEPTION WHEN insufficient_privilege THEN
          RAISE EXCEPTION
            'GP_RLS_MIGRATION_REQUIRES_GRANT: rola migracyjna "%" nie może nadać '
            'uprawnień na tabeli ${table} roli medusa_store — wymagana jest '
            'własność tabeli albo WITH GRANT OPTION (ADR-192).',
            current_user;
        END
        $$;
      `)
      this.addSql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
      this.addSql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
      // Idempotencja: `CREATE POLICY` nie ma `IF NOT EXISTS` w PG 17.
      this.addSql(`DROP POLICY IF EXISTS market_isolation ON ${table}`)
    }

    for (const table of ["voucher", "entitlement_instance"]) {
      this.addSql(`
        CREATE POLICY market_isolation ON ${table}
          USING (market_id = ${MARKET_SETTING})
          WITH CHECK (market_id = ${MARKET_SETTING})
      `)
    }

    // Wiersz bez OBU wskaźników scope jest niewidoczny i niezapisywalny —
    // to jest zamierzone fail-closed, nie przeoczenie.
    const eventScope = `
      EXISTS (
        SELECT 1 FROM voucher v
        WHERE v.code = voucher_event.voucher_code
          AND v.market_id = ${MARKET_SETTING}
      )
      OR EXISTS (
        SELECT 1 FROM entitlement_instance e
        WHERE e.id = voucher_event.entitlement_id
          AND e.market_id = ${MARKET_SETTING}
      )
    `
    this.addSql(`
      CREATE POLICY market_isolation ON voucher_event
        USING (${eventScope})
        WITH CHECK (${eventScope})
    `)
  }

  async down(): Promise<void> {
    for (const table of RLS_TABLES) {
      this.addSql(`DROP POLICY IF EXISTS market_isolation ON ${table}`)
      this.addSql(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`)
      this.addSql(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`)
    }
    // GRANT-y zostają świadomie: są nadwyżkowe wobec stanu sprzed migracji
    // (`003` nadaje je zbiorczo), a ich odebranie zabrałoby uprawnienia
    // tabelom, które nigdy nie były w zakresie tej story.
  }
}
