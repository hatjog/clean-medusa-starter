import { describe, expect, it } from "@jest/globals";

import { GP_MARKET_SESSION_VAR } from "../../../lib/rls-pool-hook";
import { Migration20260525000000 } from "../migrations/Migration20260525000000";

const RLS_TABLES = [
  "entitlements",
  "redemptions",
  "entitlement_audit_log",
] as const;

function collectSql(method: "up" | "down"): string {
  const sqls: string[] = [];
  const fakeThis = { addSql: (s: string) => sqls.push(s) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Migration20260525000000.prototype as any)[method].call(fakeThis);
  return sqls.join("\n");
}

describe("v1.12.0 Story 1.3 — gp_core RLS enforcement migration", () => {
  const up = collectSql("up");

  it("creates or reconciles gp_core_runtime without BYPASSRLS", () => {
    expect(up).toContain("CREATE ROLE gp_core_runtime NOLOGIN");
    expect(up).toContain("ALTER ROLE gp_core_runtime NOBYPASSRLS");
    expect(up).not.toMatch(/\bSUPERUSER\b/);
    expect(up).not.toMatch(/\bBYPASSRLS\b(?!;|\')/);
    expect(up).toContain("GRANT USAGE ON SCHEMA gp_core TO gp_core_runtime");
    expect(up).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON gp_core.entitlements TO gp_core_runtime"
    );
  });

  it("enables and forces RLS on all protected gp_core tables", () => {
    for (const table of RLS_TABLES) {
      expect(up).toContain(`ALTER TABLE gp_core.${table} ENABLE ROW LEVEL SECURITY`);
      expect(up).toContain(`ALTER TABLE gp_core.${table} FORCE ROW LEVEL SECURITY`);
    }
  });

  it("creates market_isolation policies with USING and WITH CHECK on all protected tables", () => {
    for (const table of RLS_TABLES) {
      expect(up).toContain(`DROP POLICY IF EXISTS market_isolation ON gp_core.${table}`);
      expect(up).toContain(`CREATE POLICY market_isolation ON gp_core.${table}`);
      expect(up).toContain(
        `USING (market_id = NULLIF(current_setting('${GP_MARKET_SESSION_VAR}', true), '')::uuid)`
      );
      expect(up).toContain(
        `WITH CHECK (market_id = NULLIF(current_setting('${GP_MARKET_SESSION_VAR}', true), '')::uuid)`
      );
    }
  });

  it("keeps missing or empty GUC fail-closed without a fallback visibility branch", () => {
    expect(up).toContain("NULLIF(current_setting('app.gp_market_id', true), '')::uuid");
    expect(up).not.toMatch(/\bOR\s+market_id\s+IS\s+NULL\b/i);
    expect(up).not.toMatch(/\bOR\s+current_setting\('app\.gp_market_id',\s*true\)\s*=\s*''/i);
  });

  it("documents the no-GUC and cross-market semantics in the generated predicate", () => {
    const predicate =
      "market_id = NULLIF(current_setting('app.gp_market_id', true), '')::uuid";

    expect(predicate).toContain("NULLIF");
    expect(predicate).not.toContain(" OR ");
    // SQL three-valued logic: missing/empty GUC casts to NULL, so equality is
    // UNKNOWN and filters out every row; a different market UUID is false.
    expect(up.match(new RegExp(predicate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(6);
  });

  it("has a guarded, non-data down migration for RLS and the runtime role", () => {
    const down = collectSql("down");

    for (const table of RLS_TABLES) {
      expect(down).toContain(`DROP POLICY IF EXISTS market_isolation ON gp_core.${table}`);
      expect(down).toContain(`ALTER TABLE gp_core.${table} NO FORCE ROW LEVEL SECURITY`);
      expect(down).toContain(`ALTER TABLE gp_core.${table} DISABLE ROW LEVEL SECURITY`);
      expect(down).toContain(`to_regclass('gp_core.${table}') IS NOT NULL`);
    }

    expect(down).toContain("DROP ROLE gp_core_runtime");
    expect(down).toContain("dependent_objects_still_exist");
  });
});
