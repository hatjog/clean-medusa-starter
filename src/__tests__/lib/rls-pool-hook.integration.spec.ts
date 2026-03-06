/**
 * Integration tests for RLS pool hook — Story 10-3
 *
 * Tests: SET on acquire within ALS, no SET without ALS, RESET on release.
 * Uses real knex connections against PostgreSQL.
 *
 * Requires: running PostgreSQL with DATABASE_URL env var and medusa_store role.
 */

import knex, { Knex } from "knex";
import {
  _resetRlsPoolHook,
  installRlsPoolHook,
} from "../../lib/rls-pool-hook";
import { marketContextStorage } from "../../lib/market-context";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/gp_mercur";

let db: Knex;

beforeAll(() => {
  _resetRlsPoolHook();
  db = knex({
    client: "pg",
    connection: { connectionString: DATABASE_URL },
    pool: { min: 1, max: 2 },
  });
  installRlsPoolHook(db);
});

afterAll(async () => {
  await db.destroy();
  _resetRlsPoolHook();
});

describe("RLS pool hook", () => {
  it("SET ROLE + SET var when ALS has market context", async () => {
    const ctx: MarketContext = {
      market_id: "bonbeauty",
      sales_channel_id: "sc_001",
    };

    await marketContextStorage.run(ctx, async () => {
      const roleResult = await db.raw("SELECT current_user");
      expect(roleResult.rows[0].current_user).toBe("medusa_store");

      const varResult = await db.raw(
        "SELECT current_setting('app.gp_market_id', true) AS market_id"
      );
      expect(varResult.rows[0].market_id).toBe("bonbeauty");
    });
  });

  it("no SET when ALS has no market context", async () => {
    // Outside ALS — no market context
    const roleResult = await db.raw("SELECT current_user");
    expect(roleResult.rows[0].current_user).toBe("postgres");

    const varResult = await db.raw(
      "SELECT current_setting('app.gp_market_id', true) AS market_id"
    );
    expect(varResult.rows[0].market_id === null || varResult.rows[0].market_id === "").toBe(true);
  });

  it("RESET on release — connection is clean after ALS exits", async () => {
    const ctx: MarketContext = {
      market_id: "bonevent",
      sales_channel_id: "sc_002",
    };

    // Run a query within market context to trigger SET
    await marketContextStorage.run(ctx, async () => {
      await db.raw("SELECT 1");
    });

    // After ALS context exits, next query on released connection should be clean
    const roleResult = await db.raw("SELECT current_user");
    expect(roleResult.rows[0].current_user).toBe("postgres");

    const varResult = await db.raw(
      "SELECT current_setting('app.gp_market_id', true) AS market_id"
    );
    expect(varResult.rows[0].market_id === null || varResult.rows[0].market_id === "").toBe(true);
  });

  it("RLS enforced — medusa_store sees only matching rows", async () => {
    const ctx: MarketContext = {
      market_id: "bonbeauty",
      sales_channel_id: "sc_001",
    };

    await marketContextStorage.run(ctx, async () => {
      const result = await db.raw(
        "SELECT count(*)::int AS cnt FROM product_category"
      );
      // With RLS active, should see only bonbeauty categories (not all 26)
      expect(result.rows[0].cnt).toBeGreaterThan(0);
      expect(result.rows[0].cnt).toBeLessThan(26);
    });
  });

  it("superuser bypasses RLS — sees all rows without ALS", async () => {
    const result = await db.raw(
      "SELECT count(*)::int AS cnt FROM product_category"
    );
    // Superuser (postgres) bypasses RLS — sees all categories
    expect(result.rows[0].cnt).toBeGreaterThanOrEqual(20);
  });

  it("medusa_store without market context sees 0 rows (fail-closed fallback)", async () => {
    const connection = await (db.client as any).acquireConnection();

    try {
      await connection.query("SET ROLE medusa_store");

      const result = await connection.query(
        "SELECT count(*)::int AS cnt FROM product_category"
      );

      expect(result.rows[0].cnt).toBe(0);
    } finally {
      await connection.query("RESET ROLE").catch(() => undefined);
      await (db.client as any).releaseConnection(connection);
    }
  });
});
