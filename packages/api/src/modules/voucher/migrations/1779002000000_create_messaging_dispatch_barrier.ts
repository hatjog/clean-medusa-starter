import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.15.0 Story 4.1 (FR-9a, FR-9b, AD-23, NFR-1, NFR-4, ADR-196) — TRWAŁY
 * nośnik bariery idempotencji wysyłki `messaging_dispatch_barrier`.
 *
 * Stempel `1779002000000` POCHODZI Z REJESTRU
 * `specs/releases/v1.15.0/migration-registry.yaml` (`story_id: "4.1"`,
 * `module: voucher`), a nie z generatora w worktree — Z-10: jeden właściciel
 * numeracji na release.
 *
 * ── Co ta tabela zastępuje ─────────────────────────────────────────────────
 * Mapę `idempotencyCache` w pamięci procesu (`packages/messaging/src/gateway.ts`
 * do v1.14.0). Przy dwóch instancjach backendu każda miała własną mapę, więc
 * to samo zdarzenie obsłużone przez drugą instancję wysyłało DRUGI mail.
 *
 * ── Dlaczego tabela, skoro `voucher_delivery_dispatch` już jest barierą ─────
 * Bo wiersz skutku istnieje TYLKO dla ścieżki zakupowej vouchera. Zmierzony
 * zbiór produkcyjnych call-site'ów wysyłki obejmuje też magic-link odzyskiwania
 * konta, potwierdzenie wizyty i powiadomienie o odbiorze — te NIE MAJĄ wiersza
 * skutku i po usunięciu mapy zostałyby bez jakiejkolwiek bariery.
 *
 * Na ścieżce zakupowej NIE powstaje przez to trzecia warstwa prawdy:
 * `voucher_delivery_dispatch.reserveDispatch` (INSERT-first `ON CONFLICT DO
 * NOTHING`, wołany PRZED `Modules.NOTIFICATION`) zostaje barierą PIERWSZĄ i
 * jedyną, która decyduje, czy wysyłka w ogóle rusza. Ta tabela jest barierą
 * kanału — pilnuje, żeby jeden ZAAKCEPTOWANY zamiar wysyłki dał jedno
 * wywołanie providera. Klucze są rozłączne semantycznie: tam „czy ten mail
 * poszedł do tego entitlementu", tu „czy ten konkretny zamiar wysyłki został
 * już oddany providerowi".
 *
 * ── Dlaczego `barrier_key` jest KLUCZEM GŁÓWNYM ────────────────────────────
 * Bo ograniczenie unikalności JEST barierą (AD-23). Kod nie „sprawdza, czy
 * klucz istnieje" — wysyła jedno `INSERT … ON CONFLICT (barrier_key) DO UPDATE
 * … WHERE expires_at IS NOT NULL AND expires_at <= $now RETURNING …` i czyta
 * werdykt z liczby zwróconych wierszy. Bez tego ograniczenia całe stwierdzenie
 * nie miałoby na czym stanąć.
 *
 * ── `expires_at` to PREDYKAT, nie zadanie sprzątające ──────────────────────
 * Wygasanie realizuje `WHERE` na `DO UPDATE`: wygasły wiersz przestaje blokować
 * SAM Z SIEBIE, bez udziału jakiegokolwiek crona. ZATRZYMANY SPRZĄTACZ NIE
 * ZMIENIA WERDYKTU BARIERY. Indeks po `expires_at` obsługuje wyłącznie HIGIENĘ.
 *
 * ── `expires_at IS NULL` znaczy BEZTERMINOWO ───────────────────────────────
 * I to jest rozróżnienie, którego AC4 zabrania mieszać w jednym predykacie bez
 * nazwania: dostawa ZAKOŃCZONA (mail poszedł) zamyka barierę na zawsze — tak
 * samo, jak migracja `1778933000000` deklaruje dla wierszy `sent`/`delivered`
 * („NIE ma TTL i nie wolno go czyścić — usunięcie = ryzyko duplikatu maila").
 * OKNO dotyczy wyłącznie stanu NIEJEDNOZNACZNEGO (fail, którego nie umiemy
 * rozstrzygnąć) oraz zajęcia `in_flight`. Predykat obsługuje oba przypadki
 * jednym warunkiem, bo `NULL <= now` nigdy nie jest prawdą — bezterminowość
 * jest więc własnością DANYCH, nie drugiej gałęzi kodu.
 *
 * ── `dispatch` (jsonb) ─────────────────────────────────────────────────────
 * Wynik rozstrzygniętego przebiegu, żeby ponowienie dostało TĘ SAMĄ odpowiedź
 * zamiast błędu. Odczytywany DOPIERO PO werdykcie bariery i nigdy go nie
 * zmienia. Zawiera kopertę audytową dispatchu — a ta z konstrukcji nie niesie
 * surowego PII (odbiorca wyłącznie jako `hashed_recipient`, D-70).
 *
 * ── `down()` kasuje tabelę ─────────────────────────────────────────────────
 * W odróżnieniu od ledgera dostarczeń (`1778933000000`, `down()` no-op), tu
 * rollback jest bezpieczny w tym sensie, że nie niszczy HISTORII dostarczeń —
 * tamta zostaje w `voucher_delivery_dispatch`. Utrata tej tabeli oznacza
 * powrót do stanu sprzed bariery kanału, czyli dokładnie do tego, co rollback
 * ma przywrócić.
 */
export class Migration1779002000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS messaging_dispatch_barrier (
        barrier_key text PRIMARY KEY,
        -- 'in_flight' = zajęte, provider jeszcze nie odpowiedział.
        -- 'settled'   = przebieg rozstrzygnięty (wynik w kolumnie dispatch).
        state       text NOT NULL CHECK (state IN ('in_flight', 'settled')),
        dispatch    jsonb,
        -- NULL = BEZTERMINOWO (patrz docstring). Wartość = koniec okna.
        expires_at  timestamptz,
        -- Token BIEŻĄCEGO zajęcia. Domknięcie (settle) i zwolnienie (release)
        -- mają go w WHERE, więc dotykają WYŁĄCZNIE własnego zajęcia. Bez tej
        -- kolumny sam warunek na state odróżniał zajęcie niedomknięte od
        -- rozstrzygniętego, ale NIE własne od przejętego przez inny proces po
        -- wygaśnięciu okna — a spóźnione release/settle z porzuconego przebiegu
        -- otwierało wtedy drogę drugiemu mailowi (R-4.1-M3).
        claim_token text NOT NULL,
        claim_count integer NOT NULL DEFAULT 1,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `)

    // Wyłącznie HIGIENA (kasowanie wygasłych wierszy). Brak tego indeksu NIE
    // zmieniłby werdyktu bariery — ten stoi na kluczu głównym.
    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_messaging_dispatch_barrier_expires_at
        ON messaging_dispatch_barrier (expires_at)
        WHERE expires_at IS NOT NULL
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS idx_messaging_dispatch_barrier_expires_at`)
    this.addSql(`DROP TABLE IF EXISTS messaging_dispatch_barrier`)
  }
}
