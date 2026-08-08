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
 * producenta w `redemption-producers.v1.yaml`, nie ma trasy, nie ma RLS,
 * i znika razem z `down()`. Trzyma wyłącznie identyfikator uprawnienia
 * i znacznik czasu — bez PII i bez danych finansowych.
 */
const BACKFILL_LEDGER = "entitlement_expires_at_backfill_1779010000000"

export class Migration1779010000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS ${BACKFILL_LEDGER} (
        entitlement_id  text PRIMARY KEY,
        set_expires_at  timestamptz NOT NULL
      )
    `)
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
         WHERE e.expires_at IS NULL
           AND v.expires_at IS NOT NULL
           AND v.code = e.policy_snapshot->>'voucher_code'
        RETURNING e.id, e.expires_at
      )
      INSERT INTO ${BACKFILL_LEDGER} (entitlement_id, set_expires_at)
      SELECT id, expires_at FROM touched
      ON CONFLICT (entitlement_id) DO NOTHING
    `)
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
