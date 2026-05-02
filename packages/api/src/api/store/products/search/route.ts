import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  ContainerRegistrationKeys,
  QueryContext,
} from "@medusajs/framework/utils";
import type { Knex } from "knex";
import { marketContextStorage } from "../../../../lib/market-context";
import { searchProductIdsForSalesChannel } from "../../../../lib/product-market-scope";

type SearchBody = {
  query: string;
  page: number;
  hitsPerPage: number;
  currency_code?: string;
  region_id?: string;
  customer_id?: string;
  customer_group_id?: string[];
};

type QueryGraphResult = {
  data: Array<Record<string, unknown>>;
};

function buildEmptyResponse(body: SearchBody, processingTimeMS = 0) {
  return {
    products: [],
    nbHits: 0,
    page: body.page,
    nbPages: 0,
    hitsPerPage: body.hitsPerPage,
    facets: {},
    facets_stats: {},
    processingTimeMS,
    query: body.query,
  };
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const salesChannelId = marketContextStorage.getStore()?.sales_channel_id;
  const raw = req.validatedBody as SearchBody;
  const page = typeof raw.page === "number" && !isNaN(raw.page) && raw.page >= 0 ? raw.page : 0;
  const hitsPerPage =
    typeof raw.hitsPerPage === "number" && !isNaN(raw.hitsPerPage) && raw.hitsPerPage > 0
      ? raw.hitsPerPage
      : 20;
  const body: SearchBody = { ...raw, page, hitsPerPage };
  const startedAt = Date.now();

  if (!salesChannelId) {
    res.json(buildEmptyResponse(body, Date.now() - startedAt));
    return;
  }

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex;
  const offset = page * hitsPerPage;
  const { productIds, count } = await searchProductIdsForSalesChannel(
    db,
    salesChannelId,
    {
      query: body.query,
      offset,
      limit: hitsPerPage,
    }
  );

  if (!productIds.length) {
    res.json({
      ...buildEmptyResponse(body, Date.now() - startedAt),
      nbHits: count,
      nbPages: count > 0 ? Math.ceil(count / body.hitsPerPage) : 0,
    });
    return;
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (input: Record<string, unknown>) => Promise<QueryGraphResult>;
  };
  const hasPricingContext =
    body.currency_code ||
    body.region_id ||
    body.customer_id ||
    body.customer_group_id;
  const contextParams: Record<string, unknown> = {};

  if (hasPricingContext) {
    contextParams.variants = {
      calculated_price: QueryContext({
        ...(body.currency_code && { currency_code: body.currency_code }),
        ...(body.region_id && { region_id: body.region_id }),
        ...(body.customer_id && { customer_id: body.customer_id }),
        ...(body.customer_group_id && {
          customer_group_id: body.customer_group_id,
        }),
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

  const productsById = new Map(products.map((product) => [product.id, product]));
  const orderedProducts = productIds
    .map((productId) => productsById.get(productId))
    .filter(Boolean);

  res.json({
    products: orderedProducts,
    nbHits: count,
    page: body.page,
    nbPages: count > 0 ? Math.ceil(count / body.hitsPerPage) : 0,
    hitsPerPage: body.hitsPerPage,
    facets: {},
    facets_stats: {},
    processingTimeMS: Date.now() - startedAt,
    query: body.query,
  });
}