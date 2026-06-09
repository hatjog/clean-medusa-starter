import { describe, expect, it } from "@jest/globals";

import { Migration20260524133525 } from "../migrations/Migration20260524133525";

function collectSql(method: "up" | "down"): string {
  const sqls: string[] = [];
  const fakeThis = { addSql: (s: string) => sqls.push(s) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Migration20260524133525.prototype as any)[method].call(fakeThis);
  return sqls.join("\n");
}

describe("v1.12.0 Story 1.1 — gp_core market_id denormalization migration", () => {
  const up = collectSql("up");

  it("adds market_id nullable first, before backfill and NOT NULL", () => {
    // L2: ADD COLUMN is now guarded per-column via information_schema (no IF NOT EXISTS suffix)
    const addRedemptions = up.indexOf("ALTER TABLE gp_core.redemptions ADD COLUMN market_id uuid");
    const addAudit = up.indexOf("ALTER TABLE gp_core.entitlement_audit_log ADD COLUMN market_id uuid");
    const backfillRedemptions = up.indexOf("UPDATE gp_core.redemptions r");
    const backfillAudit = up.indexOf("UPDATE gp_core.entitlement_audit_log a");
    const notNullRedemptions = up.indexOf("ALTER TABLE gp_core.redemptions ALTER COLUMN market_id SET NOT NULL");
    const notNullAudit = up.indexOf("ALTER TABLE gp_core.entitlement_audit_log ALTER COLUMN market_id SET NOT NULL");

    expect(addRedemptions).toBeGreaterThanOrEqual(0);
    expect(addAudit).toBeGreaterThanOrEqual(0);
    expect(addRedemptions).toBeLessThan(backfillRedemptions);
    expect(addAudit).toBeLessThan(backfillAudit);
    expect(backfillRedemptions).toBeLessThan(notNullRedemptions);
    expect(backfillAudit).toBeLessThan(notNullAudit);
  });

  it("guards base-table dependent DDL with to_regclass for re-runnable module migration", () => {
    expect(up).toMatch(/CREATE SCHEMA IF NOT EXISTS gp_core/);
    expect(up).toMatch(/to_regclass\('gp_core\.redemptions'\) IS NOT NULL/);
    expect(up).toMatch(/to_regclass\('gp_core\.entitlement_audit_log'\) IS NOT NULL/);
    expect(up).toMatch(/to_regclass\('gp_core\.entitlements'\) IS NOT NULL/);
    // L1 fix: FK target gp_core.markets must also be guarded
    expect(up).toMatch(/to_regclass\('gp_core\.markets'\) IS NOT NULL/);
  });

  it("uses per-column information_schema guard for idempotency (L2 fix)", () => {
    // Column-level guard: skip ADD COLUMN only when the specific column exists,
    // not when any table in the block exists.
    expect(up).toMatch(/information_schema\.columns[\s\S]*table_schema\s*=\s*'gp_core'[\s\S]*table_name\s*=\s*'redemptions'[\s\S]*column_name\s*=\s*'market_id'/);
    expect(up).toMatch(/information_schema\.columns[\s\S]*table_schema\s*=\s*'gp_core'[\s\S]*table_name\s*=\s*'entitlement_audit_log'[\s\S]*column_name\s*=\s*'market_id'/);
  });

  it("backfills both tables from entitlements.market_id by entitlement_id and is re-runnable", () => {
    expect(up).toMatch(
      /UPDATE gp_core\.redemptions r[\s\S]*SET market_id = e\.market_id[\s\S]*FROM gp_core\.entitlements e[\s\S]*WHERE r\.entitlement_id = e\.entitlement_id[\s\S]*AND r\.market_id IS NULL/
    );
    expect(up).toMatch(
      /UPDATE gp_core\.entitlement_audit_log a[\s\S]*SET market_id = e\.market_id[\s\S]*FROM gp_core\.entitlements e[\s\S]*WHERE a\.entitlement_id = e\.entitlement_id[\s\S]*AND a\.market_id IS NULL/
    );
    // ADD COLUMN is guarded per-column via information_schema (no IF NOT EXISTS suffix on ADD COLUMN)
    expect(up).toMatch(/ADD COLUMN market_id uuid/);
    expect(up).toMatch(/CREATE INDEX IF NOT EXISTS idx_redemptions_market_id/);
    expect(up).toMatch(/CREATE INDEX IF NOT EXISTS idx_entitlement_audit_log_market_id/);
  });

  it("keeps entitlements.market_id intact and does not enable RLS/session vars", () => {
    expect(up).not.toMatch(/ALTER TABLE gp_core\.entitlements[\s\S]*market_id/i);
    expect(up).not.toMatch(/ROW LEVEL SECURITY/i);
    expect(up).not.toMatch(/\bSET\s+LOCAL\b/i);
    expect(up).not.toMatch(/app\.(gp_)?market_id/i);
  });

  it("adds market_id indexes and FK constraints to gp_core.markets", () => {
    expect(up).toMatch(/idx_redemptions_market_id[\s\S]*ON gp_core\.redemptions \(market_id\)/);
    expect(up).toMatch(/idx_entitlement_audit_log_market_id[\s\S]*ON gp_core\.entitlement_audit_log \(market_id\)/);
    expect(up).toMatch(/fk_redemptions_market_id[\s\S]*FOREIGN KEY \(market_id\) REFERENCES gp_core\.markets\(id\)/);
    expect(up).toMatch(/fk_entitlement_audit_log_market_id[\s\S]*FOREIGN KEY \(market_id\) REFERENCES gp_core\.markets\(id\)/);
  });

  it("uses symmetric guarded down migration consistent with gp-core column migrations", () => {
    const down = collectSql("down");
    expect(down).toMatch(/DROP CONSTRAINT IF EXISTS fk_entitlement_audit_log_market_id/);
    expect(down).toMatch(/DROP CONSTRAINT IF EXISTS fk_redemptions_market_id/);
    expect(down).toMatch(/DROP INDEX IF EXISTS gp_core\.idx_entitlement_audit_log_market_id/);
    expect(down).toMatch(/DROP INDEX IF EXISTS gp_core\.idx_redemptions_market_id/);
    expect(down).toMatch(/ALTER TABLE gp_core\.entitlement_audit_log DROP COLUMN IF EXISTS market_id/);
    expect(down).toMatch(/ALTER TABLE gp_core\.redemptions DROP COLUMN IF EXISTS market_id/);
    // L3 fix: down() must also guard with to_regclass so it is safe when tables don't exist
    expect(down).toMatch(/to_regclass\('gp_core\.entitlement_audit_log'\) IS NOT NULL/);
    expect(down).toMatch(/to_regclass\('gp_core\.redemptions'\) IS NOT NULL/);
  });
});
