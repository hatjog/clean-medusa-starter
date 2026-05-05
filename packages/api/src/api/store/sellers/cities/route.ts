import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "knex";
import { marketContextStorage } from "../../../../lib/market-context";
import { listSellerIdsForSalesChannel } from "../../../../lib/seller-market-scope";

type QueryGraphResult = {
  data: Array<Record<string, unknown>>;
};

type SellerLocation = {
  city?: string | null;
};

type SellerMetadata = {
  gp?: {
    locations?: SellerLocation[];
  };
};

const SELLER_CITY_FIELDS = ["id", "metadata"] as const;

/**
 * GET /store/sellers/cities
 *
 * Returns distinct seller cities scoped to the current sales channel.
 * Mercur 2 dropped seller.city, so the canonical source is seller metadata
 * seeded from gp-config vendor locations.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const salesChannelId = marketContextStorage.getStore()?.sales_channel_id;

  if (!salesChannelId) {
    res.json({ cities: [] });
    return;
  }

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex;
  const { sellerIds } = await listSellerIdsForSalesChannel(db, salesChannelId, 0, 500);

  if (!sellerIds.length) {
    res.json({ cities: [] });
    return;
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (input: Record<string, unknown>) => Promise<QueryGraphResult>;
  };
  const { data: sellers } = await query.graph({
    entity: "seller",
    fields: [...SELLER_CITY_FIELDS],
    filters: {
      id: sellerIds,
    },
  });

  const seen = new Set<string>();
  const cities: string[] = [];

  for (const seller of sellers) {
    const metadata = (seller.metadata ?? {}) as SellerMetadata;
    const locations = metadata.gp?.locations ?? [];

    for (const location of locations) {
      const city = location.city?.trim();
      if (!city) {
        continue;
      }

      const normalized = city.toLocaleLowerCase("pl-PL");
      if (seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      cities.push(city);
    }
  }

  cities.sort((left, right) => left.localeCompare(right, "pl-PL"));

  res.json({ cities });
}
