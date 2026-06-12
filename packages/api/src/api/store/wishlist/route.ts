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
  data: Array<Record<string, unknown>>;
};

const fallbackWishlistsByCustomer = new Map<string, Set<string>>();

type AuthenticatedStoreRequest = MedusaRequest & {
  auth_context?: {
    actor_id?: string;
  };
};

type WishlistLinkRecord = {
  wishlist?: {
    products?: Array<{ id?: unknown }>;
  };
};

function getCustomerId(req: AuthenticatedStoreRequest): string | undefined {
  const actorId = req.auth_context?.actor_id;
  return typeof actorId === "string" && actorId.length > 0 ? actorId : undefined;
}

function isWishlistLinkRecord(value: unknown): value is WishlistLinkRecord {
  return typeof value === "object" && value !== null;
}

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

function isOptionalWishlistModuleUnavailable(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("Mercur package @mercurjs/b2c-core not found")
  );
}

export async function POST(req: AuthenticatedStoreRequest, res: MedusaResponse) {
  const customerId = getCustomerId(req);
  const body = ((req.validatedBody ?? req.body ?? {}) as Record<
    string,
    unknown
  >);

  let createWishlistEntryWorkflow: ReturnType<typeof getCreateWishlistEntryWorkflow>;
  try {
    createWishlistEntryWorkflow = getCreateWishlistEntryWorkflow();
  } catch (error) {
    if (!isOptionalWishlistModuleUnavailable(error)) {
      throw error;
    }

    const referenceId =
      typeof body.reference_id === "string" && body.reference_id.length > 0
        ? body.reference_id
        : null;

    if (customerId && referenceId) {
      const productIds =
        fallbackWishlistsByCustomer.get(customerId) ?? new Set<string>();
      productIds.add(referenceId);
      fallbackWishlistsByCustomer.set(customerId, productIds);
    }

    res.status(201).json({
      wishlist: {
        id: customerId ? `fallback_${customerId}` : "fallback_anonymous",
        products: referenceId ? [{ id: referenceId }] : [],
      },
    });
    return;
  }

  const { result } = await createWishlistEntryWorkflow.run({
    container: req.scope,
    input: {
      ...body,
      customer_id: customerId,
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

export async function GET(req: AuthenticatedStoreRequest, res: MedusaResponse) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (input: Record<string, unknown>) => Promise<QueryGraphResult>;
  };
  const customerId = getCustomerId(req);
  const salesChannelId = marketContextStorage.getStore()?.sales_channel_id;
  const offset = req.queryConfig?.pagination?.skip ?? 0;
  const requestedLimit =
    typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
  const limit = (req.queryConfig?.pagination?.take ?? requestedLimit) || 50;

  if (!salesChannelId) {
    res.json({
      products: [],
      count: 0,
      offset,
      limit,
    });
    return;
  }

  let rawProductIds: string[] = [];

  try {
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

    rawProductIds = isWishlistLinkRecord(wishlistLink) && Array.isArray(wishlistLink.wishlist?.products)
      ? wishlistLink.wishlist.products
          .map((product) => (typeof product.id === "string" ? product.id : null))
          .filter((productId: string | null): productId is string => !!productId)
      : [];
  } catch (error) {
    if (!isOptionalWishlistModuleUnavailable(error)) {
      throw error;
    }

    rawProductIds = customerId
      ? Array.from(fallbackWishlistsByCustomer.get(customerId) ?? [])
      : [];
  }

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

  const queryFields = req.queryConfig?.fields ?? ["*"];
  const fields = queryFields.includes("id")
    ? queryFields
    : [...queryFields, "id"];
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
