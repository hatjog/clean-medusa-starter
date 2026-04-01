import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "knex";
import { marketContextStorage } from "../../../lib/market-context";
import { listSellerIdsForSalesChannel } from "../../../lib/seller-market-scope";

type QueryGraphResult = {
  data: Array<Record<string, unknown>>;
};

type ProductCountRow = {
  seller_id: string;
  product_count: string;
};

const SELLER_LIST_FIELDS = ["id", "name", "handle", "photo", "city"] as const;

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

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (input: Record<string, unknown>) => Promise<QueryGraphResult>;
  };
  const { data: sellers } = await query.graph({
    entity: "seller",
    fields: [...SELLER_LIST_FIELDS],
    filters: {
      id: sellerIds,
    },
  });

  const productCountRows = await db<ProductCountRow>("seller_seller_product_product as sspp")
    .select("sspp.seller_id")
    .count<ProductCountRow>({ product_count: "sspp.product_id" })
    .innerJoin("product as p", "sspp.product_id", "p.id")
    .innerJoin("product_sales_channel as psc", "p.id", "psc.product_id")
    .where("psc.sales_channel_id", salesChannelId)
    .whereIn("sspp.seller_id", sellerIds)
    .whereNull("p.deleted_at")
    .whereNull("psc.deleted_at")
    .whereNull("sspp.deleted_at")
    .groupBy("sspp.seller_id");

  const productCountBySellerId = new Map(
    productCountRows.map((row) => [row.seller_id, Number(row.product_count)])
  );

  const sellersById = new Map(
    sellers.map((seller) => [String(seller.id), seller])
  );

  res.json({
    sellers: sellerIds
      .map((sellerId) => {
        const seller = sellersById.get(sellerId);
        if (!seller) return undefined;
        return {
          ...seller,
          product_count: productCountBySellerId.get(sellerId) ?? 0,
        };
      })
      .filter(Boolean),
    count,
    offset,
    limit,
  });
}