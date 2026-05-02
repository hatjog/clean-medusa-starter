import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/types";
import type { Knex } from "knex";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getDb(scope: MedusaContainer): Knex {
  return scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex;
}

export function extractPromotionMarketId(
  additionalData: Record<string, unknown> | null | undefined
): string | null | undefined {
  if (
    !additionalData ||
    !Object.prototype.hasOwnProperty.call(additionalData, "gp_market_id")
  ) {
    return undefined;
  }

  const rawValue = additionalData.gp_market_id;

  if (rawValue == null) {
    return null;
  }

  if (typeof rawValue !== "string") {
    return null;
  }

  const trimmed = rawValue.trim();

  return trimmed.length ? trimmed : null;
}

export function readPromotionMarketId(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  const gp = isRecord(metadata?.gp) ? metadata.gp : null;
  const marketId = gp?.market_id;

  return typeof marketId === "string" && marketId.trim().length
    ? marketId.trim()
    : null;
}

export function mergePromotionMarketMetadata(
  metadata: Record<string, unknown> | null | undefined,
  marketId: string | null
): Record<string, unknown> | null {
  const nextMetadata = isRecord(metadata) ? { ...metadata } : {};
  const gpMetadata = isRecord(nextMetadata.gp)
    ? { ...(nextMetadata.gp as JsonRecord) }
    : {};

  if (marketId) {
    gpMetadata.market_id = marketId;
    nextMetadata.gp = gpMetadata;
    return nextMetadata;
  }

  delete gpMetadata.market_id;

  if (Object.keys(gpMetadata).length > 0) {
    nextMetadata.gp = gpMetadata;
  } else {
    delete nextMetadata.gp;
  }

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
}

export async function getPromotionMetadata(
  scope: MedusaContainer,
  promotionId: string
): Promise<Record<string, unknown> | null> {
  const db = getDb(scope);
  const row = await db("promotion")
    .select("metadata")
    .where({ id: promotionId })
    .first<{ metadata: Record<string, unknown> | null }>();

  return row?.metadata ?? null;
}

export async function updatePromotionMarketMetadata(
  scope: MedusaContainer,
  promotionId: string,
  marketId: string | null
): Promise<void> {
  const db = getDb(scope);
  const currentMetadata = await getPromotionMetadata(scope, promotionId);
  const nextMetadata = mergePromotionMarketMetadata(currentMetadata, marketId);

  await db("promotion").where({ id: promotionId }).update({
    metadata: nextMetadata,
    updated_at: db.fn.now(),
  });
}

export async function attachPromotionMetadata<
  T extends Record<string, unknown> & { id: string }
>(
  scope: MedusaContainer,
  promotion: T
): Promise<T & { metadata: Record<string, unknown> | null }> {
  const metadata = await getPromotionMetadata(scope, promotion.id);

  return {
    ...promotion,
    metadata,
  };
}