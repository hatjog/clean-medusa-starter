import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "knex";
import { marketContextStorage } from "../../../lib/market-context";

const TAG_GROUP_RE = /^[a-z0-9_-]+$/;

type TagRow = {
  id: string;
  value: string;
};

function buildTagGroupPrefixes(tagGroup: string): string[] {
  return Array.from(
    new Set([
      tagGroup,
      tagGroup.replace(/_/g, "-"),
      tagGroup.replace(/-/g, "_"),
    ])
  )
}

/**
 * GET /store/gp-product-tags
 *
 * Returns distinct product tags scoped to the current sales channel.
 * Optional query param `tag_group` filters by tag group prefix in tag value
 * (for example tag_group=treatment_type returns tags whose value prefix matches).
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const salesChannelId = marketContextStorage.getStore()?.sales_channel_id;

  if (!salesChannelId) {
    res.json({ tags: [], count: 0 });
    return;
  }

  const rawTagGroup =
    typeof req.query.tag_group === "string" ? req.query.tag_group.trim() : undefined;
  if (rawTagGroup !== undefined && !TAG_GROUP_RE.test(rawTagGroup)) {
    res.status(400).json({ error: "Invalid tag_group parameter" });
    return;
  }

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex;

  let query = db<TagRow>("product_tag as pt")
    .distinct("pt.id", "pt.value")
    .innerJoin("product_tags as ptt", "pt.id", "ptt.product_tag_id")
    .innerJoin("product as p", "ptt.product_id", "p.id")
    .innerJoin("product_sales_channel as psc", "p.id", "psc.product_id")
    .where("psc.sales_channel_id", salesChannelId)
    .whereNull("psc.deleted_at")
    .whereNull("p.deleted_at")
    .whereNull("pt.deleted_at")
    .orderBy("pt.value", "asc")
    .select("pt.id", "pt.value");

  if (rawTagGroup) {
    const prefixes = buildTagGroupPrefixes(rawTagGroup)

    query = query.where((builder) => {
      for (const prefix of prefixes) {
        builder.orWhere("pt.value", "like", `${prefix}:%`)
      }
    }) as typeof query;
  }

  const rows = await query;

  const tags = rows.map((row) => ({
    id: row.value,
    value: row.value,
    label: row.value,
  }));

  res.json({ tags, count: tags.length });
}