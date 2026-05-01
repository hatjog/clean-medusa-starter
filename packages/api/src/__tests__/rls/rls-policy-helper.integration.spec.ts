import fs from "node:fs";
import path from "node:path";
import knex, { Knex } from "knex";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/gp_mercur";
const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../../../infra/postgres/migrations/007-rls-policy-helper-consolidation.sql"
);

let db: Knex;

function normalizePolicy(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function loadPolicy(tableName: string): Promise<{
  qual: string | null;
  with_check: string | null;
}> {
  const result = await db.raw(
    `
      SELECT qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = ?
        AND policyname = 'market_isolation'
      LIMIT 1
    `,
    [tableName]
  );

  return result.rows[0] ?? { qual: null, with_check: null };
}

beforeAll(async () => {
  db = knex({
    client: "pg",
    connection: { connectionString: DATABASE_URL },
    pool: { min: 1, max: 2 },
  });

  const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
  await db.raw(migrationSql);
});

afterAll(async () => {
  await db.destroy();
});

describe("RLS policy helper migration", () => {
  it("registers shared helper function gp_create_market_isolation_policy", async () => {
    const result = await db.raw(
      `
        SELECT proname
        FROM pg_proc
        WHERE proname = 'gp_create_market_isolation_policy'
        LIMIT 1
      `
    );

    expect(result.rows[0]?.proname).toBe("gp_create_market_isolation_policy");
  });

  it("recreates fail-closed policies for standard tables without NULL fallback", async () => {
    await db.raw(
      "SELECT gp_create_market_isolation_policy('product_category'::regclass)"
    );
    await db.raw(
      "SELECT gp_create_market_isolation_policy('customer'::regclass, true)"
    );

    const categoryPolicy = await loadPolicy("product_category");
    const customerPolicy = await loadPolicy("customer");

    expect(normalizePolicy(categoryPolicy.qual)).toContain("current_setting");
    expect(normalizePolicy(categoryPolicy.qual)).not.toContain("is null");
    expect(categoryPolicy.with_check).toBeNull();

    expect(normalizePolicy(customerPolicy.qual)).toContain("current_setting");
    expect(normalizePolicy(customerPolicy.qual)).not.toContain("is null");
    expect(normalizePolicy(customerPolicy.with_check)).toContain(
      "current_setting"
    );
  });

  it("supports global-row exception for promotion while keeping WITH CHECK", async () => {
    await db.raw(
      "SELECT gp_create_market_isolation_policy('promotion'::regclass, true, true)"
    );

    const promotionPolicy = await loadPolicy("promotion");

    expect(normalizePolicy(promotionPolicy.qual)).toContain("current_setting");
    expect(normalizePolicy(promotionPolicy.qual)).toContain("is null");
    expect(normalizePolicy(promotionPolicy.with_check)).toContain("is null");
  });
});