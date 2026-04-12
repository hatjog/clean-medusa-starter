import type { Knex } from "knex";

type SellerIdRow = {
  id: string;
};

function buildScopedSellerIdQuery(db: Knex, salesChannelId: string) {
  return db("seller as seller")
    .distinct("seller.id")
    .innerJoin(
      "seller_seller_product_product as sspp",
      "seller.id",
      "sspp.seller_id"
    )
    .innerJoin("product as product", "sspp.product_id", "product.id")
    .innerJoin(
      "product_sales_channel as psc",
      "product.id",
      "psc.product_id"
    )
    .where("psc.sales_channel_id", salesChannelId)
    .where("seller.store_status", "ACTIVE")
    .whereNull("seller.deleted_at")
    .whereNull("sspp.deleted_at")
    .whereNull("product.deleted_at")
    .whereNull("psc.deleted_at");
}

export async function listSellerIdsForSalesChannel(
  db: Knex,
  salesChannelId: string,
  offset: number,
  limit: number
): Promise<{ sellerIds: string[]; count: number }> {
  const baseQuery = buildScopedSellerIdQuery(db, salesChannelId);

  const countResult = await db
    .from(baseQuery.clone().as("scoped_sellers"))
    .count<{ count: string }>({ count: "*" })
    .first();

  const rows = await baseQuery
    .clone()
    .orderBy("seller.id", "asc")
    .offset(offset)
    .limit(limit);

  return {
    sellerIds: (rows as SellerIdRow[]).map((row) => row.id),
    count: Number(countResult?.count ?? 0),
  };
}

export async function getSellerIdByHandleForSalesChannel(
  db: Knex,
  salesChannelId: string,
  handle: string
): Promise<string | null> {
  const row = await buildScopedSellerIdQuery(db, salesChannelId)
    .where("seller.handle", handle)
    .first<SellerIdRow>("seller.id");

  return row?.id ?? null;
}