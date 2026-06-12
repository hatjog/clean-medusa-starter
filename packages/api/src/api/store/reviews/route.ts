import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "knex";
import { requireMercurServerModule } from "../../../lib/mercur-module-loader";
import { marketContextStorage } from "../../../lib/market-context";
import {
  type AuthenticatedStoreRequest,
  getCustomerId,
  resolveQueryGraph,
} from "../../../lib/request-surface";
import {
  getLiveReviewStatsForSalesChannel,
  listReviewIdsForSalesChannel,
} from "../../../lib/review-market-scope";

type CreateReviewWorkflowModule = {
  createReviewWorkflow: {
    run: (input: {
      container: MedusaRequest["scope"];
      input: Record<string, unknown>;
    }) => Promise<{ result: { id: string } }>;
  };
};

function getCreateReviewWorkflow() {
  return requireMercurServerModule<CreateReviewWorkflowModule>(
    "reviews",
    "workflows",
    "review",
    "workflows",
    "create-review.js"
  ).createReviewWorkflow;
}

export async function POST(req: AuthenticatedStoreRequest, res: MedusaResponse) {
  const createReviewWorkflow = getCreateReviewWorkflow();
  const { result } = await createReviewWorkflow.run({
    container: req.scope,
    input: {
      ...(req.validatedBody as Record<string, unknown>),
      customer_id: getCustomerId(req),
    },
  });

  const query = resolveQueryGraph(req);
  const {
    data: [review],
  } = await query.graph({
    entity: "review",
    fields: req.queryConfig.fields,
    filters: {
      id: result.id,
    },
  });

  res.status(201).json({ review });
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const salesChannelId = marketContextStorage.getStore()?.sales_channel_id;
  const offset = req.queryConfig.pagination?.skip ?? 0;
  const limit = req.queryConfig.pagination?.take ?? 50;
  const productId =
    typeof req.query.product_id === "string" ? req.query.product_id : undefined;
  const sellerId =
    typeof req.query.seller_id === "string" ? req.query.seller_id : undefined;
  const filters = {
    ...(productId ? { productId } : {}),
    ...(sellerId ? { sellerId } : {}),
  };

  if (!salesChannelId) {
    res.json({
      reviews: [],
      count: 0,
      offset,
      limit,
    });
    return;
  }

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex;
  const [{ reviewIds, count }, stats] = await Promise.all([
    listReviewIdsForSalesChannel(db, salesChannelId, offset, limit, filters),
    getLiveReviewStatsForSalesChannel(db, salesChannelId, filters),
  ]);

  if (!reviewIds.length) {
    res.json({
      reviews: [],
      count,
      offset,
      limit,
      average_rating: stats.averageRating,
      rating_count: stats.count,
    });
    return;
  }

  const fields = req.queryConfig.fields.includes("id")
    ? req.queryConfig.fields
    : [...req.queryConfig.fields, "id"];
  const query = resolveQueryGraph(req);
  const { data: reviews } = await query.graph({
    entity: "review",
    fields,
    filters: {
      id: reviewIds,
    },
  });

  const reviewsById = new Map(reviews.map((review) => [String(review.id), review]));

  res.json({
    reviews: reviewIds
      .map((reviewId) => reviewsById.get(reviewId))
      .filter(Boolean),
    count,
    offset,
    limit,
    average_rating: stats.averageRating,
    rating_count: stats.count,
  });
}
