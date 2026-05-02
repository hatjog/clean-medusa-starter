import knex, { Knex } from "knex";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/gp_mercur";

let db: Knex;

function buildCustomerId(label: string): string {
  return `cus_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function queryAsStore(
  marketId: string,
  customerId: string
): Promise<number> {
  const connection = await (db.client as any).acquireConnection();

  try {
    await connection.query("SET ROLE medusa_store");
    await connection.query(
      "SELECT set_config('app.gp_market_id', $1, false)",
      [marketId]
    );

    const result = await connection.query(
      "SELECT count(*)::int AS cnt FROM customer WHERE id = $1",
      [customerId]
    );

    return result.rows[0].cnt;
  } finally {
    await connection.query("RESET app.gp_market_id").catch(() => undefined);
    await connection.query("RESET ROLE").catch(() => undefined);
    await (db.client as any).releaseConnection(connection);
  }
}

beforeAll(() => {
  db = knex({
    client: "pg",
    connection: { connectionString: DATABASE_URL },
    pool: { min: 1, max: 2 },
  });
});

afterAll(async () => {
  await db.destroy();
});

describe("customer RLS", () => {
  it("shows a customer row when gp.market_id matches the current market", async () => {
    const customerId = buildCustomerId("match");

    try {
      await db("customer").insert({
        id: customerId,
        email: `${customerId}@gp-test.local`,
        has_account: true,
        metadata: { gp: { market_id: "bonbeauty" } },
      });

      await expect(queryAsStore("bonbeauty", customerId)).resolves.toBe(1);
    } finally {
      await db("customer").where({ id: customerId }).delete();
    }
  });

  it("hides a customer row when gp.market_id belongs to another market", async () => {
    const customerId = buildCustomerId("mismatch");

    try {
      await db("customer").insert({
        id: customerId,
        email: `${customerId}@gp-test.local`,
        has_account: true,
        metadata: { gp: { market_id: "bonevent" } },
      });

      await expect(queryAsStore("bonbeauty", customerId)).resolves.toBe(0);
    } finally {
      await db("customer").where({ id: customerId }).delete();
    }
  });
});