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

// Note: `city` removed — Mercur 2 seller entity has no `city` column.
// TODO(v1.7.0): add address-based city lookup if the UI requires it.
const SELLER_LIST_FIELDS = ["id", "name", "handle", "photo"] as const;

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const salesChannelId = marketContextStorage.getStore()?.sales_channel_id;
  const offset = req.queryConfig?.pagination?.skip ?? 0;
  const requestedLimit =
    typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
  const limit = (req.queryConfig?.pagination?.take ?? requestedLimit) || 50;

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
    graph: (
      input: Record<string, unknown>,
      options?: Record<string, unknown>
    ) => Promise<QueryGraphResult>;
  };
  const { locale } = req;
  const { data: sellers } = await query.graph(
    {
      entity: "seller",
      fields: [...SELLER_LIST_FIELDS],
      filters: {
        id: sellerIds,
      },
    },
    { locale }
  );

  // Note: cast to ProductCountRow[] required — Knex countDistinct generic is single-row but
  // groupBy returns multiple rows.
  const productCountRows = (await db("product_product_seller_seller as ppss")
    .select("ppss.seller_id")
    .countDistinct({ product_count: "ppss.product_id" })
    .innerJoin("product as p", "ppss.product_id", "p.id")
    .innerJoin("product_sales_channel as psc", "p.id", "psc.product_id")
    .where("psc.sales_channel_id", salesChannelId)
    .whereIn("ppss.seller_id", sellerIds)
    .whereNull("p.deleted_at")
    .whereNull("psc.deleted_at")
    .whereNull("ppss.deleted_at")
    .groupBy("ppss.seller_id")) as ProductCountRow[];

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
