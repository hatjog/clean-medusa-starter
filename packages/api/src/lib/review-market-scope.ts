import type { Knex } from "knex";

type ReviewRow = {
  id: string;
};

function buildScopedReviewQuery(db: Knex, salesChannelId: string) {
  return db("review as review")
    .distinct("review.id", "review.created_at")
    .innerJoin(
      "product_product_review_review as pprr",
      "review.id",
      "pprr.review_id"
    )
    .innerJoin("product as product", "pprr.product_id", "product.id")
    .innerJoin("product_sales_channel as psc", "product.id", "psc.product_id")
    .where("review.reference", "product")
    .where("psc.sales_channel_id", salesChannelId)
    .whereNull("review.deleted_at")
    .whereNull("pprr.deleted_at")
    .whereNull("product.deleted_at")
    .whereNull("psc.deleted_at");
}

export async function listReviewIdsForSalesChannel(
  db: Knex,
  salesChannelId: string,
  offset: number,
  limit: number
): Promise<{ reviewIds: string[]; count: number }> {
  const baseQuery = buildScopedReviewQuery(db, salesChannelId);

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