import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Story 3.3 (v1.11.0 Epic 3 / Wave 3) — review fix H1: ZAOSTRZENIE fail-closed
 * scope `sales_channel_id` dla wierszy LIVE-ISSUED (Path Y), jawnie DEFEROWANE
 * przez Story 3.2 do 3.3 ("writer wypełni `sales_channel_id` … wtedy CHECK zostanie
 * zaostrzony — promocja constraintu na live-issued").
 *
 * Podstawa normatywna: FR21 (ontologia / izolacja per channel), NFR3 (multi-tenant
 * fail-closed), ADR-137 (live-issue Path Y). Domyka finding review H1.
 *
 * ── CO ROBI ─────────────────────────────────────────────────────────────────
 * Dodaje CHECK `entitlement_instance_sales_channel_scope_chk` wymagający, by
 * KAŻDY wiersz live-issued Path Y niósł NIEPUSTY `sales_channel_id`. Wiersz
 * Path Y jest jednoznacznie identyfikowany przez `entitlement_dedupe_key IS NOT NULL`
 * (klucz per-entitlement z migracji 3.3 `1778928200000` — wypełniany WYŁĄCZNIE
 * przez writer Path Y `live-issue-from-payment-intent.ts`).
 *
 *   CHECK (entitlement_dedupe_key IS NULL
 *          OR (sales_channel_id IS NOT NULL AND char_length(sales_channel_id) > 0))
 *
 * ── DLACZEGO KLUCZOWANE NA `entitlement_dedupe_key`, NIE `order_id` ───────────
 * Review H1 opisuje wymóg jako "dla `order_id IS NOT NULL` wymagaj `sales_channel_id`",
 * ale `order_id IS NOT NULL` obejmuje TAKŻE wiersze AKTYWNEJ ścieżki captured
 * (`payment.captured` → `issue-entitlement.ts`, v1.9.0 H-6) oraz reissue/retention
 * — które ustawiają `order_id` + `market_id`, ale CELOWO NIE `sales_channel_id`
 * (kolumna net-new; payload tych ścieżek jej nie przenosi) ANI `entitlement_dedupe_key`.
 * CHECK na `order_id` (nawet NOT VALID) ZŁAMAŁBY każdy nowy INSERT/UPDATE tych
 * ścieżek (constraint violation) — dokładnie powód, dla którego 3.2 deferowała wymóg.
 *
 * Kluczowanie na `entitlement_dedupe_key IS NOT NULL` egzekwuje fail-closed
 * DOKŁADNIE na ścieżce live-issued Path Y ("promocja constraintu na live-issued"
 * z 3.2), NIE dotykając captured/reissue/retention (`dedupe_key IS NULL` ⇒ zwolnione).
 * To ścisłe odczytanie intencji 3.2 ("live-issued" = Path Y), bez regresji v1.9.0 H-6.
 *
 * Writer Path Y (3.3) wypełnia `sales_channel_id` fail-loud (brak źródła ⇒ rzut +
 * retry, NIE zapis z null) — DB-CHECK jest drugą, egzekwowalną granicą (alternatywne
 * writery / replay / bezpośredni INSERT).
 *
 * Bezpieczeństwo aplikacji na realnym PG (z danymi):
 *   - CHECK `NOT VALID`: egzekwowany na INSERT/UPDATE od teraz (fail-closed dla
 *     nowych live-issue), bez walidacji wstecznej (istniejące wiersze — w tym
 *     ewentualne legacy z `dedupe_key` — nie blokują aplikacji migracji). Promocja
 *     do VALIDATED po backfillu = pre-prod.
 *   - idempotentny guard `pg_catalog.pg_constraint` (re-run `up()` bezpieczny —
 *     Postgres nie ma `ADD CONSTRAINT IF NOT EXISTS`).
 *
 * SINGLE-MODULE (NFR6): migracja dotyka WYŁĄCZNIE `entitlement_instance` (moduł
 * `voucher`). Brak cross-modułowego DDL ⇒ brak triggera STOP-i-pytaj.
 *
 * `down()` NON-DESTRUKCYJNY (spójnie z 3.2 `1778928100000` / 3.3 `1778928200000`
 * / 2.6 D1 — append-only finance-adjacent): rollback NIE robi `DROP CONSTRAINT`.
 * `entitlement_instance` jest finance-adjacent; cofnięcie błędu = forward-fix,
 * NIGDY destrukcyjne usunięcie granicy izolacji per-channel. Świadomy no-op.
 *
 * GRANICA (E3): migracja dostarcza WARSTWĘ EGZEKUCJI scope. NIE wypełnia kolumn
 * (zapis = writer 3.3), NIE okablowuje maszyny stanów (3.4), NIE aktywuje postingu
 * (`runtime_enabled` = `false`, flip = E6/P6).
 */
export class Migration1778928300000 extends Migration {
  async up(): Promise<void> {
    // ── fail-closed sales_channel_id dla live-issued Path Y (H1) ─────────────
    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint
          WHERE conname = 'entitlement_instance_sales_channel_scope_chk'
        ) THEN
          ALTER TABLE entitlement_instance
            ADD CONSTRAINT entitlement_instance_sales_channel_scope_chk
            CHECK (
              entitlement_dedupe_key IS NULL
              OR (sales_channel_id IS NOT NULL AND char_length(sales_channel_id) > 0)
            )
            NOT VALID;
        END IF;
      END $$;
    `)
  }

  /**
   * NON-DESTRUKCYJNY rollback (Story 3.3 review fix / 3.2 / 2.6 D1). CELOWO NIE
   * wykonuje `DROP CONSTRAINT`: `entitlement_instance` jest finance-adjacent, a
   * CHECK to granica izolacji per-channel (fail-closed). Cofnięcie błędnego stanu =
   * forward-fix. Świadomy, udokumentowany no-op.
   */
  async down(): Promise<void> {
    // intencjonalnie puste — patrz docstring (append-only finance-adjacent, NIE DROP).
  }
}
