import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story 3.2 (v1.11.0 Epic 3 / Wave 3) — infrastruktura idempotencji konsumpcji
 * eventów: tabela `event_processed` (event-level dedupe).
 *
 * Podstawa normatywna: ADR-137 §Decyzja pkt 3 / DEC-5 — dwupoziomowa idempotencja:
 *   (i)  EVENT-LEVEL  — TA TABELA: dedupe po `external_id` (= `payment_intent.id`,
 *        kontrakt eventu Story 3.1 `gp.stripe.payment_intent_succeeded.v1`) + `event_type`.
 *   (ii) PER-ENTITLEMENT — `entitlement_dedupe_key` jako DB unique constraint na
 *        `entitlement_instance`, egzekwowany w Story 3.3 (subscriber). NIE tutaj —
 *        FR10: jeden zakup ⇒ wiele entitlementów per-recipient, więc dedupe po
 *        samym `external_id` jest niewystarczający (DEC-5). Ta migracja buduje
 *        WYŁĄCZNIE warstwę event-level.
 *
 * Kontrakt idempotencji (AC1, ADR-137 DEC-5 pkt 3.i):
 *   PRIMARY KEY (external_id, event_type) — composite. Ponowna dostawa (retry
 *   webhooka) tego samego eventu ⇒ `INSERT ... ON CONFLICT (external_id, event_type)
 *   DO NOTHING` = NO-OP (nie przetwarza ponownie, nie podwaja issue). Zapis
 *   `event_processed` + utworzenie entitlementów w JEDNEJ transakcji DB realizuje
 *   subscriber 3.3 (atomicity, ADR-137) — ta migracja dostarcza tabelę pod ten zapis.
 *
 * Wzorzec migracji (spójnie z 2.6 `1778927000000_create_voucher_ledger_tables.ts`):
 *   raw SQL hand-rolled DDL (NIE ORM auto-migration), `processed_at` epoch-ms
 *   (`bigint`, milisekundy), `up()` idempotentny (`CREATE TABLE IF NOT EXISTS`).
 *
 * `down()` NON-DESTRUKCYJNY (append-only, spójnie z 2.6 D1 / Story 3.2 T1):
 *   rollback NIE robi `DROP TABLE` — usunięcie tablicy idempotencji groziłoby
 *   ponownym przetworzeniem już skonsumowanych eventów (podwojenie issue) po
 *   re-applikacji. Cofnięcie błędu = forward-fix.
 *
 * Nazwa klasy `Migration1778928000000` (epoch-ms) sortuje się PO istniejących
 * migracjach modułu voucher (max `1778927000000` = 2.6 ledger).
 *
 * GRANICA (E3): tabela = WARSTWA DANYCH pod live-issue Path Y. NIE jest
 * subscriberem (3.3), NIE okablowuje maszyny stanów (3.4), NIE aktywuje postingu
 * (`runtime_enabled` zostaje `false`, flip = E6/P6). Migracja nie czyta ani nie
 * zmienia flagi aktywacji.
 *
 * NFR6 (cross-modułowość): tabela jest tworzona w module `voucher` i NIE odwołuje
 * się FK do tabel innych modułów (izolacja modułów Medusa 2) — migracja
 * single-module, brak triggera STOP-i-pytaj.
 *
 * RELACJA DO `webhook_event_processed` (review AI-02 / MEDIUM): `event_processed`
 * (PK `external_id`+`event_type` = dedupe KONSUMPCJI biznesowej / issuance) jest
 * KOMPLEMENTARNA, NIE redundantna, wobec istniejącej `webhook_event_processed`
 * (PK `event_id`+`provider` = dedupe DOSTAWY webhooka). Różne klucze, różne warstwy
 * — pełny kontrakt + kolejność użycia w 3.3 patrz docstring `models/event-processed.ts`.
 *
 * SEMANTYKA ROLLBACK (review AI-05 / LOW): `down()` tej tabeli jest forward-fix-only
 * (no-op, NIE DROP) — usunięcie rejestru groziłoby reprocessem. To NOWA tabela (brak
 * wcześniejszych migracji o mieszanej semantyce), więc rollback jest jednolicie
 * append-only (w odróżnieniu od `entitlement_instance` — patrz migracja `1778928100000`).
 */
export class Migration1778928000000 extends Migration {
  async up(): Promise<void> {
    // event-level dedupe: composite PK (external_id, event_type) jest jedynym
    // gwarantem idempotencji — replay tego samego eventu ⇒ konflikt PK ⇒ no-op.
    this.addSql(`
      CREATE TABLE IF NOT EXISTS event_processed (
        -- external_id = payment_intent.id (kontrakt Story 3.1, envelope.v1 payload).
        external_id   text NOT NULL CHECK (char_length(external_id) > 0),
        -- event_type = envelope event_type, np. 'gp.stripe.payment_intent_succeeded.v1'
        -- (naming AR-EVENTS). Dedupe jest per (external_id, event_type), bo ten sam
        -- payment_intent.id może wystąpić w różnych typach eventów.
        event_type    text NOT NULL CHECK (char_length(event_type) > 0),
        -- epoch-ms (bigint) — moment pierwszego przetworzenia. Konflikt PK na
        -- replayu zachowuje pierwotny processed_at (DO NOTHING).
        processed_at  bigint NOT NULL CHECK (processed_at > 0),
        CONSTRAINT event_processed_pkey PRIMARY KEY (external_id, event_type)
      )
    `)
  }

  /**
   * NON-DESTRUKCYJNY rollback (Story 3.2 T1, spójnie z 2.6 D1). CELOWO NIE
   * wykonuje `DROP TABLE` ani `DELETE`/`TRUNCATE`: usunięcie rejestru
   * przetworzonych eventów umożliwiłoby ponowne przetworzenie już skonsumowanych
   * webhooków (podwojenie issue) — odwrotność celu tej tabeli. Cofnięcie błędu =
   * forward-fix. Świadomy, udokumentowany no-op (NIE pominięcie).
   */
  async down(): Promise<void> {
    // intencjonalnie puste — patrz docstring (idempotencja append-only, NIE DROP).
  }
}
