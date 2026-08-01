import { Migration } from "@mikro-orm/migrations"

/**
 * Zapisuje ODPOWIEDŹ PROVIDERA (kod HTTP + zredagowany komunikat) przy każdej
 * porażce dostawy — w mutowalnym podsumowaniu i w append-only audycie.
 *
 * ── Kształt defektu (żywy zakup, zamówienie 18, 2026-08-01) ────────────────
 * Obie koperty wpadły do `voucher_delivery_dispatch` jako `failed`, bez
 * `provider_message_id`, z `error_code = VOUCHER_DELIVERY_DISPATCH_FAILED`
 * — i niczym więcej. Z ledgera NIE dawało się odróżnić błędu kodu od problemu
 * konta. Realna przyczyna (HTTP 401, `unauthorized`, „unrecognised IP address"
 * = włączona autoryzacja IP w Brevo) wyszła dopiero z ręcznego odpytania API
 * providera. Ledger, który nie notuje odpowiedzi providera, zamienia awarię
 * konfiguracji w nierozróżnialną awarię kodu.
 *
 * ── Zero PII i zero sekretów w kolumnie (D-70) ─────────────────────────────
 * `provider_message` przyjmuje WYŁĄCZNIE tekst po `sanitizeProviderDetail`
 * (`GP/backend/packages/messaging/src/provider-detail.ts`): adresy e-mail, IP,
 * znane kształty sekretów (`xkeysib-…`, `sk_test/live_…`, `whsec_…`, `Bearer …`,
 * DSN z hasłem) i długie tokeny są zastąpione placeholderami JESZCZE PRZED
 * zapisem. `BREVO_API_KEY` jest objęty podwójnie (wzorzec prefiksu + reguła
 * długiego tokenu). Kolumna nigdy nie dostaje surowego body odpowiedzi.
 *
 * CHECK długości jest TRZECIĄ barierą (po przycięciu w redaktorze i w ledgerze)
 * — treść pochodzi od zewnętrznego providera, więc jedna bariera to za mało.
 *
 * ── Bezpieczeństwo danych ──────────────────────────────────────────────────
 * Migracja jest CZYSTO ADDYTYWNA: `ADD COLUMN IF NOT EXISTS`, kolumny
 * `NULL`-owalne, ZERO `DROP`, zero `ALTER TYPE`, zero przepisywania wierszy.
 * Backfill jest niemożliwy i celowo go nie ma — historyczne wiersze `failed`
 * nigdy nie miały gdzie zapisać odpowiedzi providera, więc jedyną uczciwą
 * wartością dla nich jest `NULL` („nie wiemy"). Zmyślenie tu czegokolwiek
 * byłoby fabrykowaniem dowodu.
 *
 * IDEMPOTENCJA: CHECK jest deklarowany INLINE w `ADD COLUMN IF NOT EXISTS`,
 * a nie osobnym `ADD CONSTRAINT`. To istotne — `ADD CONSTRAINT` w tym repo NIE
 * przyjmuje `IF NOT EXISTS` (znany dług), więc powtórny przebieg wywracałby
 * migrację. Constraint inline powstaje RAZEM z kolumną i jest pomijany dokładnie
 * wtedy, gdy kolumna już istnieje.
 *
 * ── `down()` jest no-op ────────────────────────────────────────────────────
 * Ledger jest forward-only (tak samo jak `1778935000000` i `1778936000000`).
 * `DROP COLUMN` skasowałby jedyny zapisany ślad przyczyny porażek dostawy —
 * a to jest dokładnie ta klasa rollbacku, która niszczy dane (patrz
 * `20260606_224249_localize_pages.ts`, PR #696: drop kolumn bez backfillu).
 * Forward-fix jest jedyną bezpieczną korektą.
 */
export class Migration1778937000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE voucher_delivery_dispatch
        ADD COLUMN IF NOT EXISTS provider_status_code integer NULL
          CHECK (provider_status_code IS NULL
                 OR (provider_status_code >= 100 AND provider_status_code <= 599)),
        ADD COLUMN IF NOT EXISTS provider_message text NULL
          CHECK (provider_message IS NULL OR char_length(provider_message) <= 512)
    `)

    this.addSql(`
      ALTER TABLE voucher_delivery_dispatch_audit
        ADD COLUMN IF NOT EXISTS provider_status_code integer NULL
          CHECK (provider_status_code IS NULL
                 OR (provider_status_code >= 100 AND provider_status_code <= 599)),
        ADD COLUMN IF NOT EXISTS provider_message text NULL
          CHECK (provider_message IS NULL OR char_length(provider_message) <= 512)
    `)
  }

  override async down(): Promise<void> {
    // Ledger jest forward-only: usunięcie dowodu diagnostycznego nie jest
    // bezpieczną operacją rollbacku.
  }
}
