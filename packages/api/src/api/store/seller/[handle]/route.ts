import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  ContainerRegistrationKeys,
  MedusaError,
} from "@medusajs/framework/utils";
import type { Knex } from "knex";
import { marketContextStorage } from "../../../../lib/market-context";
import { getSellerIdByHandleForSalesChannel } from "../../../../lib/seller-market-scope";

type SocialLinks = {
  instagram?: string | null;
  facebook?: string | null;
  website?: string | null;
  tiktok?: string | null;
};

type GalleryItem = {
  url: string;
  alt?: string | null;
  is_primary?: boolean;
};

type OpeningHours = Record<string, string | null>;

type SellerLocation = {
  location_id?: string;
  city: string;
  address?: string;
  postal_code?: string;
  country_code: string;
  region?: string;
};

type GpMetadata = {
  social_links?: SocialLinks | null;
  locations?: SellerLocation[];
  gallery?: GalleryItem[];
  opening_hours?: OpeningHours | null;
  seeded_fields?: string[];
};

type SellerProfileResponse = {
  id: string;
  name: string;
  handle: string;
  description: string | null;
  photo: string | null;
  social_links: SocialLinks | null;
  locations: SellerLocation[];
  gallery: GalleryItem[];
  opening_hours: OpeningHours | null;
};

type QueryGraphResult = {
  data: Array<Record<string, unknown>>;
};

const SELLER_PROFILE_FIELDS = [
  "id",
  "name",
  "handle",
  "description",
  "photo",
  "metadata",
] as const;

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

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (input: Record<string, unknown>) => Promise<QueryGraphResult>;
  };
  const {
    data: [rawSeller],
  } = await query.graph({
    entity: "seller",
    fields: [...SELLER_PROFILE_FIELDS],
    filters: {
      id: sellerId,
    },
  });

  if (!rawSeller) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Seller with handle: ${req.params.handle} was not found`
    );
  }

  const gp = (
    (rawSeller.metadata as Record<string, unknown>)?.gp ?? {}
  ) as GpMetadata;

  const seller: SellerProfileResponse = {
    id: rawSeller.id as string,
    name: (rawSeller.name as string) ?? "",
    handle: (rawSeller.handle as string) ?? "",
    description: (rawSeller.description as string | null) ?? null,
    photo: (rawSeller.photo as string | null) ?? null,
    social_links: gp.social_links ?? null,
    locations: gp.locations ?? [],
    gallery: gp.gallery ?? [],
    opening_hours: gp.opening_hours ?? null,
  };

  res.json({ seller });
}
