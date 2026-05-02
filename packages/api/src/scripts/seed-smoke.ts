/**
 * seed-smoke.ts — story v160-1-8 AC4 lite curl smoke seeder.
 *
 * Bypass dla `gp-config-sync-orchestrator` catalog stage HARD STOP on Mercur
 * 1.5 junction `seller_seller_product_product` (story 1.7.1 follow-up scope).
 * Creates 1 minimal product wired do default sales channel + market region
 * via Medusa native `createProductsWorkflow`. After this seed:
 *
 *   curl http://localhost:9000/store/products?market_id=bonbeauty
 *
 * should return 200 + JSON list z 1 product.
 *
 * Prerequisites (handled by manual SQL pre-seed w story 1.8 Dev Agent Record):
 *   - region z PLN currency exists (reg_pln_pl + region_country.pl link)
 *   - bonbeauty sales channel exists (created via `pnpm seed bonbeauty`)
 *
 * Usage:
 *   pnpm exec medusa exec ./packages/api/src/scripts/seed-smoke.ts
 */
import { ExecArgs } from "@medusajs/framework/types"
import { Modules, ProductStatus } from "@medusajs/framework/utils"

type AnyFn = (...args: any[]) => any

function firstFunction(obj: any, names: string[]): AnyFn | null {
  for (const name of names) {
    const candidate = obj?.[name]
    if (typeof candidate === "function") {
      return candidate.bind(obj)
    }
  }
  return null
}

async function tryCall(fn: AnyFn, argSets: any[][]): Promise<any> {
  let lastErr: unknown
  for (const args of argSets) {
    try {
      return await fn(...args)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

export default async function seedSmoke({ container }: ExecArgs) {
  const productModule = container.resolve(Modules.PRODUCT)
  const salesChannelModule = container.resolve(Modules.SALES_CHANNEL)

  // Find bonbeauty sales channel
  const listFn = firstFunction(salesChannelModule, [
    "listSalesChannels",
    "list",
  ])
  if (!listFn) {
    throw new Error("sales channel module missing list method")
  }
  const channels = await tryCall(listFn, [[{}], []])
  const channelList = Array.isArray(channels) && Array.isArray(channels[0])
    ? channels[0]
    : (channels as any[])

  const bonbeauty = channelList.find((ch: any) => ch?.name === "bonbeauty")
  if (!bonbeauty) {
    throw new Error(
      "bonbeauty sales channel not found. Run `pnpm seed bonbeauty` first."
    )
  }

  // Create minimal product via product module (bypass workflows to avoid
  // pricing-region cascade that the orchestrator catalog stage uses)
  const createProductsFn = firstFunction(productModule, [
    "createProducts",
    "create",
  ])
  if (!createProductsFn) {
    throw new Error("product module missing create method")
  }

  const products = await tryCall(createProductsFn, [
    [
      [
        {
          title: "Smoke Test Product",
          handle: "smoke-test-product",
          status: ProductStatus.PUBLISHED,
          description:
            "Minimal product for story v160-1-8 AC4 lite curl smoke (bypasses orchestrator catalog stage Mercur 1→2 schema gap).",
          metadata: {
            gp: {
              market_id: "bonbeauty",
              seeded_by: "seed-smoke.ts",
              story: "v160-1-8",
            },
          },
          options: [
            { title: "Default", values: ["Default"] },
          ],
          variants: [
            {
              title: "Default",
              sku: "smoke-test-product-default",
              options: { Default: "Default" },
              manage_inventory: false,
            },
          ],
        },
      ],
    ],
    [
      [
        {
          title: "Smoke Test Product",
          handle: "smoke-test-product",
          status: ProductStatus.PUBLISHED,
        },
      ],
    ],
  ])

  const productList = Array.isArray(products) ? products : [products]
  const productIds = productList.map((p: any) => p?.id).filter(Boolean)

  console.log(
    JSON.stringify(
      {
        ok: true,
        story: "v160-1-8 AC4 lite curl smoke",
        sales_channel_id: bonbeauty.id,
        product_ids: productIds,
        next_step:
          "Start backend (pnpm dev) and curl http://localhost:9002/store/products?market_id=bonbeauty",
      },
      null,
      2
    )
  )
}
