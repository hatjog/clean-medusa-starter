import {
  deletePromotionsWorkflow,
  updatePromotionsWorkflow,
} from "@medusajs/core-flows";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  ContainerRegistrationKeys,
  MedusaError,
  remoteQueryObjectFromString,
} from "@medusajs/framework/utils";
import {
  attachPromotionMetadata,
  extractPromotionMarketId,
  updatePromotionMarketMetadata,
} from "../../../../lib/promotion-market-metadata";
import { refetchPromotionWithMetadata } from "../helpers";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const idOrCode = req.params.id;
  const remoteQuery = req.scope.resolve(
    ContainerRegistrationKeys.REMOTE_QUERY
  ) as (
    input: Record<string, unknown>
  ) => Promise<Array<Record<string, unknown>>>;
  const queryObject = remoteQueryObjectFromString({
    entryPoint: "promotion",
    variables: {
      filters: { $or: [{ id: idOrCode }, { code: idOrCode }] },
    },
    fields: req.queryConfig.fields,
  });
  const [promotion] = await remoteQuery(queryObject);

  if (!promotion || typeof promotion.id !== "string") {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Promotion with id or code: ${idOrCode} was not found`
    );
  }

  res.status(200).json({
    promotion: await attachPromotionMetadata(
      req.scope,
      promotion as Record<string, unknown> & { id: string }
    ),
  });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { additional_data, ...rest } = req.validatedBody as {
    additional_data?: Record<string, unknown>;
  };
  const updatePromotions = updatePromotionsWorkflow(req.scope);
  const promotionsData = [
    {
      id: req.params.id,
      ...rest,
    },
  ];

  await updatePromotions.run({
    input: { promotionsData, additional_data },
  });

  const marketId = extractPromotionMarketId(additional_data);

  if (marketId !== undefined) {
    await updatePromotionMarketMetadata(req.scope, req.params.id, marketId);
  }

  const promotion = await refetchPromotionWithMetadata(
    req.params.id,
    req.scope,
    req.queryConfig.fields
  );

  res.status(200).json({ promotion });
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  const id = req.params.id;
  const deletePromotions = deletePromotionsWorkflow(req.scope);

  await deletePromotions.run({
    input: { ids: [id] },
  });

  res.status(200).json({
    id,
    object: "promotion",
    deleted: true,
  });
}