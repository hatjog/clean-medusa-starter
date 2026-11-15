import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * v1.16.0 Story 11.6 (FR-20, AD-49, NFR-3; DW-15-360 p.(1) i `scope_extension_6_5`;
 * D-35 p.15 i p.16). Stempel `20261115160000` z rejestru
 * `specs/releases/v1.16.0/migration-registry.yaml` (`story_id: "11.6"`).
 *
 * Wzorzec: `Migration20261115140000VoucherRecipientPiiMarketSlugPolicy` (6.5).
 *
 * Forward:
 *  1. Tabele towarzyszące danych obdarowanego `voucher_pii_consent_audit`
 *     i `voucher_delivery_decision`: ENABLE + FORCE RLS, jedna polityka
 *     `market_id = NULLIF(current_setting('app.gp_market_id', true), '')`
 *     (USING + WITH CHECK, slug `text`, bez castu i bez `OR`).
 *  2. GRANT dla roli runtime `medusa_store` (bez BYPASSRLS) zgodny z kontraktem
 *     append-only tabel: audyt SELECT, INSERT (UPDATE/DELETE i tak blokuje
 *     trigger D-67); decyzja dostawy SELECT, INSERT, UPDATE (DELETE blokuje
 *     trigger D-72). Bez tego `cleanupOrphans` (NOT EXISTS do audytu) pod rolą
 *     runtime kończył się `permission denied` (DW-15-360 scope_extension_6_5).
 *  3. Kolumnowe GRANT dla `medusa_store` na nośnikach core Medusy objętych
 *     redakcją retencji (DW-15-040, DW-15-049): `order_line_item (id,
 *     created_at, metadata)` SELECT + UPDATE(metadata), `notification (id,
 *     created_at, data)` SELECT + UPDATE(data). Addytywne i wąskie — w
 *     środowiskach po `infra/postgres/migrations/003-rls-market-isolation.sql`
 *     rola i tak ma DML tabelowe. Izolację rynku na tych dwóch tabelach daje
 *     PREDYKAT redakcji (rynek z `entitlement_instance` pod RLS albo
 *     `notification.data.market_id`), nie polityka — core nie ma kolumny rynku.
 *     Fix R-2 (runda 1): `cart_line_item (id, cart_id, updated_at, metadata)`
 *     SELECT + UPDATE(metadata), `cart (id, sales_channel_id)` SELECT,
 *     `sales_channel (id, metadata)` SELECT — redakcja danych obdarowanej na
 *     pozycjach koszyka (rynek z `sales_channel.metadata.gp_market_id`).
 *
 * Down: zdejmuje polityki i RLS z tabel towarzyszących (stan sprzed up());
 * uprawnień NIE odbiera — ta sama racja co w 6.5 (grant mógł istnieć przed up(),
 * bezwarunkowy REVOKE psułby stan środowisk po 003).
 */
export const VOUCHER_PII_COMPANION_RLS_MIGRATION =
  "Migration20261115160000VoucherPiiCompanionTablesRls" as const
export const VOUCHER_PII_COMPANION_RUNTIME_ROLE = "medusa_store" as const

export const VOUCHER_PII_COMPANION_TABLES = [
  {
    table: "voucher_pii_consent_audit",
    policy: "rls_voucher_pii_consent_audit_market_isolation",
    privileges: "SELECT, INSERT",
  },
  {
    table: "voucher_delivery_decision",
    policy: "rls_voucher_delivery_decision_market_isolation",
    privileges: "SELECT, INSERT, UPDATE",
  },
] as const

export const VOUCHER_PII_REDACTION_COLUMN_GRANTS = [
  { table: "order_line_item", sql: "GRANT SELECT (id, created_at, metadata), UPDATE (metadata) ON order_line_item" },
  { table: "notification", sql: "GRANT SELECT (id, created_at, data), UPDATE (data) ON notification" },
  // Fix R-2: redakcja `cart_line_item.metadata`; rynek koszyka przez
  // `cart.sales_channel_id` → `sales_channel.metadata.gp_market_id`.
  { table: "cart_line_item", sql: "GRANT SELECT (id, cart_id, updated_at, metadata), UPDATE (metadata) ON cart_line_item" },
  { table: "cart", sql: "GRANT SELECT (id, sales_channel_id) ON cart" },
  { table: "sales_channel", sql: "GRANT SELECT (id, metadata) ON sales_channel" },
] as const

const MARKET_SETTING = "NULLIF(current_setting('app.gp_market_id', true), '')"
const ROLE = VOUCHER_PII_COMPANION_RUNTIME_ROLE

function guardedGrant(table: string, statement: string): string {
  return `
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}')
           AND to_regclass('public.${table}') IS NOT NULL THEN
          ${statement} TO ${ROLE};
        END IF;
      END
      $$`
}

export class Migration20261115160000VoucherPiiCompanionTablesRls extends Migration {
  async up(): Promise<void> {
    for (const t of VOUCHER_PII_COMPANION_TABLES) {
      this.addSql(`ALTER TABLE ${t.table} ENABLE ROW LEVEL SECURITY`)
      this.addSql(`ALTER TABLE ${t.table} FORCE ROW LEVEL SECURITY`)
      this.addSql(`DROP POLICY IF EXISTS ${t.policy} ON ${t.table}`)
      this.addSql(`
      CREATE POLICY ${t.policy}
        ON ${t.table}
        USING (market_id = ${MARKET_SETTING})
        WITH CHECK (market_id = ${MARKET_SETTING})
    `)
      this.addSql(guardedGrant(t.table, `GRANT ${t.privileges} ON ${t.table}`))
    }
    for (const g of VOUCHER_PII_REDACTION_COLUMN_GRANTS) {
      this.addSql(guardedGrant(g.table, g.sql))
    }
  }

  async down(): Promise<void> {
    // Bez REVOKE: up() nie był jedynym źródłem uprawnień (patrz nagłówek).
    for (const t of VOUCHER_PII_COMPANION_TABLES) {
      this.addSql(`DROP POLICY IF EXISTS ${t.policy} ON ${t.table}`)
      this.addSql(`ALTER TABLE ${t.table} NO FORCE ROW LEVEL SECURITY`)
      this.addSql(`ALTER TABLE ${t.table} DISABLE ROW LEVEL SECURITY`)
    }
  }
}
