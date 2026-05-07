import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createOrderWorkflow } from "@medusajs/core-flows"
import { refreshOrderCommissionLinesWorkflow } from "@mercurjs/core/workflows"
import { Knex } from "knex"

type ProductCandidate = {
  product_id: string
  seller_id: string
  seller_handle: string
  product_title: string
  variant_id: string
  variant_title: string | null
}

type CommissionCountRow = {
  count?: string | number
  rows?: string | number
}

type CommissionLineRow = Record<string, unknown>

async function ensureSmokeCommissionRate(db: Knex, currencyCode: string): Promise<void> {
  const payload = {
    is_enabled: true,
    priority: 0,
    currency_code: currencyCode,
    name: "GP commission smoke default",
    code: "gp_commission_smoke_default",
    type: "percentage",
    target: "item",
    value: 15,
    min_amount: null,
    include_tax: false,
    raw_value: JSON.stringify({ value: "15", precision: 20 }),
    raw_min_amount: null,
    deleted_at: null,
  }

  const existing = await db("commission_rate")
    .select("id")
    .where({ code: payload.code })
    .first()

  if (existing?.id) {
    await db("commission_rate")
      .where({ id: existing.id })
      .update({
        ...payload,
        updated_at: db.fn.now(),
      })
    return
  }

  await db("commission_rate").insert({
    id: "comrate_gp_commission_smoke_default",
    ...payload,
  })
}

function readCount(rows: unknown): number {
  if (!Array.isArray(rows)) {
    return 0
  }
  const row = rows?.[0]
  const value = row?.count ?? row?.rows ?? 0
  return Number(value)
}

async function selectProductCandidates(db: Knex): Promise<ProductCandidate[]> {
  const result = await db.raw(`
    with ranked_products as (
      select
        pps.product_id,
        pps.seller_id,
        s.handle as seller_handle,
        p.title as product_title,
        pv.id as variant_id,
        pv.title as variant_title,
        row_number() over (partition by pps.seller_id order by p.created_at asc, pv.created_at asc) as seller_rank
      from product_product_seller_seller pps
      join seller s on s.id = pps.seller_id
      join product p on p.id = pps.product_id
      join product_variant pv on pv.product_id = p.id
      where s.deleted_at is null
        and p.deleted_at is null
        and pv.deleted_at is null
    )
    select product_id, seller_id, seller_handle, product_title, variant_id, variant_title
    from ranked_products
    where seller_rank = 1
    order by seller_handle asc
    limit 2
  `)

  return result.rows as ProductCandidate[]
}

function extractRows<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[]
  }

  return []
}

export default async function commissionSmoke({ container }: ExecArgs) {
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex

  const salesChannel = await db("sales_channel")
    .select("id", "name")
    .where({ name: "bonbeauty" })
    .first()

  if (!salesChannel) {
    throw new Error("bonbeauty sales channel not found")
  }

  const region = await db("region")
    .select("id", "currency_code")
    .where({ currency_code: "pln" })
    .first()

  if (!region) {
    throw new Error("pln region not found")
  }

  const candidates = await selectProductCandidates(db)

  if (candidates.length === 0) {
    throw new Error("No seller-linked product variants found for commission smoke")
  }

  await ensureSmokeCommissionRate(db, region.currency_code)

  const beforeCountResult = await db<CommissionCountRow>("commission_line").count("* as count")
  const beforeCount = readCount(beforeCountResult)

  const orderItems = candidates.map((candidate, index) => ({
    title: candidate.product_title,
    quantity: 1,
    product_id: candidate.product_id,
    product_title: candidate.product_title,
    variant_id: candidate.variant_id,
    variant_title: candidate.variant_title ?? "Default",
    unit_price: 10000 + index * 5000,
    metadata: {
      story: "v160-1-10",
      smoke: "commission-smoke",
      seller_id: candidate.seller_id,
      seller_handle: candidate.seller_handle,
    },
  }))

  const createdOrderRun = await createOrderWorkflow(container).run({
    input: {
      region_id: region.id,
      sales_channel_id: salesChannel.id,
      status: "pending",
      email: "commission-smoke@gp.local",
      currency_code: region.currency_code,
      no_notification: true,
      shipping_address: {
        first_name: "Commission",
        last_name: "Smoke",
        address_1: "Ul. Testowa 1",
        city: "Warszawa",
        country_code: "pl",
        postal_code: "00-001",
      },
      billing_address: {
        first_name: "Commission",
        last_name: "Smoke",
        address_1: "Ul. Testowa 1",
        city: "Warszawa",
        country_code: "pl",
        postal_code: "00-001",
      },
      items: orderItems,
      metadata: {
        story: "v160-1-10",
        smoke: "commission-smoke",
      },
    },
  })

  if (createdOrderRun.errors?.length) {
    throw new Error(`createOrderWorkflow failed: ${JSON.stringify(createdOrderRun.errors)}`)
  }

  const order = createdOrderRun.result

  if (!order?.id) {
    throw new Error("createOrderWorkflow returned no order id")
  }

  const refreshRun = await refreshOrderCommissionLinesWorkflow(container).run({
    input: {
      order_ids: [order.id],
    },
  })

  if (refreshRun.errors?.length) {
    throw new Error(`refreshOrderCommissionLinesWorkflow failed: ${JSON.stringify(refreshRun.errors)}`)
  }

  const lineIdColumnResult = await db.raw(`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'commission_line'
    order by ordinal_position
  `)
  const lineColumns = new Set(extractRows<{ column_name: string }>(lineIdColumnResult.rows).map((row) => row.column_name))

  const orderItemRows = await db("order_item")
    .select("id", "item_id")
    .where({ order_id: order.id })
    .orderBy("created_at", "asc")

  const trackedIds = lineColumns.has("item_line_id")
    ? orderItemRows.map((row) => row.id)
    : orderItemRows.map((row) => row.item_id)

  const commissionLineKey = lineColumns.has("item_line_id") ? "item_line_id" : "item_id"
  const commissionLines = trackedIds.length === 0
    ? []
    : await db<CommissionLineRow>("commission_line")
        .select("*")
        .whereIn(commissionLineKey, trackedIds)
        .orderBy("created_at", "asc")

  const afterCountResult = await db<CommissionCountRow>("commission_line").count("* as count")
  const afterCount = readCount(afterCountResult)

  if (afterCount <= beforeCount || commissionLines.length === 0) {
    throw new Error(
      `Commission smoke did not create commission_line rows. before=${beforeCount} after=${afterCount} trackedIds=${JSON.stringify(trackedIds)}`,
    )
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        order_id: order.id,
        seller_handles: candidates.map((candidate) => candidate.seller_handle),
        before_commission_line_count: beforeCount,
        after_commission_line_count: afterCount,
        commission_line_key: commissionLineKey,
        commission_lines: commissionLines,
      },
      null,
      2,
    ),
  )
}
