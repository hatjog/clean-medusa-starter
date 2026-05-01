import knex, { Knex } from "knex";
import {
  filterProductIdsForSalesChannel,
  searchProductIdsForSalesChannel,
} from "../../lib/product-market-scope";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/gp_mercur";

let db: Knex;

async function getMarketFixture(marketId: string) {
  const product = await db("product as product")
    .select("product.id", "product.handle")
    .innerJoin("product_sales_channel as psc", "product.id", "psc.product_id")
    .innerJoin("sales_channel as sc", "psc.sales_channel_id", "sc.id")
    .whereRaw("sc.metadata->>'gp_market_id' = ?", [marketId])
    .where("product.status", "published")
    .whereNull("product.deleted_at")
    .whereNull("psc.deleted_at")
    .whereNull("sc.deleted_at")
    .first<{ id: string; handle: string }>();

  if (!product?.id || !product.handle) {
    throw new Error(`Missing published product fixture for market ${marketId}`);
  }

  const salesChannel = await db("sales_channel")
    .select("id")
    .whereRaw("metadata->>'gp_market_id' = ?", [marketId])
    .whereNull("deleted_at")
    .first<{ id: string }>();

  if (!salesChannel?.id) {
    throw new Error(`Missing sales channel fixture for market ${marketId}`);
  }

  return {
    salesChannelId: salesChannel.id,
    productId: product.id,
    handle: product.handle,
  };
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

describe("search market scoping", () => {
  it("filters mixed product ids down to the current sales channel", async () => {
    const bonbeauty = await getMarketFixture("bonbeauty");
    const bonevent = await getMarketFixture("bonevent");

    const filteredIds = await filterProductIdsForSalesChannel(
      db,
      bonbeauty.salesChannelId,
      [bonbeauty.productId, bonevent.productId]
    );

    expect(filteredIds).toContain(bonbeauty.productId);
    expect(filteredIds).not.toContain(bonevent.productId);
  });

  it("searches by handle only within the current sales channel", async () => {
    const bonbeauty = await getMarketFixture("bonbeauty");
    const bonevent = await getMarketFixture("bonevent");

    const ownMarket = await searchProductIdsForSalesChannel(
      db,
      bonbeauty.salesChannelId,
      {
        query: bonbeauty.handle,
        offset: 0,
        limit: 20,
      }
    );
    const otherMarket = await searchProductIdsForSalesChannel(
      db,
      bonevent.salesChannelId,
      {
        query: bonbeauty.handle,
        offset: 0,
        limit: 20,
      }
    );

    expect(ownMarket.productIds).toContain(bonbeauty.productId);
    expect(otherMarket.productIds).not.toContain(bonbeauty.productId);
  });
});