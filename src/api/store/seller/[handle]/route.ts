import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  ContainerRegistrationKeys,
  MedusaError,
} from "@medusajs/framework/utils";
import type { Knex } from "knex";
import { marketContextStorage } from "../../../../lib/market-context";
import { getSellerIdByHandleForSalesChannel } from "../../../../lib/seller-market-scope";

type QueryGraphResult = {
  data: Array<Record<string, unknown>>;
};

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const salesChannelId = marketContextStorage.getStore()?.sales_channel_id;

  if (!salesChannelId) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Seller with handle: ${req.params.handle} was not found`
    );
  }

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex;
  const sellerId = await getSellerIdByHandleForSalesChannel(
    db,
    salesChannelId,
    req.params.handle
  );

  if (!sellerId) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Seller with handle: ${req.params.handle} was not found`
    );
  }

  const fields = req.queryConfig.fields.includes("id")
    ? req.queryConfig.fields
    : [...req.queryConfig.fields, "id"];
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (input: Record<string, unknown>) => Promise<QueryGraphResult>;
  };
  const { data: [seller] } = await query.graph({
    entity: "seller",
    fields,
    filters: {
      id: sellerId,
    },
  });

  if (!seller) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Seller with handle: ${req.params.handle} was not found`
    );
  }

  res.json({ seller });
}