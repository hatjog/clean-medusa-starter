import { randomUUID } from "node:crypto";
import knex, { Knex } from "knex";
import { listReviewIdsForSalesChannel } from "../../lib/review-market-scope";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/gp_mercur";

let db: Knex;

function buildReviewId(): string {
  return randomUUID();
}

function buildLinkId(): string {
  return randomUUID();
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

describe("review market scoping", () => {
  it("lists a product review only in the sales channel where its product is assigned", async () => {
    const bonbeauty = await getMarketFixture("bonbeauty");
    const bonevent = await getMarketFixture("bonevent");
    const reviewId = buildReviewId();
    const linkId = buildLinkId();
    const now = new Date();

    try {
      await db("review").insert({
        id: reviewId,
        reference: "product",
        rating: 5,
        customer_note: "Scoped review",
        seller_note: null,
        created_at: now,
        updated_at: now,
      });
      await db("product_product_review_review").insert({
        id: linkId,
        product_id: bonbeauty.productId,
        review_id: reviewId,
        created_at: now,
        updated_at: now,
      });

      const ownMarket = await listReviewIdsForSalesChannel(
        db,
        bonbeauty.salesChannelId,
        0,
        100
      );
      const otherMarket = await listReviewIdsForSalesChannel(
        db,
        bonevent.salesChannelId,
        0,
        100
      );

      expect(ownMarket.reviewIds).toContain(reviewId);
      expect(otherMarket.reviewIds).not.toContain(reviewId);
    } finally {
      await db("product_product_review_review").where({ id: linkId }).delete();
      await db("review").where({ id: reviewId }).delete();
    }
  });

  it("ignores soft-deleted review links to stay fail-closed", async () => {
    const bonbeauty = await getMarketFixture("bonbeauty");
    const reviewId = buildReviewId();
    const linkId = buildLinkId();
    const now = new Date();

    try {
      await db("review").insert({
        id: reviewId,
        reference: "product",
        rating: 4,
        customer_note: "Deleted link review",
        seller_note: null,
        created_at: now,
        updated_at: now,
      });
      await db("product_product_review_review").insert({
        id: linkId,
        product_id: bonbeauty.productId,
        review_id: reviewId,
        created_at: now,
        updated_at: now,
        deleted_at: now,
      });

      const scoped = await listReviewIdsForSalesChannel(
        db,
        bonbeauty.salesChannelId,
        0,
        100
      );

      expect(scoped.reviewIds).not.toContain(reviewId);
    } finally {
      await db("product_product_review_review").where({ id: linkId }).delete();
      await db("review").where({ id: reviewId }).delete();
    }
  });
});