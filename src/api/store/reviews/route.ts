import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "knex";
import { requireMercurServerModule } from "../../../lib/mercur-module-loader";
import { marketContextStorage } from "../../../lib/market-context";
import { listReviewIdsForSalesChannel } from "../../../lib/review-market-scope";

type QueryGraphResult = {
  data: Array<Record<string, unknown>>;
};

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

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const createReviewWorkflow = getCreateReviewWorkflow();
  const { result } = await createReviewWorkflow.run({
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
  const { reviewIds, count } = await listReviewIdsForSalesChannel(
    db,
    salesChannelId,
    offset,
    limit
  );

  if (!reviewIds.length) {
    res.json({
      reviews: [],
      count,
      offset,
      limit,
    });
    return;
  }

  const fields = req.queryConfig.fields.includes("id")
    ? req.queryConfig.fields
    : [...req.queryConfig.fields, "id"];
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (input: Record<string, unknown>) => Promise<QueryGraphResult>;
  };
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
  });
}