import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.15.0 Story 5.9 (FR-12, AD-17, SM-7) — `refunded` wchodzi do CHECK-a
 * `voucher_status_check`, czyli do NOŚNIKA OBOWIĄZUJĄCEGO zbioru stanów kodu
 * vouchera.
 *
 * Znacznik `1779008000000` POBRANY z `specs/releases/v1.15.0/migration-registry.yaml`
 * (wpis `story_id: "5.9"`), nie wygenerowany w worktree — ADR-177.
 *
 * ── Dlaczego stan kodu, a nie tylko stan uprawnienia ────────────────────────
 * Do tej story `entitlement_instance.state = 'REFUNDED'` nie miał ODPOWIEDNIKA
 * po stronie kodu. Trasa realizacji `/vendor/vouchers/:code/redeem` rozstrzyga
 * po `voucher.status`, więc zwrócony voucher pokazywał `idle`/`consent_pending`
 * i przechodził — pieniądze wracały do klientki, a salon i tak wykonywał zabieg.
 * Rozstrzygnięcie jest w ADR (patrz `specs/adr/`), tu jest tylko jego nośnik.
 *
 * ── `down()` NIE-DESTRUKCYJNY, ale i NIE UDAJĄCY ────────────────────────────
 * Zwężenie CHECK-a przy istniejących wierszach `refunded` musiałoby albo
 * skasować dane, albo przepisać je na inny stan — jedno i drugie byłoby
 * skłamaniem o zwrocie, który się wydarzył. Dlatego `down()` NAJPIERW liczy
 * takie wiersze i przy niezerowym wyniku ZATRZYMUJE rollback wyjątkiem
 * `GP_VOUCHER_REFUNDED_ROWS_PRESENT`. Rollback na bazie bez zwrotów przechodzi
 * normalnie i przywraca CHECK sprzed migracji (wzorzec `1778926100000`).
 */

/**
 * ── Dlaczego zbiór jest wpisany LITERAŁAMI, a nie sklejony ze stałej ────────
 * Nośnikiem OBOWIĄZUJĄCYM zbioru stanów jest ten CHECK, a porównuje go
 * `_grow/tools/validate_voucher_state_vocabulary.py` — statycznie, czytając
 * PIERWSZE wystąpienie klauzuli CHECK na kolumnie `status`. Zbiór sklejony z tablicy
 * (`${quoted(STATUSES)}`) jest dla tej bramki NIEWIDOCZNY: pasowałby do
 * wzorca, ale nie zawierałby ani jednej wartości, więc parity ze słownikiem
 * dawałaby pusty zbiór po jednej stronie. Ładniejszy kod kosztowałby tu
 * dokładnie tyle, ile jest wart pomiar — czyli wszystko.
 *
 * KOLEJNOŚĆ W PLIKU JEST CZĘŚCIĄ KONTRAKTU: `up()` PRZED `down()`, bo bramka
 * bierze pierwsze dopasowanie. `down()` przywraca CHECK sprzed migracji.
 */

export class Migration1779008000000 extends Migration {
  async up(): Promise<void> {
    // Idempotentne: `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`. Nazwa
    // constraintu jest jawna, żeby walidator słownika miał co porównać.
    this.addSql(`
      ALTER TABLE voucher
        DROP CONSTRAINT IF EXISTS voucher_status_check
    `)
    this.addSql(`
      ALTER TABLE voucher
        ADD CONSTRAINT voucher_status_check
        CHECK (status IN ('idle','consent_pending','claimed','withdrawn','expired','refunded'))
    `)
  }

  async down(): Promise<void> {
    // FAIL-CLOSED: rollback NIE kasuje ani nie przepisuje wierszy `refunded`.
    this.addSql(`
      DO $$
      DECLARE
        refunded_rows bigint;
      BEGIN
        SELECT count(*) INTO refunded_rows FROM voucher WHERE status = 'refunded';
        IF refunded_rows > 0 THEN
          RAISE EXCEPTION
            'GP_VOUCHER_REFUNDED_ROWS_PRESENT: % wierszy voucher ma status ''refunded''. '
            'Rollback zwężyłby CHECK poniżej danych, które istnieją — musiałby je '
            'skasować albo przepisać na inny stan, czyli skłamać o zwrocie, który '
            'się wydarzył. Migracja down() zatrzymana fail-closed (v1.15.0 Story 5.9).',
            refunded_rows;
        END IF;
      END
      $$;
    `)
    this.addSql(`
      ALTER TABLE voucher
        DROP CONSTRAINT IF EXISTS voucher_status_check
    `)
    this.addSql(`
      ALTER TABLE voucher
        ADD CONSTRAINT voucher_status_check
        CHECK (status IN ('idle','consent_pending','claimed','withdrawn','expired'))
    `)
  }
}
