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

type OpeningHourRange = {
  open: string;
  close: string;
};

type OpeningHours = Record<string, OpeningHourRange | null>;

type SeoMetadata = {
  meta_title?: string;
  meta_description?: string;
  og_image_url?: string;
};

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
  photo_url?: string | null;
  gallery?: Array<string | GalleryItem>;
  opening_hours?: OpeningHours | null;
  seo?: SeoMetadata | null;
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
  seo: SeoMetadata | null;
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
  "logo",
  "metadata",
] as const;

function normalizeGallery(
  gallery: GpMetadata["gallery"] | undefined
): GalleryItem[] {
  if (!Array.isArray(gallery)) return [];

  return gallery
    .map((item) => (typeof item === "string" ? { url: item } : item))
    .filter((item): item is GalleryItem => Boolean(item?.url));
}

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
    graph: (
      input: Record<string, unknown>,
      options?: Record<string, unknown>
    ) => Promise<QueryGraphResult>;
  };
  const { locale } = req;
  const {
    data: [rawSeller],
  } = await query.graph(
    {
      entity: "seller",
      fields: [...SELLER_PROFILE_FIELDS],
      filters: {
        id: sellerId,
      },
    },
    { locale }
  );

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
    photo:
      (rawSeller.photo as string | null | undefined) ??
      (rawSeller.logo as string | null | undefined) ??
      gp.photo_url ??
      null,
    social_links: gp.social_links ?? null,
    locations: gp.locations ?? [],
    gallery: normalizeGallery(gp.gallery),
    opening_hours: gp.opening_hours ?? null,
    seo: gp.seo ?? null,
  };

  res.json({ seller });
}
