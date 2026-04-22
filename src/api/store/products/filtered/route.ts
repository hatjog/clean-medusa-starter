import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  ContainerRegistrationKeys,
  QueryContext,
} from "@medusajs/framework/utils";
import type { Knex } from "knex";
import { marketContextStorage } from "../../../../lib/market-context";
import { filterProductIdsByFilters } from "../../../../lib/product-market-scope";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Also allow stable config IDs such as style:soft-glow or age-group:3-6.
const ALPHANUMERIC_RE = /^[a-z0-9]+$/i;
const STABLE_TAG_ID_RE = /^[a-z0-9_-]+(?::[a-z0-9_-]+)+$/i;
const CURRENCY_CODE_RE = /^[A-Z]{3}$/;
const CITY_ALLOWED_CHARS_RE = /[^a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ\s-]/g;
const ALLOWED_DURATIONS = [30, 45, 60, 90] as const;
const ALLOWED_ORDER = ["created_at", "price_asc", "price_desc"] as const;
type OrderOption = (typeof ALLOWED_ORDER)[number];

type QueryGraphResult = {
  data: Array<Record<string, unknown>>;
};

/**
 * GET /store/products/filtered
 *
 * Custom pipeline endpoint for storefront filters that are not natively supported
 * by Medusa (tag_id, city, duration, seller_rating).
 *
 * Dual-mode architecture (ADR): Medusa native /store/products is the default path.
 * This endpoint is called ONLY when at least one custom filter is active — at which
 * point ALL filters (including category_id) go through this pipeline for consistent
 * count/pagination. See filterProductIdsByFilters() for SQL pipeline details.
 *
 * Response format is intentionally identical to /store/products so the frontend
 * can switch between endpoints transparently.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const marketContext = marketContextStorage.getStore();
  const salesChannelId = marketContext?.sales_channel_id;
  const marketId = marketContext?.market_id;

  if (!salesChannelId) {
    res.json({ products: [], count: 0, offset: 0, limit: 20 });
    return;
  }

  const q = req.query as Record<string, string | string[] | undefined>;

  // Helper: parse a single-string CSV query param into an array of trimmed, non-empty strings
  const parseCSV = (key: string): string[] => {
    const val = typeof q[key] === "string" ? (q[key] as string) : "";
    return val.split(",").map((s) => s.trim()).filter(Boolean);
  };

  // --- tag_id: CSV of UUIDs or stable config IDs, max 20 ---
  const rawTagFilters = parseCSV("tag_id");
  if (rawTagFilters.length > 20) {
    res
      .status(400)
      .json({ message: "tag_id: max 20 values allowed" });
    return;
  }
  const tagIds = rawTagFilters.filter((id) => UUID_RE.test(id));
  const tagValues = rawTagFilters.filter(
    (id) => !UUID_RE.test(id) && (ALPHANUMERIC_RE.test(id) || STABLE_TAG_ID_RE.test(id))
  );

  // --- category_id: CSV of UUIDs, max 10 ---
  const rawCategoryIds = parseCSV("category_id");
  if (rawCategoryIds.length > 10) {
    res
      .status(400)
      .json({ message: "category_id: max 10 values allowed" });
    return;
  }
  const categoryIds = rawCategoryIds.filter((id) => UUID_RE.test(id));

  // --- city: CSV, strip non-allowed chars, max 10 ---
  const rawCities = parseCSV("city");
  if (rawCities.length > 10) {
    res.status(400).json({ message: "city: max 10 values allowed" });
    return;
  }
  const cities = rawCities
    .map((c) =>
      c.length <= 100 ? c.replace(CITY_ALLOWED_CHARS_RE, "").trim() : ""
    )
    .filter(Boolean);

  // --- duration: CSV, allowlist [30, 45, 60, 90], max 4 ---
  const rawDurations = parseCSV("duration");
  if (rawDurations.length > 4) {
    res.status(400).json({ message: "duration: max 4 values allowed" });
    return;
  }
  const durations = rawDurations
    .map((s) => parseInt(s, 10))
    .filter(
      (n): n is (typeof ALLOWED_DURATIONS)[number] =>
        !isNaN(n) &&
        (ALLOWED_DURATIONS as readonly number[]).includes(n)
    );

  // --- seller_rating: CSV of [1-5], max 5 → convert to min_rating (scalar) ---
  const rawSellerRatings = parseCSV("seller_rating");
  if (rawSellerRatings.length > 5) {
    res
      .status(400)
      .json({ message: "seller_rating: max 5 values allowed" });
    return;
  }
  const sellerRatings = rawSellerRatings
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n) && n >= 1 && n <= 5);
  const minRating =
    sellerRatings.length > 0 ? Math.min(...sellerRatings) : undefined;

  // --- min_price / max_price: passed to query.graph() as Medusa native pricing params ---
  const rawMinPrice =
    typeof q["min_price"] === "string" ? Number(q["min_price"]) : NaN;
  const rawMaxPrice =
    typeof q["max_price"] === "string" ? Number(q["max_price"]) : NaN;
  const minPrice =
    !isNaN(rawMinPrice) && rawMinPrice >= 0 ? rawMinPrice : undefined;
  const maxPrice =
    !isNaN(rawMaxPrice) && rawMaxPrice >= 0 ? rawMaxPrice : undefined;

  if (minPrice !== undefined && maxPrice !== undefined && maxPrice < minPrice) {
    res
      .status(400)
      .json({ message: "max_price must be >= min_price" });
    return;
  }

  // --- offset / limit ---
  const rawOffset =
    typeof q["offset"] === "string" ? parseInt(q["offset"], 10) : 0;
  const rawLimit =
    typeof q["limit"] === "string" ? parseInt(q["limit"], 10) : 20;
  const offset = !isNaN(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const limit =
    !isNaN(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 20;

  // --- order ---
  const rawOrder = typeof q["order"] === "string" ? q["order"] : "created_at";
  const order: OrderOption = (
    ALLOWED_ORDER as readonly string[]
  ).includes(rawOrder)
    ? (rawOrder as OrderOption)
    : "created_at";

  // --- pricing context (validated to prevent injection into Medusa internals) ---
  const rawRegionId = typeof q["region_id"] === "string" ? q["region_id"] : undefined;
  const regionId = rawRegionId && UUID_RE.test(rawRegionId) ? rawRegionId : undefined;

  const rawCurrencyCode = typeof q["currency_code"] === "string" ? q["currency_code"] : undefined;
  const currencyCode = rawCurrencyCode && CURRENCY_CODE_RE.test(rawCurrencyCode) ? rawCurrencyCode : undefined;

  const rawCustomerId = typeof q["customer_id"] === "string" ? q["customer_id"] : undefined;
  const customerId = rawCustomerId && UUID_RE.test(rawCustomerId) ? rawCustomerId : undefined;

  const db = req.scope.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as Knex;

  const filters = {
    ...(tagIds.length > 0 && { tag_id: tagIds }),
    ...(tagValues.length > 0 && { tag_value: tagValues }),
    ...(categoryIds.length > 0 && { category_id: categoryIds }),
    ...(cities.length > 0 && { city: cities }),
    ...(durations.length > 0 && { duration: durations }),
    ...(minRating !== undefined && { min_rating: minRating }),
  };

  // Run pipeline query inside a transaction to scope statement_timeout.
  // NOTE: SET LOCAL applies per-statement. The pipeline executes 2 queries (COUNT + IDs),
  // so worst-case wall time is 2 × 3s = 6s. Keep per-statement limit low to catch runaway queries.
  const { productIds, count } = await db.transaction(async (trx) => {
    // Re-apply RLS context inside the transaction connection. The pool hook sets
    // context on ordinary acquired connections, but Knex transactions can use a
    // separate connection where ALS-derived session state is not present.
    if (marketId) {
      await trx.raw("SET LOCAL ROLE medusa_store");
      await trx.raw("SELECT set_config('app.gp_market_id', ?, true)", [marketId]);
    }
    await trx.raw("SET LOCAL statement_timeout = '3000'");
    return filterProductIdsByFilters(trx, salesChannelId, filters, {
      offset,
      limit,
    });
  });

  if (productIds.length === 0) {
    res.json({ products: [], count, offset, limit });
    return;
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (input: Record<string, unknown>) => Promise<QueryGraphResult>;
  };

  const hasPricingContext = currencyCode || regionId || customerId;
  const contextParams: Record<string, unknown> = {};

  if (hasPricingContext) {
    contextParams.variants = {
      calculated_price: QueryContext({
        ...(currencyCode && { currency_code: currencyCode }),
        ...(regionId && { region_id: regionId }),
        ...(customerId && { customer_id: customerId }),
      }),
    };
  }

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "*",
      "images.*",
      "options.*",
      "options.values.*",
      "variants.*",
      "variants.options.*",
      "variants.prices.*",
      ...(hasPricingContext ? ["variants.calculated_price.*"] : []),
      "categories.*",
      "collection.*",
      "type.*",
      "tags.*",
      "seller.*",
    ],
    filters: {
      id: productIds,
    },
    ...(Object.keys(contextParams).length > 0 && { context: contextParams }),
  });

  // Reorder by productIds array to preserve SQL ORDER BY
  const productsById = new Map(products.map((p) => [p.id, p]));
  let orderedProducts = productIds
    .map((id) => productsById.get(id))
    .filter(Boolean);

  // Post-hydration price sort (price_asc/price_desc).
  // Not done in SQL because raw prices != calculated_price (regions, discounts, currencies).
  // Uses minimum calculated_price across all variants (consistent with native sortProducts() helper).
  if (order === "price_asc" || order === "price_desc") {
    const getMinPrice = (product: any): number => {
      const prices = (product.variants ?? [])
        .map((v: any) => v.calculated_price?.calculated_amount)
        .filter((p: any) => p != null) as number[];
      return prices.length > 0 ? Math.min(...prices) : NaN;
    };
    const fallback = order === "price_asc" ? Infinity : -Infinity;
    orderedProducts = orderedProducts.sort((a: any, b: any) => {
      const aP = getMinPrice(a);
      const bP = getMinPrice(b);
      const aVal = isNaN(aP) ? fallback : aP;
      const bVal = isNaN(bP) ? fallback : bP;
      return order === "price_asc" ? aVal - bVal : bVal - aVal;
    });
  }

  // Return pipeline total count for pagination UI.
  // orderedProducts.length is the current page size (≤ limit).
  // Pipeline count may be slightly higher than actual hydrated products due to race conditions
  // (product deleted/unpublished between SQL and hydration) — this is an acceptable approximation.
  res.json({
    products: orderedProducts,
    count,
    offset,
    limit,
  });
}
