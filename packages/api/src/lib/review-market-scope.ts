import type { Knex } from "knex";

type ReviewRow = {
  id: string;
};

export type ReviewScopeFilters = {
  productId?: string;
  sellerId?: string;
};

function buildScopedReviewQuery(
  db: Knex,
  salesChannelId: string,
  filters: ReviewScopeFilters = {}
) {
  const query = db("review as review")
    .distinct("review.id", "review.created_at")
    .leftJoin("product_product_review_review as pprr", function () {
      this.on("review.id", "=", "pprr.review_id").andOnNull("pprr.deleted_at");
    })
    .leftJoin("product as product", function () {
      this.on("pprr.product_id", "=", "product.id").andOnNull("product.deleted_at");
    })
    .leftJoin("product_sales_channel as psc", function () {
      this.on("product.id", "=", "psc.product_id")
        .andOn("psc.sales_channel_id", "=", db.raw("?", [salesChannelId]))
        .andOnNull("psc.deleted_at");
    })
    .leftJoin("seller_seller_review_review as ssrr", function () {
      this.on("review.id", "=", "ssrr.review_id").andOnNull("ssrr.deleted_at");
    })
    .leftJoin("seller as seller", function () {
      this.on("ssrr.seller_id", "=", "seller.id").andOnNull("seller.deleted_at");
    })
    .leftJoin("sales_channel as sc", function () {
      this.on("sc.id", "=", db.raw("?", [salesChannelId])).andOnNull(
        "sc.deleted_at"
      );
    })
    .whereNull("review.deleted_at")
    .where(function () {
      this.where(function () {
        // Product-scoped reviews: always included when product is in this sales channel.
        this.where("review.reference", "product").whereNotNull("psc.product_id");
      });

      // Seller-scoped reviews are only included when an explicit sellerId filter is
      // provided. Without it the query would silently widen the default set (e.g.
      // the user "written reviews" page at /user/reviews/written) to include seller
      // reviews it was never designed to handle. Callers that need seller reviews MUST
      // supply filters.sellerId (or filters.productId) — see route.ts GET handler.
      //
      // NOTE (M4 / scope): seller reviews are matched by metadata string
      // (seller.metadata->'gp'->>'market_id' = sc.metadata->>'gp_market_id').
      // This depends on the runtime sales_channel having `gp_market_id` set in
      // metadata (populated by seed-products / gp-config-sync-catalog). If that
      // metadata is absent the seller branch silently returns an empty set, which is
      // fail-closed but may be surprising. A future story should unify this to a
      // direct sales_channel_id lookup (see upstream gp-config-sync-reviews.ts note L2).
      if (filters.sellerId) {
        this.orWhere(function () {
          this.where("review.reference", "seller")
            .whereNotNull("ssrr.seller_id")
            .whereRaw(
              "seller.metadata->'gp'->>'market_id' = sc.metadata->>'gp_market_id'"
            );
        });
      }
    });

  if (filters.productId) {
    query.where("pprr.product_id", filters.productId);
  }

  if (filters.sellerId) {
    query.where("ssrr.seller_id", filters.sellerId);
  }

  return query;
}

export async function listReviewIdsForSalesChannel(
  db: Knex,
  salesChannelId: string,
  offset: number,
  limit: number,
  filters: ReviewScopeFilters = {}
): Promise<{ reviewIds: string[]; count: number }> {
  const baseQuery = buildScopedReviewQuery(db, salesChannelId, filters);

  const countResult = await db
    .from(baseQuery.clone().as("scoped_reviews"))
    .count<{ count: string }>({ count: "*" })
    .first();

  const rows = await baseQuery
    .clone()
    .orderBy("review.created_at", "desc")
    .orderBy("review.id", "asc")
    .offset(offset)
    .limit(limit);

  return {
    reviewIds: (rows as ReviewRow[]).map((row) => row.id),
    count: Number(countResult?.count ?? 0),
  };
}

export async function getLiveReviewStatsForSalesChannel(
  db: Knex,
  salesChannelId: string,
  filters: ReviewScopeFilters = {}
): Promise<{ averageRating: number; count: number }> {
  // Build a DISTINCT subquery for review IDs to avoid fan-out duplicates from
  // multiple junction joins (product_product_review_review / seller_seller_review_review).
  // clearSelect() in Knex strips the distinct flag together with the column list,
  // so we reconstruct with an explicit raw DISTINCT to guarantee deduplication
  // before AVG/COUNT — preventing inflated stats when a review links to >1 target.
  const scopedIds = buildScopedReviewQuery(db, salesChannelId, filters)
    .clone()
    .clearSelect()
    .select(db.raw("DISTINCT review.id"))
    .as("scoped_reviews");

  const row = await db
    .from(scopedIds)
    .innerJoin("review as r", "scoped_reviews.id", "r.id")
    .select<{ average_rating: string | null; count: string }[]>(
      db.raw("COALESCE(AVG(r.rating), 0) as average_rating"),
      db.raw("COUNT(*) as count")
    )
    .first();

  return {
    averageRating: Number(row?.average_rating ?? 0),
    count: Number(row?.count ?? 0),
  };
}
