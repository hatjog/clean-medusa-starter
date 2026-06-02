import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story 3.3 (v1.11.0 Epic 3 / Wave 3) — pola net-new dla PER-ENTITLEMENT
 * idempotencji live-issue Path Y: `entitlement_dedupe_key` + `recipient_index`
 * na `entitlement_instance` (warstwa danych pod writer ISSUED).
 *
 * Podstawa normatywna: ADR-137 §Decyzja pkt 3 / DEC-5 pkt 3.ii (dwupoziomowa
 * idempotencja), finding H-2 (`recipient_index`/`entitlement_dedupe_key` są
 * NET-NEW — model ma `recipient_customer_id`/`claim_token`, nie te pola; dev je
 * dodaje), finding L-2 (klucz = pełny hex digest, BEZ truncacji), FR10 (jeden
 * zakup ⇒ wiele entitlementów per-recipient).
 *
 * Zakres (TYLKO struktura DB — single-module `voucher`):
 *   1. `entitlement_dedupe_key text` — deterministyczny klucz
 *      `sha256(payment_intent_id ‖ line_item_id ‖ recipient_index)` (logika
 *      budowania = `models/entitlement-dedupe.ts`). Nullable: wiersze
 *      legacy/authored oraz aktywna ścieżka `payment.captured` (issue-entitlement.ts,
 *      v1.9.0) jej NIE wypełniają — kolumna jest net-new dla Path Y `gp.stripe.
 *      payment_intent_succeeded.v1` (Story 3.1/3.3).
 *   2. `recipient_index int` — deterministyczny indeks recipienta zamrożonego
 *      w immutable payload płatności (precondition ADR-137). Nullable (patrz wyżej).
 *   3. PARTIAL UNIQUE index `entitlement_instance_dedupe_key_uq` na
 *      `(entitlement_dedupe_key) WHERE entitlement_dedupe_key IS NOT NULL` —
 *      egzekwuje dedupe per-entitlement w DB (target dla `ON CONFLICT
 *      (entitlement_dedupe_key) DO NOTHING`). NULL-e są zwolnione (wiele wierszy
 *      legacy/captured-path bez klucza współistnieje), spójnie ze wzorcem
 *      partial-constraint z `1778925500000_add_line_item_id...` (partial UNIQUE
 *      `(order_id, line_item_id)`).
 *   4. CHECK `recipient_index >= 0` (NOT VALID) — domena nieujemna; egzekwowane
 *      na nowych zapisach Path Y, bez walidacji wstecznej.
 *
 * SINGLE-MODULE (NFR6): migracja dotyka WYŁĄCZNIE tabeli `entitlement_instance`
 * (moduł `voucher`). Brak cross-modułowego DDL ⇒ brak triggera STOP-i-pytaj.
 *
 * Bezpieczeństwo aplikacji na realnym PG (z danymi):
 *   - kolumny: `ADD COLUMN IF NOT EXISTS` (idempotentne, NULL dla istniejących);
 *   - UNIQUE index: `CREATE UNIQUE INDEX IF NOT EXISTS ... WHERE ... IS NOT NULL`
 *     (partial — istniejące wiersze z NULL kluczem NIE łamią unikalności, więc
 *     migracja stosuje się CZYSTO niezależnie od danych legacy);
 *   - CHECK: `NOT VALID` + idempotentny guard `pg_catalog.pg_constraint`
 *     (egzekwowane od teraz, bez walidacji wstecznej; re-run `up()` bezpieczny —
 *     Postgres nie ma `ADD CONSTRAINT IF NOT EXISTS`).
 *
 * `down()` NON-DESTRUKCYJNY (spójnie z 3.2 `1778928100000` i 2.6 D1 — append-only
 * finance-adjacent): rollback NIE robi `DROP COLUMN`/`DROP INDEX`/`DROP CONSTRAINT`.
 * `entitlement_instance` jest finance-adjacent (entitlement = zobowiązanie);
 * cofnięcie błędu = forward-fix, NIGDY destrukcyjne usunięcie klucza idempotencji
 * (utrata klucza ⇒ ryzyko podwojenia issue przy re-aplikacji). Świadomy no-op.
 *
 * GRANICA (E3): migracja dostarcza WARSTWĘ DANYCH. NIE wypełnia kolumn (zapis =
 * writer 3.3), NIE okablowuje maszyny stanów (3.4), NIE aktywuje postingu
 * (`runtime_enabled` = `false`, flip = E6/P6).
 */
export class Migration1778928200000 extends Migration {
  async up(): Promise<void> {
    // ── kolumny net-new (nullable; idempotentne) ────────────────────────────
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        ADD COLUMN IF NOT EXISTS entitlement_dedupe_key text NULL
    `)
    this.addSql(`
      ALTER TABLE IF EXISTS entitlement_instance
        ADD COLUMN IF NOT EXISTS recipient_index integer NULL
    `)

    // ── partial UNIQUE: dedupe per-entitlement (FR10, DEC-5 pkt 3.ii) ─────────
    // Target dla `ON CONFLICT (entitlement_dedupe_key) DO NOTHING`. Partial
    // (WHERE NOT NULL) ⇒ wiersze bez klucza (legacy / captured-path) współistnieją.
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS entitlement_instance_dedupe_key_uq
        ON entitlement_instance (entitlement_dedupe_key)
        WHERE entitlement_dedupe_key IS NOT NULL
    `)

    // ── domena recipient_index: nieujemna (NOT VALID, idempotentny guard) ─────
    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint
          WHERE conname = 'entitlement_instance_recipient_index_chk'
        ) THEN
          ALTER TABLE entitlement_instance
            ADD CONSTRAINT entitlement_instance_recipient_index_chk
            CHECK (recipient_index IS NULL OR recipient_index >= 0)
            NOT VALID;
        END IF;
      END $$;
    `)
  }

  /**
   * NON-DESTRUKCYJNY rollback (Story 3.3 / 3.2 / 2.6 D1). CELOWO NIE wykonuje
   * `DROP COLUMN`/`DROP INDEX`/`DROP CONSTRAINT`: `entitlement_instance` jest
   * finance-adjacent, a `entitlement_dedupe_key` + jego UNIQUE index to bariera
   * idempotencji issue. Cofnięcie błędnego stanu = forward-fix; usunięcie klucza
   * podniosłoby ryzyko podwojenia entitlementu przy re-aplikacji. Świadomy,
   * udokumentowany no-op.
   */
  async down(): Promise<void> {
    // intencjonalnie puste — patrz docstring (append-only finance-adjacent, NIE DROP).
  }
}
