import knex, { Knex } from "knex";
import {
  getSellerIdByHandleForSalesChannel,
  listSellerIdsForSalesChannel,
} from "../../lib/seller-market-scope";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/gp_mercur";

let db: Knex;

function buildSellerId(label: string): string {
  return `seller_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildLinkId(label: string): string {
  return `link_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function getMarketFixture(marketId: string) {
  const salesChannel = await db("sales_channel")
    .select("id")
    .whereRaw("metadata->>'gp_market_id' = ?", [marketId])
    .whereNull("deleted_at")
    .first<{ id: string }>();

  if (!salesChannel) {
    throw new Error(`Missing sales channel fixture for market ${marketId}`);
  }

  const productLink = await db("product_sales_channel")
    .select("product_id")
    .where({ sales_channel_id: salesChannel.id })
    .whereNull("deleted_at")
    .first<{ product_id: string }>();

  if (!productLink) {
    throw new Error(`Missing product fixture for market ${marketId}`);
  }

  return {
    salesChannelId: salesChannel.id,
    productId: productLink.product_id,
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

describe("seller market scoping", () => {
  it("lists a seller in its own sales channel only", async () => {
    const bonbeauty = await getMarketFixture("bonbeauty");
    const bonevent = await getMarketFixture("bonevent");
    const sellerId = buildSellerId("bonbeauty");
    const sellerHandle = `seller-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const linkId = buildLinkId("bonbeauty");

    try {
      await db("seller").insert({
        id: sellerId,
        name: "Scoped Seller",
        handle: sellerHandle,
        store_status: "ACTIVE",
      });
      await db("seller_seller_product_product").insert({
        id: linkId,
        seller_id: sellerId,
        product_id: bonbeauty.productId,
      });

      const ownMarket = await listSellerIdsForSalesChannel(
        db,
        bonbeauty.salesChannelId,
        0,
        100
      );
      const otherMarket = await listSellerIdsForSalesChannel(
        db,
        bonevent.salesChannelId,
        0,
        100
      );

      expect(ownMarket.sellerIds).toContain(sellerId);
      expect(otherMarket.sellerIds).not.toContain(sellerId);
    } finally {
      await db("seller_seller_product_product").where({ id: linkId }).delete();
      await db("seller").where({ id: sellerId }).delete();
    }
  });

  it("resolves a seller handle only in the sales channel where the seller has products", async () => {
    const bonbeauty = await getMarketFixture("bonbeauty");
    const bonevent = await getMarketFixture("bonevent");
    const sellerId = buildSellerId("handle");
    const sellerHandle = `seller-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const linkId = buildLinkId("handle");

    try {
      await db("seller").insert({
        id: sellerId,
        name: "Scoped Handle Seller",
        handle: sellerHandle,
        store_status: "ACTIVE",
      });
      await db("seller_seller_product_product").insert({
        id: linkId,
        seller_id: sellerId,
        product_id: bonbeauty.productId,
      });

      await expect(
        getSellerIdByHandleForSalesChannel(
          db,
          bonbeauty.salesChannelId,
          sellerHandle
        )
      ).resolves.toBe(sellerId);
      await expect(
        getSellerIdByHandleForSalesChannel(
          db,
          bonevent.salesChannelId,
          sellerHandle
        )
      ).resolves.toBeNull();
    } finally {
      await db("seller_seller_product_product").where({ id: linkId }).delete();
      await db("seller").where({ id: sellerId }).delete();
    }
  });

  it("does not list or resolve inactive sellers even when they are linked to the market", async () => {
    const bonbeauty = await getMarketFixture("bonbeauty");
    const sellerId = buildSellerId("inactive");
    const sellerHandle = `inactive-seller-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const linkId = buildLinkId("inactive");

    try {
      await db("seller").insert({
        id: sellerId,
        name: "Inactive Scoped Seller",
        handle: sellerHandle,
        store_status: "INACTIVE",
      });
      await db("seller_seller_product_product").insert({
        id: linkId,
        seller_id: sellerId,
        product_id: bonbeauty.productId,
      });

      const ownMarket = await listSellerIdsForSalesChannel(
        db,
        bonbeauty.salesChannelId,
        0,
        100
      );

      expect(ownMarket.sellerIds).not.toContain(sellerId);
      await expect(
        getSellerIdByHandleForSalesChannel(
          db,
          bonbeauty.salesChannelId,
          sellerHandle
        )
      ).resolves.toBeNull();
    } finally {
      await db("seller_seller_product_product").where({ id: linkId }).delete();
      await db("seller").where({ id: sellerId }).delete();
    }
  });
});