import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.15.0 Story 5.9 review-fix (HIGH-2) — `entitlement_instance.expires_at`
 * uzupełnione z `voucher.expires_at` przez most kod → uprawnienie.
 *
 * Znacznik `1779010000000` DOPISANY do
 * `specs/releases/v1.15.0/migration-registry.yaml` (wpis `story_id: "5.9"`,
 * `kind: review-fix`), nie wygenerowany w worktree — ADR-177.
 *
 * ── Co naprawia ────────────────────────────────────────────────────────────
 * Do 5.9 stan kodu gasił bulk-`UPDATE` sterowany kolumną `voucher.expires_at`.
 * 5.9 usunęła ten zapis (był drugim producentem poza transakcją tranzycji)
 * i przeniosła wygaszanie na tranzycję uprawnienia — a sweeper bierze
 * kandydatów po `entitlement_instance.expires_at IS NOT NULL`. Produkcyjna
 * ścieżka wystawienia (Path Y) tej kolumny NIE wypełniała, więc od 5.9 żaden
 * voucher wystawiony normalnie już by nie wygasł: producent stanu `expired`
 * istniałby w kontrakcie i w bramce, a na realnej ścieżce nie odpaliłby się
 * ani razu.
 *
 * Nowe wiersze naprawia sam kod (`computeValidityEnd` zapisuje termin do OBU
 * nośników). Ta migracja domyka wiersze JUŻ ISTNIEJĄCE — inaczej zwężenie
 * populacji zostałoby ciche, a to jest dokładnie ta klasa defektu, którą
 * story usuwa.
 *
 * ── Dlaczego kopiujemy, a nie rozluźniamy bramki ───────────────────────────
 * `ExpireEntitlementOperation` z `require_due` żąda deterministycznego terminu
 * NA UPRAWNIENIU i słusznie: wygaszanie po terminie z innej tabeli byłoby
 * wygaszaniem po danych, których operacja nie zablokowała. Więc uzupełniamy
 * dane, zamiast osłabiać guard.
 *
 * ── `down()` — ODCISK MIGRACJI, NIE NIEZMIENNIK PRODUKCJI (review-fix cyklu 2,
 *    C2-MEDIUM-3) ─────────────────────────────────────────────────────────
 * Pierwsza wersja `down()` uznawała za „swoje" te wiersze, których
 * `expires_at` jest RÓWNY terminowi z mostu. To był błąd kategorii: sąsiednia
 * połowa TEGO SAMEGO fixa sprawia, że KAŻDY nowo wystawiony wiersz spełnia ten
 * predykat z konstrukcji — oba nośniki liczy jedno wyrażenie
 * `computeValidityEnd`, celowo, „bo dwa wyrażenia rozjechałyby się cicho".
 * Równość, która miała być odciskiem palca, jest niezmiennikiem produkcji, więc
 * rollback kasował `expires_at` WSZYSTKICH normalnie wystawionych voucherów —
 * a sweeper filtruje po `expires_at IS NOT NULL`, czyli `down()` przywracał
 * naprawiany defekt na CAŁEJ populacji. Rollback niszczący dane produkcyjne
 * jest gorszy niż brak rollbacku.
 *
 * Odciskiem jest teraz coś, czego produkcja nie stawia sama: tabela-rejestr
 * `entitlement_expires_at_backfill_1779010000000`, wypełniana przez `up()`
 * z `RETURNING` — czyli DOKŁADNIE zbiorem wierszy, które ta migracja
 * przestawiła, wraz z wartością, którą im nadała. `down()` cofa wyłącznie te
 * wiersze i wyłącznie wtedy, gdy nadal trzymają tę wartość (termin przedłużony
 * później przez `voucher.extend` zostaje nietknięty), a na końcu usuwa
 * rejestr — nie zostawia po sobie powierzchni.
 *
 * Rejestr jest artefaktem MIGRACJI, nie powierzchnią zapisu domeny: nie ma
 * producenta w `redemption-producers.v1.yaml`, nie ma trasy, nie ma polityki
 * RLS, i znika razem z `down()`. Trzyma wyłącznie identyfikator uprawnienia
 * i znacznik czasu — bez PII i bez danych finansowych.
 *
 * ── `REVOKE` na rejestrze (review-fix cyklu 3, SEC-2) ──────────────────────
 * „Nie ma RLS" było wyżej napisane jako właściwość BEZPIECZNA. Nie jest: tabela
 * powstaje w schemacie, dla którego `infra/postgres/migrations/003` i `009`
 * deklarują `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE
 * ON TABLES` dla ról ruchu, więc bez `REVOKE` rejestr DZIEDZICZY pełny DML.
 * Konsekwencja nie jest teoretyczna: `down()` ufa rejestrowi bezwarunkowo, więc
 * rola z `INSERT` na nim wskazuje rollbackowi DOWOLNE uprawnienia do
 * wyzerowania `expires_at` — czyli wypycha je z filtra sweepera wygaszeń
 * i odwraca dokładnie ten defekt, dla którego ta migracja powstała.
 * Wzorzec `REVOKE` jest ten sam, co w siostrzanej `1779004000000:293-320`.
 *
 * ── STRAŻNIK WIDOCZNOŚCI (review-fix cyklu 3, REG-HIGH-1) ─────────────────
 * `entitlement_instance` i `voucher` są od `1779000000000` pod `FORCE ROW LEVEL
 * SECURITY`, a `FORCE` obejmuje WŁAŚCICIELA tabeli. Rola migracyjna bez
 * `BYPASSRLS`/superusera i bez `app.gp_market_id` widzi ZERO wierszy
 * źródłowych, więc `UPDATE` wyżej obejmował zero wierszy, rejestr zostawał
 * pusty, a migracja kończyła się ZIELONO — poprawka, która nie wykonuje się
 * w warunkach produkcyjnych, nie jest poprawką. Zmierzone na żywym PG 17.6:
 * `evidence/5-9/backfill-rls-kontrola.out`, wariant RED.
 *
 * Gorsze od samego pominięcia było to, że po fixie cyklu 2 BRAK SYGNAŁU stał
 * się NIEODRÓŻNIALNY OD SUKCESU: pusty rejestr czyta się identycznie jako „nie
 * było czego backfillować" i jako „RLS mnie odciął". Dlatego strażnik mierzy
 * WIDOCZNOŚĆ (czy rola w ogóle może zobaczyć populację), a nie tylko wynik —
 * post-warunek na „ile zostało" pod odcięciem RLS też zwróciłby zero.
 *
 * Ryzyko było już NAZWANE w tym samym module przez siostrzaną migrację tego
 * samego release'u (`1779004000000:30-37`), która broni się `RAISE EXCEPTION`.
 * Ta robi teraz to samo, w dwóch krokach: przed backfillem — widoczność,
 * po backfillu — kompletność.
 */
const BACKFILL_LEDGER = "entitlement_expires_at_backfill_1779010000000"

/** Role ruchu, które dziedziczą DML z `ALTER DEFAULT PRIVILEGES` (003 / 009). */
const TRAFFIC_ROLES = ["medusa_store", "medusa_market_ops"] as const

/**
 * Predykat mostu kod → uprawnienie. JEDNO wyrażenie dla backfillu i dla
 * post-warunku: dwie kopie rozjechałyby się cicho, a wtedy post-warunek
 * mierzyłby coś innego niż to, co migracja przestawia.
 */
const BRIDGE_PREDICATE = `e.expires_at IS NULL
           AND v.expires_at IS NOT NULL
           AND v.code = e.policy_snapshot->>'voucher_code'`

export class Migration1779010000000 extends Migration {
  async up(): Promise<void> {
    // ── (1) STRAŻNIK WIDOCZNOŚCI — PRZED jakimkolwiek zapisem ───────────────
    // Pytanie brzmi „czy ta rola w ogóle MOŻE zobaczyć populację źródłową",
    // a nie „ile wierszy zostało". Pod odcięciem RLS oba pytania zwracają zero
    // i tylko pierwsze potrafi je od siebie odróżnić.
    this.addSql(`
      DO $$
      DECLARE
        v_bypass  boolean;
        v_super   boolean;
        v_forced  boolean;
      BEGIN
        SELECT rolbypassrls, rolsuper INTO v_bypass, v_super
          FROM pg_roles WHERE rolname = current_user;

        SELECT bool_or(c.relforcerowsecurity) INTO v_forced
          FROM pg_class c
         WHERE c.oid IN (to_regclass('entitlement_instance'), to_regclass('voucher'));

        IF COALESCE(v_forced, false)
           AND NOT COALESCE(v_bypass, false)
           AND NOT COALESCE(v_super, false) THEN
          RAISE EXCEPTION
            'GP_ENTITLEMENT_EXPIRES_AT_BACKFILL_BLIND: rola migracyjna % nie ma ani '
            'BYPASSRLS, ani superusera, a entitlement_instance/voucher sa pod FORCE ROW '
            'LEVEL SECURITY (2.6, migracja 1779000000000) — FORCE obejmuje takze '
            'WLASCICIELA tabeli. Taka rola widzi co najwyzej JEDEN rynek (ten z '
            'app.gp_market_id), a bez niego ZERO wierszy: backfill konczylby sie ZIELONO '
            'nie naprawiajac niczego, a pusty rejestr jest nieodroznialny od "nie bylo '
            'czego backfillowac". Backfill CALEJ populacji zastanej wymaga widocznosci '
            'CALEJ populacji. Uruchom migracje rola z BYPASSRLS albo superuserem.',
            current_user;
        END IF;
      END
      $$;
    `)

    this.addSql(`
      CREATE TABLE IF NOT EXISTS ${BACKFILL_LEDGER} (
        entitlement_id  text PRIMARY KEY,
        set_expires_at  timestamptz NOT NULL
      )
    `)

    // ── (2) REVOKE na rejestrze (SEC-2) ────────────────────────────────────
    // Rejestr steruje `down()`, więc rola ruchu z `INSERT`/`UPDATE` na nim
    // steruje tym, komu rollback wyzeruje `expires_at`. `REVOKE ALL` odcina
    // dziedziczenie z `ALTER DEFAULT PRIVILEGES`; żadna rola ruchu nie dostaje
    // niczego z powrotem — rejestr obsługuje wyłącznie rola migracyjna.
    this.addSql(`REVOKE ALL ON ${BACKFILL_LEDGER} FROM PUBLIC`)
    for (const role of TRAFFIC_ROLES) {
      this.addSql(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
            REVOKE ALL ON ${BACKFILL_LEDGER} FROM ${role};
          END IF;
        END
        $$;
      `)
    }

    // Idempotentne w OBU nośnikach: warunek `IS NULL` sprawia, że drugi
    // przebieg obejmuje zero wierszy, a `ON CONFLICT DO NOTHING` chroni
    // rejestr przed podwójnym wpisem, gdyby migracja została powtórzona po
    // częściowym `down()`.
    this.addSql(`
      WITH touched AS (
        UPDATE entitlement_instance e
           SET expires_at = v.expires_at,
               updated_at = NOW()
          FROM voucher v
         WHERE ${BRIDGE_PREDICATE}
        RETURNING e.id, e.expires_at
      )
      INSERT INTO ${BACKFILL_LEDGER} (entitlement_id, set_expires_at)
      SELECT id, expires_at FROM touched
      ON CONFLICT (entitlement_id) DO NOTHING
    `)

    // ── (3) DLACZEGO NIE MA TU POST-WARUNKU `count(*)` ─────────────────────
    // Odruch podpowiada dopisać post-warunek „ile uprawnien zostalo z
    // expires_at IS NULL mimo mostu" — tak jak robi siostrzana `1779004000000`.
    // Zmierzone: tutaj taki post-warunek byłby DEKORACJĄ, a nie pomiarem.
    //
    // Powód jest strukturalny: post-warunek dzieliłby z `UPDATE`-em POWYŻEJ
    // zarówno predykat (`BRIDGE_PREDICATE`, ta sama stała), jak i WIDOCZNOŚĆ
    // (ta sama rola, ta sama sesja, te same polityki RLS). Po strażniku (1)
    // rola ma `BYPASSRLS`, więc `UPDATE` obejmuje CAŁY zbiór spełniający
    // predykat — a wtedy post-warunek liczący ten sam predykat zwraca zero
    // ZAWSZE, niezależnie od tego, czy backfill zadziałał. Mechanizm bez
    // osiągalnego wejścia czyta się jak dowód, a nim nie jest.
    //
    // Zmierzone wykonaniem, nie rozumowaniem: wariant z post-warunkiem był
    // uruchomiony na żywym PG 17.6 przeciw populacji dwurynkowej z kontekstem
    // ustawionym dla JEDNEGO rynku (`evidence/5-9/backfill-rls-kontrola.sh`,
    // sekcja GREEN-c pierwszego przebiegu) i NIE zaczerwienił się — bo sam
    // `SELECT count(*)` był odcięty przez tę samą politykę, która odcięła
    // `UPDATE`. To jest ta sama klasa co pomiar sekretu na pliku roboczym
    // zamiast na historii gałęzi: właściwy warunek, zły nośnik pomiaru.
    //
    // Dlatego kompletność jest tu egzekwowana WEJŚCIEM (strażnik (1): pełna
    // widoczność albo zatrzymanie), a nie wyjściem. Post-warunek na wyjściu
    // wymagałby drugiego, niezależnego nośnika widoczności — a takiego ta
    // migracja nie ma i nie powinna sobie dorabiać.
  }

  async down(): Promise<void> {
    // Brak rejestru = `up()` nie przebiegł na tej bazie ⇒ `down()` jest
    // no-opem. To jest zamierzone: rollback bez odcisku NIE MA prawa zgadywać,
    // które wiersze są jego. `CREATE TABLE IF NOT EXISTS` jest tu po to, żeby
    // ten no-op był NO-OPEM, a nie błędem „relation does not exist" —
    // rollback, który się wywraca, nie jest rollbackiem.
    this.addSql(`
      CREATE TABLE IF NOT EXISTS ${BACKFILL_LEDGER} (
        entitlement_id  text PRIMARY KEY,
        set_expires_at  timestamptz NOT NULL
      )
    `)
    this.addSql(`
      UPDATE entitlement_instance e
         SET expires_at = NULL,
             updated_at = NOW()
        FROM ${BACKFILL_LEDGER} b
       WHERE b.entitlement_id = e.id
         AND e.expires_at = b.set_expires_at
    `)
    this.addSql(`DROP TABLE IF EXISTS ${BACKFILL_LEDGER}`)
  }
}
