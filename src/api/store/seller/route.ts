import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "knex";
import { marketContextStorage } from "../../../lib/market-context";
import { listSellerIdsForSalesChannel } from "../../../lib/seller-market-scope";

type QueryGraphResult = {
  data: Array<Record<string, unknown>>;
};

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const salesChannelId = marketContextStorage.getStore()?.sales_channel_id;
  const offset = req.queryConfig.pagination?.skip ?? 0;
  const limit = req.queryConfig.pagination?.take ?? 50;

  if (!salesChannelId) {
    res.json({
      sellers: [],
      count: 0,
      offset,
      limit,
    });
    return;
  }

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex;
  const { sellerIds, count } = await listSellerIdsForSalesChannel(
    db,
    salesChannelId,
    offset,
    limit
  );

  if (!sellerIds.length) {
    res.json({
      sellers: [],
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
  const { data: sellers } = await query.graph({
    entity: "seller",
    fields,
    filters: {
      id: sellerIds,
    },
  });

  const sellersById = new Map(
    sellers.map((seller) => [String(seller.id), seller])
  );

  res.json({
    sellers: sellerIds
      .map((sellerId) => sellersById.get(sellerId))
      .filter(Boolean),
    count,
    offset,
    limit,
  });
}