import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "knex";
import { marketContextStorage } from "../../../../lib/market-context";

type CityRow = {
  city: string;
};

/**
 * GET /store/sellers/cities
 *
 * Returns distinct seller cities scoped to the current sales channel.
 * Used by LocationFilter to populate city dropdown options.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const salesChannelId = marketContextStorage.getStore()?.sales_channel_id;

  if (!salesChannelId) {
    res.json({ cities: [] });
    return;
  }

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex;

  const rows = await db<CityRow>("seller as s")
    .distinct("s.city")
    .innerJoin(
      "seller_seller_product_product as sspp",
      "s.id",
      "sspp.seller_id"
    )
    .innerJoin("product as p", "sspp.product_id", "p.id")
    .innerJoin(
      "product_sales_channel as psc",
      "p.id",
      "psc.product_id"
    )
    .where("psc.sales_channel_id", salesChannelId)
    .whereNull("psc.deleted_at")
    .whereNotNull("s.city")
    .whereNot("s.city", "")
    .whereNull("s.deleted_at")
    .whereNull("sspp.deleted_at")
    .whereNull("p.deleted_at")
    .orderBy("s.city", "asc")
    .select("s.city");

  // Sanitize output: trim whitespace and strip control characters
  const cities = rows
    .map((row) => row.city.trim().replace(/[\x00-\x1f]/g, ""))
    .filter(Boolean);

  res.json({ cities });
}
