import type { Knex } from "knex";

type ProductRow = {
  id: string;
};

type SearchArgs = {
  query: string;
  offset: number;
  limit: number;
};

function buildScopedProductQuery(db: Knex, salesChannelId: string) {
  return db("product as product")
    .distinct("product.id", "product.updated_at")
    .innerJoin("product_sales_channel as psc", "product.id", "psc.product_id")
    .where("psc.sales_channel_id", salesChannelId)
    .where("product.status", "published")
    .whereNull("product.deleted_at")
    .whereNull("psc.deleted_at");
}

export async function filterProductIdsForSalesChannel(
  db: Knex,
  salesChannelId: string,
  productIds: string[],
  pagination?: { offset: number; limit: number }
): Promise<{ ids: string[]; count: number }> {
  if (!productIds.length) {
    return { ids: [], count: 0 };
  }

  const baseQuery = buildScopedProductQuery(db, salesChannelId).whereIn(
    "product.id",
    productIds
  );

  const countResult = await db
    .from(baseQuery.clone().as("scoped_products"))
    .count<{ count: string }>({ count: "*" })
    .first();

  const count = Number(countResult?.count ?? 0);

  if (count === 0) {
    return { ids: [], count: 0 };
  }

  let pageQuery = baseQuery.clone();

  if (pagination) {
    pageQuery = pageQuery.offset(pagination.offset).limit(pagination.limit);
  }

  const rows = await pageQuery;

  return {
    ids: (rows as ProductRow[]).map((row) => row.id),
    count,
  };
}

export async function searchProductIdsForSalesChannel(
  db: Knex,
  salesChannelId: string,
  args: SearchArgs
): Promise<{ productIds: string[]; count: number }> {
  const baseQuery = buildScopedProductQuery(db, salesChannelId);
  const trimmedQuery = args.query.trim();

  if (trimmedQuery) {
    const pattern = `%${trimmedQuery}%`;

    baseQuery.andWhere((builder) => {
      builder
        .whereILike("product.title", pattern)
        .orWhereILike("product.handle", pattern)
        .orWhereILike("product.subtitle", pattern)
        .orWhereILike("product.description", pattern);
    });
  }

  const countResult = await db
    .from(baseQuery.clone().as("scoped_products"))
    .count<{ count: string }>({ count: "*" })
    .first();

  const rows = await baseQuery
    .clone()
    .orderBy("product.updated_at", "desc")
    .orderBy("product.id", "asc")
    .offset(args.offset)
    .limit(args.limit);

  return {
    productIds: (rows as ProductRow[]).map((row) => row.id),
    count: Number(countResult?.count ?? 0),
  };
}