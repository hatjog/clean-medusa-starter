import { ContainerRegistrationKeys, remoteQueryObjectFromString } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/types";
import { attachPromotionMetadata } from "../../../lib/promotion-market-metadata";

export async function refetchPromotionWithMetadata(
  promotionId: string,
  scope: MedusaContainer,
  fields: string[]
) {
  const remoteQuery = scope.resolve(ContainerRegistrationKeys.REMOTE_QUERY) as (
    input: Record<string, unknown>
  ) => Promise<Array<Record<string, unknown>>>;
  const queryObject = remoteQueryObjectFromString({
    entryPoint: "promotion",
    variables: {
      filters: { id: promotionId },
    },
    fields,
  });
  const [promotion] = await remoteQuery(queryObject);

  if (!promotion || typeof promotion.id !== "string") {
    return promotion;
  }

  return attachPromotionMetadata(scope, promotion as Record<string, unknown> & { id: string });
}