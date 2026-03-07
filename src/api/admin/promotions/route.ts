import { createPromotionsWorkflow } from "@medusajs/core-flows";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  ContainerRegistrationKeys,
  remoteQueryObjectFromString,
} from "@medusajs/framework/utils";
import {
  extractPromotionMarketId,
  updatePromotionMarketMetadata,
} from "../../../lib/promotion-market-metadata";
import { refetchPromotionWithMetadata } from "./helpers";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const remoteQuery = req.scope.resolve(
    ContainerRegistrationKeys.REMOTE_QUERY
  ) as (
    input: Record<string, unknown>
  ) => Promise<{ rows: Array<Record<string, unknown>>; metadata: { count: number; skip: number; take: number } }>;
  const queryObject = remoteQueryObjectFromString({
    entryPoint: "promotion",
    variables: {
      filters: req.filterableFields,
      ...req.queryConfig.pagination,
    },
    fields: req.queryConfig.fields,
  });
  const { rows: promotions, metadata } = await remoteQuery(queryObject);

  res.json({
    promotions,
    count: metadata.count,
    offset: metadata.skip,
    limit: metadata.take,
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { additional_data, ...rest } = req.validatedBody as {
    additional_data?: Record<string, unknown>;
  };
  const createPromotions = createPromotionsWorkflow(req.scope);
  const promotionsData = [rest];
  const { result } = await createPromotions.run({
    input: { promotionsData, additional_data },
  });

  const marketId = extractPromotionMarketId(additional_data);

  if (marketId !== undefined) {
    await updatePromotionMarketMetadata(req.scope, result[0].id, marketId);
  }

  const promotion = await refetchPromotionWithMetadata(
    result[0].id,
    req.scope,
    req.queryConfig.fields
  );

  res.status(200).json({ promotion });
}