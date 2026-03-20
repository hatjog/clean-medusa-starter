/**
 * Admin vendor management routes (Story 8.2).
 *
 * GET  /v1/admin/vendors       — list all vendors (optionally filtered by market_id)
 * POST /v1/admin/vendors       — create a new vendor + assign to market
 *
 * Protected by withOperatorAuth — admin session required.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { withOperatorAuth } from "../../../../middlewares/with-operator-auth"
import GpCoreService from "../../../../modules/gp-core/service"

function getGpCoreService(req: MedusaRequest): GpCoreService {
  return req.scope.resolve("gpCoreService") as GpCoreService
}

export const GET = withOperatorAuth(async (req, res) => {
  const gpCore = getGpCoreService(req)
  const marketId = req.query.market_id as string | undefined

  if (marketId) {
    const vendors = await gpCore.listVendors(marketId)
    res.json({ data: { vendors } })
    return
  }

  // Without market filter, list all markets then aggregate vendors
  const markets = await gpCore.listMarkets()
  const allVendors: Array<{
    id: string
    instance_id: string
    name: string
    status: string
    created_at: Date | string
    updated_at: Date | string
    market_id?: string
    market_name?: string
  }> = []

  for (const market of markets) {
    const vendors = await gpCore.listVendors(market.id)
    for (const v of vendors) {
      allVendors.push({
        ...v,
        market_id: market.id,
        market_name: market.name,
      })
    }
  }

  res.json({ data: { vendors: allVendors } })
})

export const POST = withOperatorAuth(async (req, res) => {
  const gpCore = getGpCoreService(req)
  const body = req.body as {
    name: string
    instance_id: string
    market_id: string
    status?: string
  }

  if (!body.name || !body.instance_id || !body.market_id) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "name, instance_id, and market_id are required",
      },
    })
    return
  }

  const vendor = await gpCore.createVendor({
    name: body.name,
    instance_id: body.instance_id,
    status: body.status ?? "onboarded",
  })

  await gpCore.assignVendorToMarket({
    instance_id: body.instance_id,
    vendor_id: vendor.id,
    market_id: body.market_id,
    status: "active",
  })

  res.status(201).json({ data: { vendor } })
})
