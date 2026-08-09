import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.15.0 Story 5.7 (FR-12a/b/c, AD-17, AD-22; ADR-178 §2.3/§2.4) — kanoniczna
 * `voucher_redemption` dostaje rynek, rodzaj wpisu i wiązanie odwrócenia,
 * a jej wiązanie jeden-producent przestaje być deklaracją i staje się GRANTEM.
 *
 * Znacznik `1779004000000` POBRANY z `specs/releases/v1.15.0/migration-registry.yaml`
 * (wpis `story_id: "5.7"`), nie wygenerowany w worktree — ADR-177.
 *
 * ── Kształt jest ZAMROŻONY, nie negocjowany tutaj ───────────────────────────
 * Nazwy kolumn, wartości `kind`, komplet CHECK-ów, indeksy i rozszerzenie PK
 * pochodzą DOSŁOWNIE z ADR-178 §2.4. Przemianowanie czegokolwiek w tym pliku
 * jest rozjazdem z decyzją, nie ulepszeniem.
 *
 * ── Trzy kolumny, DWA niezależne fakty (ADR-178 §2.4) ───────────────────────
 * `purchase_market_id` (rynek zakupu) i `redemption_market_id` (rynek realizacji)
 * są niezależne. `market_id` jest DENORMALIZACJĄ `purchase_market_id` — istnieje
 * po to, żeby polityka RLS i raportowanie miały jedną kolumnę właścicielską.
 * Sprzężenie jest wyrażone CHECK-iem `market_id IN (purchase_market_id,
 * redemption_market_id)`, nie komentarzem.
 *
 * ── Droga do NOT NULL jest WYBRANA POMIAREM, nie wiarą (ADR-178 §2.4) ───────
 * Pierwszym krokiem `up()` jest `SELECT count(*) FROM voucher_redemption`
 * NA INSTANCJI DOCELOWEJ. Gałąź `0` dokłada kolumny od razu jako `NOT NULL`;
 * gałąź `> 0` idzie trójfazowo (`ADD COLUMN NULL` → backfill → `SET NOT NULL`),
 * a wiersz, dla którego backfill nie znalazł rynku, ZATRZYMUJE migrację zamiast
 * dostać `'unknown'`. Wiersz bez rynku na ścieżce pieniądza jest gorszy niż brak
 * wiersza, bo wygląda na dane.
 *
 * Konsekwencja, którą trzeba znać przy uruchamianiu na środowisku: backfill
 * czyta `entitlement_instance`, które od migracji 2.6 (`1779000000000`) jest pod
 * `FORCE ROW LEVEL SECURITY`. `FORCE` obejmuje także WŁAŚCICIELA tabeli, więc
 * rola migracyjna bez `BYPASSRLS`/superusera i bez `app.gp_market_id` zobaczy
 * ZERO wierszy źródłowych. Nie kończy się to cichym `'unknown'` — kończy się
 * `GP_VOUCHER_REDEMPTION_BACKFILL_NO_MARKET` i zatrzymaniem migracji.
 *
 * ── Rozstrzygnięcie luki backfillu (ADR-197) ────────────────────────────────
 * ADR-178 §2.4 daje `redemption_market_id` jedno źródło — kontekst realizacji
 * (rynek sesji panelu). Przy backfillu wierszy zastanych tego kontekstu NIE MA
 * i mieć nie może. Rozstrzygnięcie: dla wierszy zastanych
 * `redemption_market_id := purchase_market_id`, bo przed tą migracją ścieżka
 * realizacji cross-market nie istniała (producent kanonicznej miał zero wywołań
 * produkcyjnych, ADR-178 dowód (a)). Fail-closed obowiązuje dla
 * `purchase_market_id`: brak rynku zakupu zatrzymuje migrację.
 *
 * ── `up()` idempotentny, `down()` NIE-DESTRUKCYJNY ──────────────────────────
 * Wzorzec `1778929000000`: rollback NIE kasuje kolumn ani wierszy. Skasowanie
 * rejestru realizacji/odwróceń groziłoby podwojeniem realizacji po
 * re-aplikacji — odwrotnością celu tabeli. `down()` zdejmuje wyłącznie to, co
 * da się zdjąć bez utraty faktu: politykę RLS i `FORCE`.
 */

const MARKET_SETTING = `current_setting('app.gp_market_id', true)`

/**
 * Rola PRODUCENTA kanonicznej. To ta sama rola, na którą przełącza się hook puli
 * (`lib/rls-pool-hook.ts` → `SET ROLE medusa_store`), czyli rola, którą realnie
 * jedzie `PostgresRedeemPartialStore.insertRedemption`. Grant INSERT dostaje
 * WYŁĄCZNIE ona.
 */
const PRODUCER_ROLE = "medusa_store"

/**
 * Pozostałe role ruchu na schemacie `public` (zastane: `infra/postgres/migrations/003`
 * i `009`). Dostają `SELECT`, nigdy `INSERT`/`UPDATE`/`DELETE` na kanonicznej.
 */
const READ_ONLY_TRAFFIC_ROLES = ["medusa_market_ops"] as const

export class Migration1779004000000 extends Migration {
  async up(): Promise<void> {
    // ── (1) Kolumny: gałąź wybrana POMIAREM `count(*)` na instancji docelowej ─
    // Obie gałęzie kończą się tym samym stanem: NOT NULL. Różni je tylko droga.
    // Blok jest idempotentny: `ADD COLUMN IF NOT EXISTS` + `SET NOT NULL` na
    // kolumnie już `NOT NULL` to no-opy, a backfill na komplecie wypełnionych
    // wierszy nie zmienia niczego.
    this.addSql(`
      DO $$
      DECLARE
        existing_rows bigint;
        rows_without_market bigint;
      BEGIN
        -- KROK PIERWSZY, wymagany przez ADR-178 §2.4.
        SELECT count(*) INTO existing_rows FROM voucher_redemption;

        IF existing_rows = 0 THEN
          -- Tabela pusta ⇒ kolumny od razu NOT NULL, bez fazy przejściowej.
          ALTER TABLE voucher_redemption
            ADD COLUMN IF NOT EXISTS market_id            text NOT NULL,
            ADD COLUMN IF NOT EXISTS purchase_market_id   text NOT NULL,
            ADD COLUMN IF NOT EXISTS redemption_market_id text NOT NULL,
            ADD COLUMN IF NOT EXISTS kind                 text NOT NULL,
            ADD COLUMN IF NOT EXISTS reverses_redemption_id text NULL;
        ELSE
          -- Tabela niepusta ⇒ ADD COLUMN NULL → backfill → SET NOT NULL.
          ALTER TABLE voucher_redemption
            ADD COLUMN IF NOT EXISTS market_id            text NULL,
            ADD COLUMN IF NOT EXISTS purchase_market_id   text NULL,
            ADD COLUMN IF NOT EXISTS redemption_market_id text NULL,
            ADD COLUMN IF NOT EXISTS kind                 text NULL,
            ADD COLUMN IF NOT EXISTS reverses_redemption_id text NULL;

          -- Reguła backfillu ADR-178 §2.4, w tej kolejności:
          --   (1) entitlement_instance.market_id,
          --   (2) policy_snapshot->>'market_id', gdy (1) puste.
          UPDATE voucher_redemption vr
             SET purchase_market_id = COALESCE(
                   NULLIF(ei.market_id, ''),
                   NULLIF(ei.policy_snapshot->>'market_id', '')
                 )
            FROM entitlement_instance ei
           WHERE ei.id = vr.entitlement_id
             AND vr.purchase_market_id IS NULL;

          -- ADR-197: wiersz zastany nie ma kontekstu realizacji, a przed tą
          -- migracją realizacja cross-market nie istniała.
          UPDATE voucher_redemption
             SET redemption_market_id = purchase_market_id
           WHERE redemption_market_id IS NULL
             AND purchase_market_id IS NOT NULL;

          -- market_id NIE MA własnego źródła: jest kopią purchase_market_id.
          UPDATE voucher_redemption
             SET market_id = purchase_market_id
           WHERE market_id IS NULL
             AND purchase_market_id IS NOT NULL;

          -- Wiersze zastane sa realizacjami (ADR-178 par. 2.3, tabela kind).
          UPDATE voucher_redemption SET kind = 'REDEMPTION' WHERE kind IS NULL;

          -- FAIL-CLOSED: brak rynku ZATRZYMUJE migrację. Nie 'unknown',
          -- nie wartość domyślna, nie NULL.
          SELECT count(*) INTO rows_without_market
            FROM voucher_redemption
           WHERE market_id IS NULL
              OR purchase_market_id IS NULL
              OR redemption_market_id IS NULL;
          IF rows_without_market > 0 THEN
            RAISE EXCEPTION
              'GP_VOUCHER_REDEMPTION_BACKFILL_NO_MARKET: % wierszy voucher_redemption '
              'nie ma rynku po backfillu (entitlement_instance.market_id oraz '
              'policy_snapshot->>''market_id'' puste, albo entitlement_instance jest '
              'niewidoczne dla roli migracyjnej pod FORCE RLS z 2.6). Migracja '
              'zatrzymana fail-closed — wiersz bez rynku na ścieżce pieniądza '
              'wygląda na dane (ADR-178 §2.4).',
              rows_without_market;
          END IF;

          ALTER TABLE voucher_redemption
            ALTER COLUMN market_id            SET NOT NULL,
            ALTER COLUMN purchase_market_id   SET NOT NULL,
            ALTER COLUMN redemption_market_id SET NOT NULL,
            ALTER COLUMN kind                 SET NOT NULL;
        END IF;
      END
      $$;
    `)

    // Gałąź `existing_rows = 0` dokłada `kind` jako NOT NULL bez wartości —
    // to jest poprawne WYŁĄCZNIE dla pustej tabeli. Backfill wyżej pokrywa
    // gałąź niepustą. Żadna z gałęzi nie zostawia DEFAULT-u: producent MUSI
    // podać `kind` jawnie (allow-lista, nie domyślność — AD-17).

    // ── (2) CHECK-i i UNIQUE — dosłownie z ADR-178 §2.4 ──────────────────────
    // `ADD CONSTRAINT` nie ma `IF NOT EXISTS` w PG 17, więc idempotencja idzie
    // przez `pg_constraint`.
    const constraints: Array<[string, string]> = [
      [
        "voucher_redemption_kind_check",
        `CHECK (kind IN ('REDEMPTION','REVERSAL'))`,
      ],
      [
        // reverses_redemption_id istnieje wtedy i tylko wtedy, gdy wpis jest odwróceniem
        "voucher_redemption_reversal_link_check",
        `CHECK ((kind = 'REVERSAL') = (reverses_redemption_id IS NOT NULL))`,
      ],
      [
        "voucher_redemption_market_id_check",
        `CHECK (char_length(market_id) > 0)`,
      ],
      [
        "voucher_redemption_purchase_market_id_check",
        `CHECK (char_length(purchase_market_id) > 0)`,
      ],
      [
        "voucher_redemption_redemption_market_id_check",
        `CHECK (char_length(redemption_market_id) > 0)`,
      ],
      [
        // market_id jest denormalizacja, nie trzecim niezaleznym rynkiem
        "voucher_redemption_market_denorm_check",
        `CHECK (market_id IN (purchase_market_id, redemption_market_id))`,
      ],
      [
        // redemption_id identyfikuje DOKLADNIE jeden wiersz (ADR-178 §2.3)
        "voucher_redemption_redemption_id_key",
        `UNIQUE (redemption_id)`,
      ],
    ]
    for (const [name, definition] of constraints) {
      this.addSql(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conname = '${name}'
               AND conrelid = 'voucher_redemption'::regclass
          ) THEN
            ALTER TABLE voucher_redemption ADD CONSTRAINT ${name} ${definition};
          END IF;
        END
        $$;
      `)
    }

    // ── (3) PK rozszerzony o `kind` (ADR-178 §2.3) ───────────────────────────
    // Dzisiejszy PK `(entitlement_id, idempotency_key)` NIE odróżnia odwrócenia
    // od realizacji o tym samym kluczu — a `REVERSAL` niesie DOKŁADNIE ten sam
    // `idempotency_key` co odwracana realizacja. Bez tego kroku `ON CONFLICT
    // DO NOTHING` wchłonąłby odwrócenie jako replay realizacji.
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'voucher_redemption_pkey'
             AND conrelid = 'voucher_redemption'::regclass
             AND array_length(conkey, 1) = 2
        ) THEN
          ALTER TABLE voucher_redemption DROP CONSTRAINT voucher_redemption_pkey;
          ALTER TABLE voucher_redemption
            ADD CONSTRAINT voucher_redemption_pkey
            PRIMARY KEY (entitlement_id, idempotency_key, kind);
        END IF;
      END
      $$;
    `)

    // ── (4) Indeksy — ADR-178 §2.4 ───────────────────────────────────────────
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_voucher_redemption_entitlement_kind
        ON voucher_redemption (entitlement_id, kind)
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_voucher_redemption_market
        ON voucher_redemption (redemption_market_id)
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_voucher_redemption_reverses
        ON voucher_redemption (reverses_redemption_id)
        WHERE reverses_redemption_id IS NOT NULL
    `)

    // ── (4b) Indeks MOSTU kod → uprawnienie (ADR-197 §2.9) ───────────────────
    // `resolveEntitlementsByVoucherCodeForUpdate` filtruje po wyrażeniu
    // `policy_snapshot->>'voucher_code'` i robi to POD `FOR UPDATE`, czyli
    // wewnątrz transakcji trzymającej row-lock. Bez indeksu wyrażeniowego każde
    // `POST /vendor/vouchers/:code/redeem` wykonuje SEKWENCYJNY SKAN
    // `entitlement_instance` dokładnie w oknie, w którym czekają równoległe
    // realizacje TEGO SAMEGO uprawnienia. To jest decyzja o schemacie ścieżki
    // pieniądza, więc należy do ADR-a (ADR-197 §2.9), nie do komentarza w kodzie.
    // Indeks jest wyrażeniowy, bo denormalizacja `voucher_code` do własnej
    // kolumny zmieniałaby kształt zamrożony w ADR-178 §2.4.
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_entitlement_instance_voucher_code
        ON entitlement_instance ((policy_snapshot->>'voucher_code'))
    `)

    // ── (5) RLS na kanonicznej — wejście zaplanowane przez 2.6 ───────────────
    // Migracja 2.6 (`1779000000000`) świadomie zostawiła `voucher_redemption`
    // poza swoim zakresem, nazywając 5.7 jako story, która ją wprowadza.
    // Izolacja idzie po `market_id`, czyli po rynku ZAKUPU (ADR-178 §2.4,
    // „Konsekwencja dla widoczności" — decyzja, nie skutek uboczny).
    // ZAKAZ furtki `OR market_id IS NULL` (ADR-141 §4, P1).
    this.addSql(`ALTER TABLE voucher_redemption ENABLE ROW LEVEL SECURITY`)
    this.addSql(`ALTER TABLE voucher_redemption FORCE ROW LEVEL SECURITY`)
    this.addSql(
      `DROP POLICY IF EXISTS market_isolation ON voucher_redemption`,
    )
    this.addSql(`
      CREATE POLICY market_isolation ON voucher_redemption
        USING (market_id = ${MARKET_SETTING})
        WITH CHECK (market_id = ${MARKET_SETTING})
    `)

    // ── (6) GRANTY: egzekucja jednego producenta w warstwie bazy (AC4/Z-17) ──
    // Ta migracja jest nośnikiem `db_grant_status: enforced` w aktywnym rejestrze
    // `specs/contracts/redemption/redemption-producers.v2.yaml`. Deklaracja grantu
    // nie jest grantem — od tej migracji jedyną rolą z `INSERT` na kanonicznej jest
    // rola producenta, a `UPDATE`/`DELETE` nie ma ŻADNA rola ruchu. Append-only
    // z ADR-178 §2.3 przestaje zależeć od dyscypliny autora kodu.
    //
    // `REVOKE ALL` przed `GRANT` jest konieczny: `infra/postgres/migrations/003`
    // i `009` deklarują `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE,
    // DELETE ON TABLES`, więc tabela utworzona przez tę samą rolę mogłaby
    // odziedziczyć komplet uprawnień, w tym `DELETE`.
    this.addSql(`REVOKE ALL ON voucher_redemption FROM PUBLIC`)
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PRODUCER_ROLE}') THEN
          REVOKE ALL ON voucher_redemption FROM ${PRODUCER_ROLE};
          -- Rola producenta: SELECT + INSERT. Bez UPDATE, bez DELETE.
          GRANT SELECT, INSERT ON voucher_redemption TO ${PRODUCER_ROLE};
        END IF;
      END
      $$;
    `)
    for (const role of READ_ONLY_TRAFFIC_ROLES) {
      this.addSql(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
            REVOKE ALL ON voucher_redemption FROM ${role};
            GRANT SELECT ON voucher_redemption TO ${role};
          END IF;
        END
        $$;
      `)
    }

    // ── (7) Ledger musi umieć przyjąć posting ODWRACAJĄCY ────────────────────
    // `lifecycle_event` ma dziś allow-listę
    // `('ISSUED','REDEEMED','REDEEMED_PARTIAL','REDEEMED_FULL','EXPIRED')` —
    // i to w DWÓCH tabelach naraz (migracja `1778927000000`):
    // `voucher_ledger_transaction` ORAZ `ledger_posting_applied` (bariera dedupe,
    // PIERWSZY krok hand-rolled DB-tx writera). Rozszerzenie tylko jednej z nich
    // dawało `ledger_posting_applied_lifecycle_event_check` w połowie zapisu —
    // zmierzone wykonaniem, nie przewidziane z lektury.
    // Allow-lista zostaje allow-listą (AD-17): dokładamy JEDNĄ wartość.
    for (const table of [
      "voucher_ledger_transaction",
      "ledger_posting_applied",
    ]) {
      this.addSql(`
        ALTER TABLE ${table}
          DROP CONSTRAINT IF EXISTS ${table}_lifecycle_event_check
      `)
      this.addSql(`
        ALTER TABLE ${table}
          ADD CONSTRAINT ${table}_lifecycle_event_check
          CHECK (lifecycle_event IN (
            'ISSUED','REDEEMED','REDEEMED_PARTIAL','REDEEMED_FULL','EXPIRED','REFUNDED'
          ))
      `)
    }
  }

  /**
   * NIE-DESTRUKCYJNY rollback (wzorzec `1778929000000`).
   *
   * CELOWO nie kasuje kolumn, CHECK-ów ani wierszy: `voucher_redemption` jest
   * rejestrem realizacji i odwróceń: `DROP COLUMN kind` skasowałby rozróżnienie
   * realizacji od odwrócenia, a przywrócenie dwuczłonowego PK dopuściłoby
   * `ON CONFLICT DO NOTHING` wchłaniające odwrócenie jako replay realizacji.
   * Cofnięcie błędu = forward-fix.
   *
   * Zdejmowane jest wyłącznie to, czego zdjęcie NIE traci faktu: polityka RLS
   * i `FORCE` (symetrycznie do `down()` migracji 2.6). Granty zostają świadomie —
   * ich odebranie zabrałoby uprawnienia stanowi sprzed migracji.
   */
  async down(): Promise<void> {
    this.addSql(`DROP POLICY IF EXISTS market_isolation ON voucher_redemption`)
    this.addSql(`ALTER TABLE voucher_redemption NO FORCE ROW LEVEL SECURITY`)
    this.addSql(`ALTER TABLE voucher_redemption DISABLE ROW LEVEL SECURITY`)
  }
}
