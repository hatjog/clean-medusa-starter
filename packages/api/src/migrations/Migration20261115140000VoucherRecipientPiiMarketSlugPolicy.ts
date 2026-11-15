import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.16.0 Story 6.5 (FR-20, NFR-3, NFR-2, AD-49; DW-15-141; D-35 p.13 i p.16;
 * ADR-248 `Proposed`).
 *
 * Stempel `20261115140000` pochodzi z rejestru
 * `specs/releases/v1.16.0/migration-registry.yaml` (`story_id: "6.5"`).
 *
 * `voucher_recipient_pii.market_id` jest slugiem `text` (np. `bonbeauty`), tak jak
 * `voucher.market_id` i `entitlement_instance.market_id`. Poprzednia polityka
 * (Migration20260609090000) castowała obie strony na `uuid`, więc każdy odczyt
 * roli bez BYPASSRLS kończył się `invalid input syntax for type uuid` (DW-15-141).
 *
 * Forward:
 *  1. ENABLE + FORCE ROW LEVEL SECURITY (potwierdzenie — idempotentne).
 *  2. `rls_voucher_recipient_pii_market_isolation` porównuje `text` z `text`
 *     (bez castu), USING + WITH CHECK, bez żadnej gałęzi `OR true`.
 *  3. Rola runtime `medusa_store` (bez BYPASSRLS) dostaje DML na tabeli, żeby
 *     barierą była polityka RLS, a nie przypadkowy brak uprawnienia.
 *
 * Down przywraca poprzednią politykę z castem `::uuid`. Uprawnień `medusa_store`
 * down NIE odbiera (fix review 6.5, LOW [migracja]): w środowiskach po
 * `infra/postgres/migrations/003-rls-market-isolation.sql` (GRANT ON ALL TABLES +
 * DEFAULT PRIVILEGES) rola miała DML na tabeli PRZED `up()`, więc bezwarunkowy
 * REVOKE nie przywracałby stanu sprzed migracji, tylko psuł go. GRANT w `up()`
 * jest idempotentny, a pozostawienie go po rollbacku nie otwiera danych —
 * barierą jest RLS (ENABLE + FORCE), który down zostawia włączony.
 */
export const VOUCHER_RECIPIENT_PII_SLUG_POLICY_MIGRATION =
  "Migration20261115140000VoucherRecipientPiiMarketSlugPolicy" as const
export const VOUCHER_RECIPIENT_PII_TABLE = "voucher_recipient_pii" as const
export const VOUCHER_RECIPIENT_PII_POLICY = "rls_voucher_recipient_pii_market_isolation" as const
export const VOUCHER_RECIPIENT_PII_RUNTIME_ROLE = "medusa_store" as const

const MARKET_SETTING = "NULLIF(current_setting('app.gp_market_id', true), '')"

function grantRuntimeRole(): string {
  const sql = `GRANT SELECT, INSERT, UPDATE, DELETE ON ${VOUCHER_RECIPIENT_PII_TABLE} TO ${VOUCHER_RECIPIENT_PII_RUNTIME_ROLE}`
  return `
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${VOUCHER_RECIPIENT_PII_RUNTIME_ROLE}') THEN
          ${sql};
        END IF;
      END
      $$`
}

export class Migration20261115140000VoucherRecipientPiiMarketSlugPolicy extends Migration {
  async up(): Promise<void> {
    this.addSql(`ALTER TABLE ${VOUCHER_RECIPIENT_PII_TABLE} ENABLE ROW LEVEL SECURITY`)
    this.addSql(`ALTER TABLE ${VOUCHER_RECIPIENT_PII_TABLE} FORCE ROW LEVEL SECURITY`)
    this.addSql(`DROP POLICY IF EXISTS ${VOUCHER_RECIPIENT_PII_POLICY} ON ${VOUCHER_RECIPIENT_PII_TABLE}`)
    this.addSql(`
      CREATE POLICY ${VOUCHER_RECIPIENT_PII_POLICY}
        ON ${VOUCHER_RECIPIENT_PII_TABLE}
        USING (market_id = ${MARKET_SETTING})
        WITH CHECK (market_id = ${MARKET_SETTING})
    `)
    this.addSql(grantRuntimeRole())
  }

  async down(): Promise<void> {
    // Bez REVOKE: up() nie był jedynym źródłem tego uprawnienia (patrz nagłówek).
    this.addSql(`DROP POLICY IF EXISTS ${VOUCHER_RECIPIENT_PII_POLICY} ON ${VOUCHER_RECIPIENT_PII_TABLE}`)
    this.addSql(`
      CREATE POLICY ${VOUCHER_RECIPIENT_PII_POLICY}
        ON ${VOUCHER_RECIPIENT_PII_TABLE}
        USING (market_id::uuid = ${MARKET_SETTING}::uuid)
        WITH CHECK (market_id::uuid = ${MARKET_SETTING}::uuid)
    `)
  }
}
