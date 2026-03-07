import fs from "node:fs";
import path from "node:path";
import knex, { Knex } from "knex";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/gp_mercur";
const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../../../infra/postgres/migrations/006-rls-promotion-market-isolation.sql"
);

let db: Knex;

function buildPromotionId(label: string): string {
  return `promo_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildPromotionCode(label: string): string {
  return `PROMO_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
}

async function queryPromotionCountAsStore(
  marketId: string,
  promotionId: string
): Promise<number> {
  const connection = await (db.client as any).acquireConnection();

  try {
    await connection.query("SET ROLE medusa_store");
    await connection.query(
      "SELECT set_config('app.gp_market_id', $1, false)",
      [marketId]
    );

    const result = await connection.query(
      "SELECT count(*)::int AS cnt FROM promotion WHERE id = $1",
      [promotionId]
    );

    return result.rows[0].cnt;
  } finally {
    await connection.query("RESET app.gp_market_id").catch(() => undefined);
    await connection.query("RESET ROLE").catch(() => undefined);
    await (db.client as any).releaseConnection(connection);
  }
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

describe("promotion RLS", () => {
  it("shows a promotion row when metadata.gp.market_id matches the current market", async () => {
    const promotionId = buildPromotionId("match");
    const promotionCode = buildPromotionCode("match");

    try {
      await db("promotion").insert({
        id: promotionId,
        code: promotionCode,
        type: "standard",
        status: "active",
        is_automatic: false,
        is_tax_inclusive: false,
        metadata: { gp: { market_id: "bonbeauty" } },
      });

      await expect(
        queryPromotionCountAsStore("bonbeauty", promotionId)
      ).resolves.toBe(1);
    } finally {
      await db("promotion").where({ id: promotionId }).delete();
    }
  });

  it("hides a promotion row when metadata.gp.market_id belongs to another market", async () => {
    const promotionId = buildPromotionId("mismatch");
    const promotionCode = buildPromotionCode("mismatch");

    try {
      await db("promotion").insert({
        id: promotionId,
        code: promotionCode,
        type: "standard",
        status: "active",
        is_automatic: false,
        is_tax_inclusive: false,
        metadata: { gp: { market_id: "bonevent" } },
      });

      await expect(
        queryPromotionCountAsStore("bonbeauty", promotionId)
      ).resolves.toBe(0);
    } finally {
      await db("promotion").where({ id: promotionId }).delete();
    }
  });

  it("shows a global promotion row in every market when metadata.gp.market_id is NULL", async () => {
    const promotionId = buildPromotionId("global");
    const promotionCode = buildPromotionCode("global");

    try {
      await db("promotion").insert({
        id: promotionId,
        code: promotionCode,
        type: "standard",
        status: "active",
        is_automatic: false,
        is_tax_inclusive: false,
        metadata: null,
      });

      await expect(
        queryPromotionCountAsStore("bonbeauty", promotionId)
      ).resolves.toBe(1);
      await expect(
        queryPromotionCountAsStore("bonevent", promotionId)
      ).resolves.toBe(1);
    } finally {
      await db("promotion").where({ id: promotionId }).delete();
    }
  });
});