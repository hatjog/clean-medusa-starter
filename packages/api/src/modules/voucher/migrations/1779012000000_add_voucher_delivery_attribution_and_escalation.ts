import { Migration } from "@mikro-orm/migrations"

/**
 * Story 4.6 (FR-9g, NFR-3) — dwa TRWALE nosniki przy wierszu dostawy.
 *
 * ── `non_recipient_failure_count` — atrybucja steruje budzetem (AC2) ────────
 * Do tej story `attempt_count` byl JEDNOCZESNIE licznikiem prob technicznych
 * i budzetem odbiorcy, a `reserveDispatch` inkrementowal go BEZWARUNKOWO — bez
 * pytania o atrybucje porazki. Skutek: blad dostawcy i awaria sieci zjadaly
 * proby klientki, mimo ze klasyfikator 4.3 rozstrzygal wprost, ze nie powinny
 * (`consumes_recipient_attempt: false` dla `failed`, ADR-192).
 *
 * Ta kolumna rozdziela oba znaczenia BEZ dodawania drugiego progu (AD-23,
 * Story 4.4 — budzet ma JEDEN nosnik, `attempt-policy.ts`):
 *
 *     budzet odbiorcy = attempt_count - non_recipient_failure_count
 *
 * Arytmetyka jest monotoniczna w obie strony, wiec nie da sie jej cofnac
 * wyscigiem dwoch kompensat — inaczej niz dekrement `attempt_count - 1`, ktory
 * zastapila (patrz usuniety `releaseAttemptBudget`).
 *
 * ── `escalated_at` — niepowtarzalnosc eskalacji (AC1) ───────────────────────
 * Skan chodzi co 15 minut i widzi ten sam zaparkowany wiersz w KAZDYM
 * przebiegu. Eskalacja powtarzana co cykl to alert, ktory czlowiek wycisza po
 * dwoch dniach — czyli cisza okrezna droga. Nosnik niepowtarzalnosci musi byc
 * TRWALY: mapa w pamieci procesu daje przy dwoch instancjach dwie eskalacje
 * i jest ksztaltem, ktory Story 4.1 z tego kodu usuwala.
 *
 * `NULL` znaczy „jeszcze nie eskalowal". Zwrot budzetu (odparkowanie) zeruje
 * to pole z powrotem do `NULL`: ponowne wyczerpanie jest NOWYM zdarzeniem dla
 * czlowieka, nie powtorka tego samego.
 *
 * Indeks czesciowy obsluguje SORTOWANIE I LIMIT jedynego zapytania, ktore te
 * kolumny czyta na goraco — atomowego zajecia wierszy do eskalacji w skanie.
 *
 * ── review-fix cyklu 1 (L2): klucz indeksu to porzadek, nie `attempt_count` ──
 * Pierwsza wersja indeksowala `(attempt_count)`. Zapytanie zajecia filtruje po
 * WYRAZENIU (`attempt_count - non_recipient_failure_count >= $2 OR
 * attempt_count >= $3`), ktorego indeks po jednej kolumnie nie pokrywa, a
 * porzadkuje po `first_failed_at ASC NULLS LAST, dispatch_id ASC` — wiec
 * Postgres i tak sortowal caly zbior wynikowy przed `LIMIT 50`. Kluczem jest
 * teraz porzadek zapytania; selektywnosc dalej daje predykat czesciowy.
 *
 * ── review-fix cyklu 1 (M1): budzet odbiorcy nie moze byc UJEMNY ────────────
 * `CHECK (non_recipient_failure_count >= 0)` pilnowal tylko dolnej granicy
 * licznika, nie jego RELACJI z `attempt_count`. Dowolny wywolujacy, ktory
 * obnizy `attempt_count` bez obnizenia licznika (tak robilo
 * `releaseParkedConfigurationFailureBudgets`), produkowal wiersz z fantomowym
 * kredytem, ktorego arytmetyka budzetu z tego docstringu nie przewiduje.
 * Niezmiennik jest teraz w BAZIE, nie w umowie miedzy wywolujacymi.
 */
export class Migration1779012000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE voucher_delivery_dispatch
        ADD COLUMN IF NOT EXISTS non_recipient_failure_count integer NOT NULL DEFAULT 0
          CHECK (non_recipient_failure_count >= 0)
    `)
    this.addSql(`
      ALTER TABLE voucher_delivery_dispatch
        ADD COLUMN IF NOT EXISTS escalated_at timestamptz NULL
    `)
    // Osobnym `ALTER`em, a nie inline przy kolumnie: ograniczenie wiaze DWIE
    // kolumny, a `IF NOT EXISTS` na kolumnie nie chroniloby przed dublem nazwy
    // przy powtornym przebiegu.
    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'voucher_delivery_dispatch_recipient_budget_nonneg_chk'
        ) THEN
          ALTER TABLE voucher_delivery_dispatch
            ADD CONSTRAINT voucher_delivery_dispatch_recipient_budget_nonneg_chk
            CHECK (non_recipient_failure_count <= attempt_count);
        END IF;
      END
      $$
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_delivery_dispatch_escalation_pending_idx
        ON voucher_delivery_dispatch (first_failed_at, dispatch_id)
        WHERE escalated_at IS NULL
          AND status <> 'sent'
          AND status <> 'delivered'
          AND status <> 'degraded'
    `)
  }

  override async down(): Promise<void> {
    // Ledger jest forward-only dla licznikow operacyjnych: skasowanie
    // `non_recipient_failure_count` przywrociloby stan, w ktorym awaria
    // dostawcy kasuje vouchery, i to BEZ sladu, ze kiedykolwiek bylo inaczej.
    // Zdejmujemy wylacznie indeks i znacznik eskalacji — ten drugi jest
    // odtwarzalny (`NULL` = „eskaluj ponownie"), wiec jego utrata co najwyzej
    // powtarza eskalacje, nigdy jej nie gubi.
    this.addSql(`
      DROP INDEX IF EXISTS voucher_delivery_dispatch_escalation_pending_idx
    `)
    this.addSql(`
      ALTER TABLE voucher_delivery_dispatch
        DROP CONSTRAINT IF EXISTS voucher_delivery_dispatch_recipient_budget_nonneg_chk
    `)
    this.addSql(`
      ALTER TABLE voucher_delivery_dispatch
        DROP COLUMN IF EXISTS escalated_at
    `)
  }
}
