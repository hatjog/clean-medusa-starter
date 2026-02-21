import { ExecArgs } from "@medusajs/framework/types"

type AnyFn = (...args: any[]) => any

type SalesChannelLike = {
  id?: string
  name?: string
  metadata?: Record<string, unknown> | null
}

function uniqNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)))
}

function parseMarketIds(args: string[] | undefined): string[] {
  if (args?.length) {
    return uniqNonEmpty(args)
  }

  const fromEnv = process.env.GP_MARKETS
  if (fromEnv) {
    return uniqNonEmpty(fromEnv.split(","))
  }

  return ["bonbeauty", "bonevent"]
}

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

function resolveSalesChannelService(container: any): any {
  const keysToTry = [
    "sales_channel",
    "salesChannel",
    "sales-channel",
    "sales_channel_module",
    "salesChannelModuleService",
    "salesChannelService",
  ]

  const errors: string[] = []
  for (const key of keysToTry) {
    try {
      return container.resolve(key)
    } catch (e: any) {
      errors.push(`${key}: ${e?.message ?? String(e)}`)
    }
  }

  throw new Error(
    `Cannot resolve sales channel service. Tried keys: ${keysToTry.join(", ")}. Errors: ${errors.join(
      " | "
    )}`
  )
}

async function listSalesChannels(service: any): Promise<SalesChannelLike[]> {
  const listFn = firstFunction(service, [
    "listAndCountSalesChannels",
    "listSalesChannels",
    "listAndCount",
    "list",
  ])

  if (!listFn) {
    throw new Error(
      "Sales channel service does not expose a supported list method (list*/listAndCount*)"
    )
  }

  const result = await tryCall(listFn, [[{}], [{}, {}], []])

  if (Array.isArray(result) && Array.isArray(result[0])) {
    return result[0]
  }

  return Array.isArray(result) ? result : []
}

async function createSalesChannel(service: any, data: any): Promise<any> {
  const createFn = firstFunction(service, [
    "createSalesChannels",
    "createSalesChannel",
    "create",
  ])

  if (!createFn) {
    throw new Error(
      "Sales channel service does not expose a supported create method (create*)"
    )
  }

  return await tryCall(createFn, [
    [[data]],
    [[data], {}],
    [data],
    [data, {}],
  ])
}

export default async function seed({ container, args }: ExecArgs) {
  const marketIds = parseMarketIds(args)
  const salesChannelService = resolveSalesChannelService(container)

  const existing = await listSalesChannels(salesChannelService)

  const created: string[] = []
  const skipped: string[] = []

  for (const marketId of marketIds) {
    const already = existing.find((ch) => {
      const nameMatch = ch?.name === marketId
      const metaMatch = (ch?.metadata as any)?.gp_market_id === marketId
      return Boolean(nameMatch || metaMatch)
    })

    if (already) {
      skipped.push(marketId)
      continue
    }

    await createSalesChannel(salesChannelService, {
      name: marketId,
      description: `GP market ${marketId}`,
      metadata: {
        gp_market_id: marketId,
        gp_seeded_by: "GP/backend/src/scripts/seed.ts",
      },
    })

    created.push(marketId)
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        market_ids: marketIds,
        created,
        skipped,
      },
      null,
      2
    )
  )
}
