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
 * Indeks czesciowy obsluguje jedyne zapytanie, ktore te kolumne czyta na
 * goraco — atomowe zajecie wierszy do eskalacji w skanie.
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
    this.addSql(`
      CREATE INDEX IF NOT EXISTS voucher_delivery_dispatch_escalation_pending_idx
        ON voucher_delivery_dispatch (attempt_count)
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
        DROP COLUMN IF EXISTS escalated_at
    `)
  }
}
