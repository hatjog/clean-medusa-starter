import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  ContainerRegistrationKeys,
  isPresent,
  QueryContext,
} from "@medusajs/framework/utils";
import type { Knex } from "knex";
import { requireMercurServerModule } from "../../../lib/mercur-module-loader";
import { marketContextStorage } from "../../../lib/market-context";
import { filterProductIdsForSalesChannel } from "../../../lib/product-market-scope";

type QueryGraphResult = {
  data: Array<Record<string, any>>;
};

type CreateWishlistWorkflowModule = {
  createWishlistEntryWorkflow: {
    run: (input: {
      container: MedusaRequest["scope"];
      input: Record<string, unknown>;
    }) => Promise<{ result: { id: string } }>;
  };
};

type CustomerWishlistLinkModule = {
  default: {
    entryPoint: string;
  };
};

function getCreateWishlistEntryWorkflow() {
  return requireMercurServerModule<CreateWishlistWorkflowModule>(
    "b2c-core",
    "workflows",
    "wishlist",
    "workflows",
    "create-wishlist.js"
  ).createWishlistEntryWorkflow;
}

function getCustomerWishlistLink() {
  return requireMercurServerModule<CustomerWishlistLinkModule>(
    "b2c-core",
    "links",
    "customer-wishlist.js"
  ).default;
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const createWishlistEntryWorkflow = getCreateWishlistEntryWorkflow();
  const { result } = await createWishlistEntryWorkflow.run({
    container: req.scope,
    input: {
      ...req.validatedBody,
      customer_id: req.auth_context.actor_id,
    },
  });

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (input: Record<string, unknown>) => Promise<QueryGraphResult>;
  };
  const {
    data: [wishlist],
  } = await query.graph({
    entity: "wishlist",
    fields: req.queryConfig.fields,
    filters: {
      id: result.id,
    },
  });

  res.status(201).json({ wishlist });
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (input: Record<string, unknown>) => Promise<QueryGraphResult>;
  };
  const customerId = req.auth_context.actor_id;
  const salesChannelId = marketContextStorage.getStore()?.sales_channel_id;
  const offset = req.queryConfig.pagination?.skip ?? 0;
  const limit = req.queryConfig.pagination?.take ?? 50;

  if (!salesChannelId) {
    res.json({
      products: [],
      count: 0,
      offset,
      limit,
    });
    return;
  }

  const customerWishlistLink = getCustomerWishlistLink();
  const {
    data: [wishlistLink],
  } = await query.graph({
    entity: customerWishlistLink.entryPoint,
    fields: ["wishlist.id", "wishlist.products.id"],
    filters: {
      customer_id: customerId,
    },
  });

  const rawProductIds = Array.isArray(wishlistLink?.wishlist?.products)
    ? wishlistLink.wishlist.products
        .map((product: Record<string, unknown>) =>
          typeof product?.id === "string" ? product.id : null
        )
        .filter((productId: string | null): productId is string => !!productId)
    : [];

  if (!rawProductIds.length) {
    res.json({
      products: [],
      count: 0,
      offset,
      limit,
    });
    return;
  }

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex;
  const { ids: paginatedProductIds, count } = await filterProductIdsForSalesChannel(
    db,
    salesChannelId,
    rawProductIds,
    { offset, limit }
  );

  if (!paginatedProductIds.length) {
    res.json({
      products: [],
      count,
      offset,
      limit,
    });
    return;
  }

  let context = {};

  if (isPresent(req.pricingContext)) {
    const pricingContext = {
      ...req.pricingContext,
      customer_id: customerId,
    };

    context = {
      variants: {
        calculated_price: QueryContext(pricingContext),
      },
    };
  }

  const fields = req.queryConfig.fields.includes("id")
    ? req.queryConfig.fields
    : [...req.queryConfig.fields, "id"];
  const { data: products } = await query.graph({
    entity: "product",
    fields,
    filters: {
      id: paginatedProductIds,
    },
    ...(Object.keys(context).length > 0 && { context }),
  });

  const productsById = new Map(
    products.map((product) => [String(product.id), product])
  );

  res.json({
    products: paginatedProductIds
      .map((productId) => productsById.get(productId))
      .filter(Boolean),
    count,
    offset,
    limit,
  });
}