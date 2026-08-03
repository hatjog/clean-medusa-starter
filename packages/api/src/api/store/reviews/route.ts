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

/**
 * `req.queryConfig` is populated by Medusa's `validateAndTransformQuery`
 * middleware. This GP custom /store/reviews route is not registered with that
 * middleware, so `req.queryConfig` is `undefined` at runtime even though the
 * type claims otherwise — reading `.pagination` / `.fields` off it threw
 * `Cannot read properties of undefined (reading 'pagination')` → HTTP 500.
 * These helpers prefer the validated queryConfig when present and otherwise
 * fall back to the raw request query, so the route works with or without it.
 */
function resolveReviewFields(req: MedusaRequest): string[] {
  const queryConfig = req.queryConfig as MedusaRequest["queryConfig"] | undefined;
  const configured = queryConfig?.fields;
  if (Array.isArray(configured) && configured.length > 0) {
    return configured;
  }

  const raw = req.query?.fields;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);
  }

  return ["*"];
}

function resolveReviewPagination(req: MedusaRequest): {
  offset: number;
  limit: number;
} {
  const queryConfig = req.queryConfig as MedusaRequest["queryConfig"] | undefined;
  const pagination = queryConfig?.pagination;

  const toNonNegativeInt = (value: unknown, fallback: number): number => {
    const raw = Array.isArray(value) ? value[0] : value;
    const parsed =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number.parseInt(raw, 10)
          : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };

  return {
    offset: pagination?.skip ?? toNonNegativeInt(req.query?.offset, 0),
    limit: pagination?.take ?? toNonNegativeInt(req.query?.limit, 50),
  };
}

/**
 * Postgres "undefined_table" (42P01). Raised when the `review` relation and its
 * link tables are absent — i.e. the reviews module (`@mercurjs/reviews`) is not
 * installed / migrated in this environment. Treated as "no reviews configured"
 * rather than a hard failure so a non-critical PDP surface degrades to empty
 * instead of returning HTTP 500 for every product/seller page.
 */
function isMissingReviewStorageError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "42P01"
  );
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
    fields: resolveReviewFields(req),
    filters: {
      id: result.id,
    },
  });

  res.status(201).json({ review });
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const salesChannelId = marketContextStorage.getStore()?.sales_channel_id;
  const { offset, limit } = resolveReviewPagination(req);
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

  try {
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

    const baseFields = resolveReviewFields(req);
    const fields = baseFields.includes("id") ? baseFields : [...baseFields, "id"];
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
  } catch (error) {
    if (!isMissingReviewStorageError(error)) {
      throw error;
    }

    // Reviews storage isn't provisioned in this environment (see
    // isMissingReviewStorageError). Reviews are a non-critical PDP surface, so
    // degrade to an empty 200 response instead of 500-ing the whole page — but
    // log a warning so the missing module stays observable, not silently swallowed.
    const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER) as {
      warn?: (message: string) => void;
    };
    logger?.warn?.(
      "[store/reviews] review storage unavailable (relation missing) — returning empty result; ensure the reviews module is migrated"
    );

    res.json({
      reviews: [],
      count: 0,
      offset,
      limit,
      average_rating: 0,
      rating_count: 0,
    });
  }
}
