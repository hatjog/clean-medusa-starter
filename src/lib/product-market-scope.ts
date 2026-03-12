import type { Knex } from "knex";

type ProductRow = {
  id: string;
};

/**
 * Filters for the custom pipeline endpoint /store/products/filtered.
 * min_price / max_price are intentionally excluded — they go to query.graph() as Medusa native pricing params.
 */
export type FilterParams = {
  tag_id?: string[];
  category_id?: string[];
  city?: string[];
  duration?: number[];
  min_rating?: number;
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

/**
 * Filters product IDs by a set of custom filters using a dynamic Knex pipeline.
 * Called by GET /store/products/filtered when any non-native Medusa filter is active.
 *
 * NOTE: min_price / max_price are NOT filtered here — pass them to query.graph() instead.
 * NOTE: Suspended sellers are excluded via LEFT JOIN (products without a seller are kept).
 */
export async function filterProductIdsByFilters(
  db: Knex,
  salesChannelId: string,
  filters: FilterParams,
  pagination: { offset: number; limit: number }
): Promise<{ productIds: string[]; count: number }> {
  // Base scoped query: published, not deleted, within sales channel.
  // We extend DISTINCT columns to include created_at for ORDER BY.
  let query = buildScopedProductQuery(db, salesChannelId).column(
    "product.created_at"
  );

  // LEFT JOIN seller chain so we can:
  //  (a) filter out SUSPENDED sellers
  //  (b) optionally filter by city / seller rating (via review subquery)
  // Soft-deleted links / sellers are excluded via ON clause to preserve LEFT JOIN semantics.
  query = query
    .leftJoin("seller_seller_product_product as sspp", function () {
      this.on("product.id", "=", "sspp.product_id").andOnNull(
        "sspp.deleted_at"
      );
    })
    .leftJoin("seller", function () {
      this.on("sspp.seller_id", "=", "seller.id").andOnNull(
        "seller.deleted_at"
      );
    })
    .where((builder) => {
      builder
        .where("seller.store_status", "!=", "SUSPENDED")
        .orWhereNull("seller.id");
    });

  // tag_id: INNER JOIN product_tags (only products with a matching tag survive)
  if (filters.tag_id?.length) {
    query = query
      .join("product_tags as pt", "product.id", "pt.product_id")
      .whereIn("pt.product_tag_id", filters.tag_id);
  }

  // category_id: INNER JOIN product_category_product
  if (filters.category_id?.length) {
    query = query
      .join(
        "product_category_product as pcp",
        "product.id",
        "pcp.product_id"
      )
      .whereIn("pcp.product_category_id", filters.category_id);
  }

  // city: WHERE on seller.city — products without a seller naturally have NULL city and are excluded
  if (filters.city?.length) {
    query = query.whereIn("seller.city", filters.city);
  }

  // duration: INNER JOIN product_variant with regex guard before ::int cast (non-numeric metadata values are skipped)
  if (filters.duration?.length) {
    const placeholders = filters.duration.map(() => "?").join(", ");
    query = query
      .join("product_variant as pv", "product.id", "pv.product_id")
      .whereRaw(`pv.metadata->>'duration' ~ '^\\d+$'`)
      .whereRaw(
        `(pv.metadata->>'duration')::int IN (${placeholders})`,
        filters.duration
      );
  }

  // min_rating: correlated subquery computes AVG(rating) from review table
  // via junction table seller_seller_review_review.
  // Products without a seller (NULL seller.id) are naturally excluded.
  if (filters.min_rating !== undefined) {
    // prettier-ignore
    query = query.whereRaw(
      `COALESCE((
        SELECT AVG(r.rating)
        FROM review r
        JOIN seller_seller_review_review ssrr
          ON ssrr.review_id = r.id
          AND ssrr.deleted_at IS NULL
        WHERE ssrr.seller_id = seller.id
          AND r.deleted_at IS NULL
      ), 0) >= ?`,
      [filters.min_rating]
    );
  }

  // COUNT: wrap the DISTINCT subquery to get total matching products
  const countResult = await db
    .from(query.clone().as("scoped_products"))
    .count<{ count: string }>({ count: "*" })
    .first();

  const count = Number(countResult?.count ?? 0);

  if (count === 0) {
    return { productIds: [], count: 0 };
  }

  // Paginated IDs, ordered by created_at DESC for deterministic results
  const rows = await query
    .clone()
    .orderBy("product.created_at", "desc")
    .orderBy("product.id", "asc")
    .offset(pagination.offset)
    .limit(pagination.limit);

  return {
    productIds: (rows as ProductRow[]).map((row) => row.id),
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