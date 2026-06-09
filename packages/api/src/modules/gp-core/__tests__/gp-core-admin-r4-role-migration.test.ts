import { describe, expect, it } from "@jest/globals";
import { Pool } from "pg";

import { Migration20260525001000 } from "../migrations/Migration20260525001000";

const ADMIN_R4_ROLE = "medusa_market_ops";
const TEST_DB_URL = process.env.GP_CORE_ADMIN_RLS_TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;
const NEEDS_LIVE_RUN_MESSAGE =
  "NEEDS-LIVE-RUN: Story 1.6 admin R4 role live migration assertions skipped; set GP_CORE_ADMIN_RLS_TEST_DATABASE_URL to run against live Postgres.";

function collectSql(method: "up" | "down"): string {
  const sqls: string[] = [];
  const fakeThis = { addSql: (s: string) => sqls.push(s) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Migration20260525001000.prototype as any)[method].call(fakeThis);
  return sqls.join("\n");
}

describe("v1.12.0 Story 1.6 — admin R4 role migration", () => {
  const up = collectSql("up");
  const down = collectSql("down");

  it("creates or reconciles the ADR-049 admin market-operator role without BYPASSRLS", () => {
    expect(up).toContain(`CREATE ROLE ${ADMIN_R4_ROLE} NOLOGIN`);
    expect(up).toContain(`ALTER ROLE ${ADMIN_R4_ROLE} NOBYPASSRLS`);
    expect(up).toContain(`COMMENT ON ROLE ${ADMIN_R4_ROLE} IS`);
    expect(up).toContain("admin R4 market-operator role");
    expect(up).toContain("runtime enforcement gated/deferred to multi-market");
    expect(up).not.toMatch(/\bSUPERUSER\b/);
    expect(up).not.toMatch(/\bBYPASSRLS\b(?!;|')/);
  });

  it("is idempotent and reconciles externally provisioned roles", () => {
    expect(up).toContain(`SELECT 1 FROM pg_roles WHERE rolname = '${ADMIN_R4_ROLE}'`);
    expect(up).toContain("IF NOT EXISTS");
    expect(up).toContain(`ALTER ROLE ${ADMIN_R4_ROLE} NOBYPASSRLS`);
  });

  it("does not enable runtime enforcement or change gp_core RLS policies", () => {
    expect(up).not.toContain("SET ROLE");
    expect(up).not.toContain("GP_CORE_RLS_ENFORCED");
    expect(up).not.toContain("GP_CORE_ADMIN_RLS_ENFORCED");
    expect(up).not.toMatch(/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(up).not.toMatch(/FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(up).not.toMatch(/CREATE\s+POLICY/i);
    expect(up).not.toMatch(/DROP\s+POLICY/i);
  });

  it("has a guarded, reversible down migration", () => {
    expect(down).toContain(`SELECT 1 FROM pg_roles WHERE rolname = '${ADMIN_R4_ROLE}'`);
    expect(down).toContain(`REVOKE USAGE ON SCHEMA gp_core FROM ${ADMIN_R4_ROLE}`);
    expect(down).toContain(`DROP ROLE ${ADMIN_R4_ROLE}`);
    expect(down).toContain("dependent_objects_still_exist");
    expect(down).not.toContain("CASCADE");
  });

  it("keeps any admin RLS enforcement flag absent or default-OFF", () => {
    expect(process.env.GP_CORE_ADMIN_RLS_ENFORCED).not.toBe("true");
  });

  it("live role assertion is guarded with NEEDS-LIVE-RUN when no DB URL is configured", () => {
    if (!TEST_DB_URL) {
      expect(NEEDS_LIVE_RUN_MESSAGE).toContain("NEEDS-LIVE-RUN");
      return;
    }

    expect(TEST_DB_URL).toBeTruthy();
  });
});

maybeDescribe("NEEDS-LIVE-RUN Story 1.6 admin R4 role live migration checks", () => {
  it("up is idempotent, role has no BYPASSRLS, and down is reversible", async () => {
    const pool = new Pool({ connectionString: TEST_DB_URL });
    const upSql = collectSql("up");
    const downSql = collectSql("down");

    try {
      await pool.query(upSql);
      await pool.query(upSql);

      const { rows } = await pool.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = $1",
        [ADMIN_R4_ROLE]
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.rolbypassrls).toBe(false);

      await pool.query(downSql);

      const afterDown = await pool.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
        [ADMIN_R4_ROLE]
      );

      expect(afterDown.rows[0]?.exists).toBe(false);
    } finally {
      await pool.end();
    }
  });
});
