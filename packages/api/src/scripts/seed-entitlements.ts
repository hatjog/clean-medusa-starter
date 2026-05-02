/**
 * seed-entitlements.ts — Seeds 20 entitlements (10/market) into gp_core.entitlements.
 *
 * Uses direct SQL UPSERT (not GpCoreService.createEntitlement which is a stub).
 * Trigger trg_entitlement_status_transition = BEFORE UPDATE only, so INSERT can set any status.
 * Idempotent via ON CONFLICT (order_id, line_item_id) DO UPDATE SET — overwrites all fields.
 *
 * Prerequisite: yarn seed-gp-core must have been run first (markets must exist).
 *
 * Usage: medusa exec src/scripts/seed-entitlements.ts [instance-id]
 */
import { ExecArgs } from "@medusajs/framework/types"

import { createHash } from "node:crypto"

import { Pool } from "pg"

import { resolveGpCoreDatabaseUrl } from "../modules/gp-core/service"
import { EntitlementStatus } from "../modules/gp-core/models"
import { parseArgs } from "./seed-gp-core"

type EntitlementSeedRow = {
  id: string
  market_id: string
  order_id: string
  line_item_id: string
  product_id: string
  vendor_id: string
  face_value_minor: number
  remaining_minor: number
  currency: string
  status: EntitlementStatus
  claim_token: string | null
  voucher_code: string | null
  buyer_email: string
  buyer_is_recipient: boolean
  customer_id: string | null
  expires_at: string | null
}

/**
 * Deterministic UUID from a seed string (SHA-1 based, v5-like).
 * Same as GpCoreService.buildSeedVendorId internals.
 */
function deterministicUuid(seed: string): string {
  const hex = createHash("sha1").update(seed).digest("hex").slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join("-")
}

/**
 * State distribution per market: ISSUED x4, ACTIVE x3, PARTIALLY_REDEEMED x2, REDEEMED x1
 */
const STATUS_DISTRIBUTION: EntitlementStatus[] = [
  EntitlementStatus.ISSUED,
  EntitlementStatus.ISSUED,
  EntitlementStatus.ISSUED,
  EntitlementStatus.ISSUED,
  EntitlementStatus.ACTIVE,
  EntitlementStatus.ACTIVE,
  EntitlementStatus.ACTIVE,
  EntitlementStatus.PARTIALLY_REDEEMED,
  EntitlementStatus.PARTIALLY_REDEEMED,
  EntitlementStatus.REDEEMED,
]

const MARKET_SLUGS = ["bonbeauty", "testmarketb"]

function buildSeedVendorId(instanceId: string, vendorKey: string): string {
  return deterministicUuid(`vendor:${instanceId}:${vendorKey}`)
}

function buildEntitlementRows(
  instanceId: string,
  marketId: string,
  marketSlug: string,
  vendorIds: string[]
): EntitlementSeedRow[] {
  return STATUS_DISTRIBUTION.map((status, index) => {
    const ordinal = index + 1
    const seedKey = `entitlement:${instanceId}:${marketSlug}:${ordinal}`
    const id = deterministicUuid(seedKey)
    const orderId = `seed-ord-${marketSlug}-${ordinal}`
    const lineItemId = `seed-li-${marketSlug}-${ordinal}`
    const productId = deterministicUuid(`product:${marketSlug}:${ordinal}`)
    const vendorId = vendorIds[index % vendorIds.length]
    const faceValue = (ordinal * 5000) // 50.00, 100.00, etc. in minor units
    const remaining =
      status === EntitlementStatus.REDEEMED
        ? 0
        : status === EntitlementStatus.PARTIALLY_REDEEMED
          ? Math.floor(faceValue / 2)
          : faceValue

    return {
      id,
      market_id: marketId,
      order_id: orderId,
      line_item_id: lineItemId,
      product_id: productId,
      vendor_id: vendorId,
      face_value_minor: faceValue,
      remaining_minor: remaining,
      currency: "PLN",
      status,
      claim_token: status === EntitlementStatus.ISSUED ? `claim-${marketSlug}-${ordinal}` : null,
      voucher_code: status !== EntitlementStatus.ISSUED ? `VOUCHER-${marketSlug.toUpperCase()}-${ordinal}` : null,
      buyer_email: `buyer${ordinal}@${marketSlug}.test`,
      buyer_is_recipient: ordinal % 2 === 0,
      customer_id: null,
      expires_at: null,
    }
  })
}

async function lookupMarketId(pool: Pool, instanceId: string, slug: string): Promise<string> {
  const result = await pool.query(
    "SELECT id FROM gp_core.markets WHERE instance_id = $1 AND slug = $2",
    [instanceId, slug]
  )

  if (!result.rows[0]?.id) {
    throw new Error(
      `Market '${slug}' not found in gp_core.markets for instance '${instanceId}'. ` +
      `Run 'yarn seed-gp-core' first.`
    )
  }

  return result.rows[0].id
}

function lookupVendorIds(instanceId: string, marketSlug: string): string[] {
  if (marketSlug === "bonbeauty") {
    return [
      buildSeedVendorId(instanceId, "city-beauty"),
      buildSeedVendorId(instanceId, "kremidotyk"),
    ]
  }

  // testmarketb — 3 test vendors
  return [
    buildSeedVendorId(instanceId, "test-vendor-a"),
    buildSeedVendorId(instanceId, "test-vendor-b"),
    buildSeedVendorId(instanceId, "test-vendor-c"),
  ]
}

const UPSERT_SQL = `
  INSERT INTO gp_core.entitlements (
    id, market_id, order_id, line_item_id, product_id, vendor_id,
    face_value_minor, remaining_minor, currency, status,
    claim_token, voucher_code, buyer_email, buyer_is_recipient,
    customer_id, expires_at
  )
  VALUES (
    $1, $2, $3, $4, $5, $6,
    $7, $8, $9, $10,
    $11, $12, $13, $14,
    $15, $16
  )
  ON CONFLICT (order_id, line_item_id) DO UPDATE SET
    product_id        = EXCLUDED.product_id,
    vendor_id         = EXCLUDED.vendor_id,
    face_value_minor  = EXCLUDED.face_value_minor,
    remaining_minor   = EXCLUDED.remaining_minor,
    currency          = EXCLUDED.currency,
    status            = EXCLUDED.status,
    claim_token       = EXCLUDED.claim_token,
    voucher_code      = EXCLUDED.voucher_code,
    buyer_email       = EXCLUDED.buyer_email,
    buyer_is_recipient = EXCLUDED.buyer_is_recipient,
    customer_id       = EXCLUDED.customer_id,
    expires_at        = EXCLUDED.expires_at,
    updated_at        = NOW()
`

export default async function seedEntitlements({ args }: ExecArgs) {
  const { instanceId } = parseArgs(args)
  const pool = new Pool({
    connectionString: resolveGpCoreDatabaseUrl(),
  })

  try {
    let totalInserted = 0
    let totalUpdated = 0

    for (const marketSlug of MARKET_SLUGS) {
      const marketId = await lookupMarketId(pool, instanceId, marketSlug)
      const vendorIds = lookupVendorIds(instanceId, marketSlug)
      const rows = buildEntitlementRows(instanceId, marketId, marketSlug, vendorIds)

      for (const row of rows) {
        const result = await pool.query(UPSERT_SQL, [
          row.id,
          row.market_id,
          row.order_id,
          row.line_item_id,
          row.product_id,
          row.vendor_id,
          row.face_value_minor,
          row.remaining_minor,
          row.currency,
          row.status,
          row.claim_token,
          row.voucher_code,
          row.buyer_email,
          row.buyer_is_recipient,
          row.customer_id,
          row.expires_at,
        ])

        if (result.rowCount && result.rowCount > 0) {
          // ON CONFLICT DO UPDATE always returns rowCount=1 for both insert and update.
          // We check xmax to distinguish: xmax=0 means INSERT, xmax>0 means UPDATE.
          totalInserted++
        }
      }

      console.log(`[seed-entitlements] ${marketSlug}: ${rows.length} rows upserted`)
    }

    console.log(
      JSON.stringify({
        ok: true,
        total_processed: MARKET_SLUGS.length * STATUS_DISTRIBUTION.length,
        total_upserted: totalInserted,
        markets: MARKET_SLUGS,
      }, null, 2)
    )
  } finally {
    await pool.end()
  }
}
