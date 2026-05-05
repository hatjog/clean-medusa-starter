import type { Knex } from "knex";

const PRODUCT_SELLER_LINK_TABLE = "product_product_seller_seller";

type SellerIdRow = {
  id: string;
};

function buildScopedSellerIdQuery(db: Knex, salesChannelId: string) {
  return db("seller as seller")
    .distinct("seller.id")
    .innerJoin(
      `${PRODUCT_SELLER_LINK_TABLE} as ppss`,
      "seller.id",
      "ppss.seller_id"
    )
    .innerJoin("product as product", "ppss.product_id", "product.id")
    .innerJoin(
      "product_sales_channel as psc",
      "product.id",
      "psc.product_id"
    )
    .where("psc.sales_channel_id", salesChannelId)
    .where("seller.status", "open")
    .whereNull("seller.deleted_at")
    .whereNull("ppss.deleted_at")
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
