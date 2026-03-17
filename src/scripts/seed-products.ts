/**
 * seed-products.ts — Seeds 5 Medusa fixture products across 3 vendors.
 *
 * Separate script (not seed.ts modification) per AC #3.
 * Products distributed: 2 for bonbeauty, 2 for testmarketb, 1 shared.
 * Metadata includes vendor_hint and face_value_minor for downstream testing.
 *
 * Prerequisite: Medusa container must be running (products go into Mercur DB).
 *
 * Usage: medusa exec src/scripts/seed-products.ts [market_ids...]
 */
import { ExecArgs } from "@medusajs/framework/types"

type AnyFn = (...args: any[]) => any

type ProductFixture = {
  title: string
  description: string
  handle: string
  status: "published" | "draft"
  metadata: Record<string, unknown>
  variants: Array<{
    title: string
    sku: string
    prices: Array<{
      amount: number
      currency_code: string
    }>
    metadata: Record<string, unknown>
  }>
}

const PRODUCT_FIXTURES: ProductFixture[] = [
  {
    title: "BonBeauty Voucher 50 PLN",
    description: "Voucher na uslugi beauty — 50 PLN (fixture)",
    handle: "seed-bonbeauty-voucher-50",
    status: "published",
    metadata: {
      gp_vendor_hint: "city-beauty",
      gp_market_id: "bonbeauty",
      gp_face_value_minor: 5000,
      gp_seeded_by: "seed-products.ts",
    },
    variants: [
      {
        title: "Default",
        sku: "SEED-BB-V50",
        prices: [{ amount: 5000, currency_code: "pln" }],
        metadata: { gp_face_value_minor: 5000 },
      },
    ],
  },
  {
    title: "BonBeauty Voucher 100 PLN",
    description: "Voucher na uslugi beauty — 100 PLN (fixture)",
    handle: "seed-bonbeauty-voucher-100",
    status: "published",
    metadata: {
      gp_vendor_hint: "kremidotyk",
      gp_market_id: "bonbeauty",
      gp_face_value_minor: 10000,
      gp_seeded_by: "seed-products.ts",
    },
    variants: [
      {
        title: "Default",
        sku: "SEED-BB-V100",
        prices: [{ amount: 10000, currency_code: "pln" }],
        metadata: { gp_face_value_minor: 10000 },
      },
    ],
  },
  {
    title: "TestMarketB Voucher 75 PLN",
    description: "Voucher testowy — 75 PLN (fixture)",
    handle: "seed-testmarketb-voucher-75",
    status: "published",
    metadata: {
      gp_vendor_hint: "test-vendor-a",
      gp_market_id: "testmarketb",
      gp_face_value_minor: 7500,
      gp_seeded_by: "seed-products.ts",
    },
    variants: [
      {
        title: "Default",
        sku: "SEED-TMB-V75",
        prices: [{ amount: 7500, currency_code: "pln" }],
        metadata: { gp_face_value_minor: 7500 },
      },
    ],
  },
  {
    title: "TestMarketB Voucher 200 PLN",
    description: "Voucher testowy — 200 PLN (fixture)",
    handle: "seed-testmarketb-voucher-200",
    status: "published",
    metadata: {
      gp_vendor_hint: "test-vendor-b",
      gp_market_id: "testmarketb",
      gp_face_value_minor: 20000,
      gp_seeded_by: "seed-products.ts",
    },
    variants: [
      {
        title: "Default",
        sku: "SEED-TMB-V200",
        prices: [{ amount: 20000, currency_code: "pln" }],
        metadata: { gp_face_value_minor: 20000 },
      },
    ],
  },
  {
    title: "Shared Multi-Market Voucher 150 PLN",
    description: "Voucher dostepny w wielu marketach — 150 PLN (fixture)",
    handle: "seed-shared-voucher-150",
    status: "published",
    metadata: {
      gp_vendor_hint: "city-beauty",
      gp_market_id: "shared",
      gp_face_value_minor: 15000,
      gp_seeded_by: "seed-products.ts",
    },
    variants: [
      {
        title: "Default",
        sku: "SEED-SHARED-V150",
        prices: [{ amount: 15000, currency_code: "pln" }],
        metadata: { gp_face_value_minor: 15000 },
      },
    ],
  },
]

function firstFunction(obj: any, names: string[]): AnyFn | null {
  for (const name of names) {
    const candidate = obj?.[name]
    if (typeof candidate === "function") {
      return candidate.bind(obj)
    }
  }
  return null
}

function resolveProductService(container: any): any {
  const keysToTry = [
    "product",
    "productModuleService",
    "productService",
    "product_module",
  ]

  for (const key of keysToTry) {
    try {
      const svc = container.resolve(key)
      if (svc) return svc
    } catch {
      // try next key
    }
  }

  throw new Error(
    `Cannot resolve product service. Tried keys: ${keysToTry.join(", ")}`
  )
}

async function listExistingHandles(service: any): Promise<Set<string>> {
  const listFn = firstFunction(service, [
    "listProducts",
    "listAndCountProducts",
    "list",
    "listAndCount",
  ])

  if (!listFn) {
    return new Set()
  }

  try {
    const result = await listFn({}, { select: ["handle"] })
    const items = Array.isArray(result) && Array.isArray(result[0])
      ? result[0]
      : Array.isArray(result)
        ? result
        : []

    return new Set(items.map((p: any) => p.handle).filter(Boolean))
  } catch {
    return new Set()
  }
}

export default async function seedProducts({ container }: ExecArgs) {
  const productService = resolveProductService(container)
  const existingHandles = await listExistingHandles(productService)

  const createFn = firstFunction(productService, [
    "createProducts",
    "create",
  ])

  if (!createFn) {
    throw new Error("Product service does not expose a create method")
  }

  const created: string[] = []
  const skipped: string[] = []

  for (const fixture of PRODUCT_FIXTURES) {
    if (existingHandles.has(fixture.handle)) {
      skipped.push(fixture.handle)
      continue
    }

    try {
      await createFn([fixture])
      created.push(fixture.handle)
    } catch (error) {
      // If batch create fails, try single
      try {
        await createFn(fixture)
        created.push(fixture.handle)
      } catch (retryError) {
        console.error(
          `[seed-products] Failed to create '${fixture.handle}': ${String(retryError)}`
        )
      }
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      total: PRODUCT_FIXTURES.length,
      created,
      skipped,
    }, null, 2)
  )
}
