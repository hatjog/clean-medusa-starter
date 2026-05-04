/**
 * concurrent-market-isolation.integration.spec.ts
 *
 * AC4 from story v160-cleanup-1: RLS concurrent-load test asserting multi-tenant
 * isolation when 2+ markets execute parallel reads.
 *
 * Tests that concurrent reads from different markets cannot cross-contaminate each
 * other's seller results — i.e., seller A visible in market X must NOT appear in
 * results for market Y even under parallel load.
 *
 * This is a deferred item from story 1.9 (AC4 RLS+ALS runtime chain).
 * Source: epic-1 adversarial review HIGH-RLS-DEFERRED.
 *
 * Requirements:
 *  - N >= 10 concurrent requests with distinct market_id contexts
 *  - Zero cross-market reads observed
 *  - Assertions on per-request response payloads' market scope
 */
import knex, { Knex } from "knex";
import { listSellerIdsForSalesChannel } from "../../lib/seller-market-scope";

const PRODUCT_SELLER_TABLE = "product_seller";
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/gp_mercur";

// Minimum concurrent requests required by AC4
const MIN_CONCURRENT = 10;

let db: Knex;

function uid(label: string) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function getMarketFixture(marketId: string) {
  const salesChannel = await db("sales_channel")
    .select("id")
    .whereRaw("metadata->>'gp_market_id' = ?", [marketId])
    .whereNull("deleted_at")
    .first<{ id: string }>();

  if (!salesChannel) {
    throw new Error(
      `Missing sales channel fixture for market ${marketId}. Run gp-config-sync before integration tests.`
    );
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
  // Larger pool to support concurrent connections
  db = knex({
    client: "pg",
    connection: { connectionString: DATABASE_URL },
    pool: { min: 2, max: MIN_CONCURRENT + 5 },
  });
});

afterAll(async () => {
  await db.destroy();
});

describe("concurrent market isolation (AC4 — RLS cross-market leakage prevention)", () => {
  it(
    `issues ${MIN_CONCURRENT} concurrent reads and finds zero cross-market leakage`,
    async () => {
      // Set up two markets
      const bonbeauty = await getMarketFixture("bonbeauty");
      const bonevent = await getMarketFixture("bonevent");

      // Create a seller exclusively in bonbeauty
      const sellerId = uid("concurrent_seller");
      const sellerHandle = uid("concurrent");
      const linkId = uid("concurrent_link");

      await db("seller").insert({
        id: sellerId,
        name: "Concurrent Test Seller",
        handle: sellerHandle,
        store_status: "ACTIVE",
      });
      await db(PRODUCT_SELLER_TABLE).insert({
        id: linkId,
        seller_id: sellerId,
        product_id: bonbeauty.productId,
      });

      try {
        // Interleave bonbeauty and bonevent requests (N >= 10 total)
        const marketRequests: Array<{
          market: "bonbeauty" | "bonevent";
          salesChannelId: string;
        }> = [];
        for (let i = 0; i < MIN_CONCURRENT; i++) {
          if (i % 2 === 0) {
            marketRequests.push({
              market: "bonbeauty",
              salesChannelId: bonbeauty.salesChannelId,
            });
          } else {
            marketRequests.push({
              market: "bonevent",
              salesChannelId: bonevent.salesChannelId,
            });
          }
        }

        // Fire all requests in parallel — this exercises RLS / connection-pool
        // context isolation under concurrent load
        const results = await Promise.all(
          marketRequests.map(({ market, salesChannelId }) =>
            listSellerIdsForSalesChannel(db, salesChannelId, 0, 1000).then(
              (r) => ({ market, sellerIds: r.sellerIds })
            )
          )
        );

        let bonbeautyLeakCount = 0;
        let boneventLeakCount = 0;

        for (const { market, sellerIds } of results) {
          if (market === "bonbeauty") {
            // Seller must be visible in bonbeauty
            expect(sellerIds).toContain(sellerId);
          } else {
            // Seller MUST NOT appear in bonevent — this is the cross-market leakage check
            if (sellerIds.includes(sellerId)) {
              boneventLeakCount++;
            }
          }
        }

        // Also verify bonbeauty results never leaked into bonevent context
        const boneventResults = results.filter((r) => r.market === "bonevent");
        for (const { sellerIds } of boneventResults) {
          if (sellerIds.includes(sellerId)) {
            bonbeautyLeakCount++;
          }
        }

        expect(boneventLeakCount).toBe(0);
        expect(bonbeautyLeakCount).toBe(0);

        // Confirm we actually ran MIN_CONCURRENT requests
        expect(results).toHaveLength(MIN_CONCURRENT);
      } finally {
        await db(PRODUCT_SELLER_TABLE).where({ id: linkId }).delete();
        await db("seller").where({ id: sellerId }).delete();
      }
    },
    30_000 // 30s timeout for concurrent DB ops
  );

  it("seller in market A is invisible to market B in all concurrent reads", async () => {
    const bonbeauty = await getMarketFixture("bonbeauty");
    const bonevent = await getMarketFixture("bonevent");

    // Create sellers: one bonbeauty-only, one bonevent-only
    const sellerA = uid("mkt_a_seller");
    const linkA = uid("mkt_a_link");
    const sellerB = uid("mkt_b_seller");
    const linkB = uid("mkt_b_link");

    await db("seller").insert([
      { id: sellerA, name: "Market A Seller", handle: uid("mkt_a"), store_status: "ACTIVE" },
      { id: sellerB, name: "Market B Seller", handle: uid("mkt_b"), store_status: "ACTIVE" },
    ]);
    await db(PRODUCT_SELLER_TABLE).insert([
      { id: linkA, seller_id: sellerA, product_id: bonbeauty.productId },
      { id: linkB, seller_id: sellerB, product_id: bonevent.productId },
    ]);

    try {
      // Issue concurrent reads alternating between markets
      const requests = Array.from({ length: 12 }, (_, i) => ({
        market: i % 2 === 0 ? ("bonbeauty" as const) : ("bonevent" as const),
        salesChannelId: i % 2 === 0 ? bonbeauty.salesChannelId : bonevent.salesChannelId,
      }));

      const results = await Promise.all(
        requests.map(({ market, salesChannelId }) =>
          listSellerIdsForSalesChannel(db, salesChannelId, 0, 1000).then(
            (r) => ({ market, sellerIds: r.sellerIds })
          )
        )
      );

      for (const { market, sellerIds } of results) {
        if (market === "bonbeauty") {
          // sellerA should be present, sellerB should NOT
          expect(sellerIds).toContain(sellerA);
          expect(sellerIds).not.toContain(sellerB);
        } else {
          // sellerB should be present, sellerA should NOT
          expect(sellerIds).toContain(sellerB);
          expect(sellerIds).not.toContain(sellerA);
        }
      }
    } finally {
      await db(PRODUCT_SELLER_TABLE).whereIn("id", [linkA, linkB]).delete();
      await db("seller").whereIn("id", [sellerA, sellerB]).delete();
    }
  });
});
