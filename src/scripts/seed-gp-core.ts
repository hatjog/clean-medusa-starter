import { ExecArgs } from "@medusajs/framework/types"

import fs from "node:fs/promises"
import path from "node:path"

import * as yaml from "js-yaml"

import { GP_CORE_MODULE } from "../modules/gp-core"
import GpCoreService from "../modules/gp-core/service"
import type { UpdateMarketInput } from "../modules/gp-core/models"

type InstanceMarketRef = {
  market_id: string
  slug: string
  status?: string
  config_path: string
}

type InstanceConfig = {
  instance_id: string
  markets: InstanceMarketRef[]
}

type MarketVendorConfig = {
  vendor_id: string
  slug: string
  status?: string
  display_name?: string
}

type MarketConfig = {
  market_id: string
  status?: string
  name?: string
  vertical?: string
  vertical_slug?: string
  vendors?: MarketVendorConfig[]
}

type LoadedMarketConfig = {
  ref: InstanceMarketRef
  config: MarketConfig
  filePath: string
}

type MutationCounts = {
  created: number
  updated: number
}

type SeedSummary = {
  instance_id: string
  instance_path: string
  verticals: MutationCounts
  markets: MutationCounts
  vendors: MutationCounts
  assignments: MutationCounts
}

export const DEFAULT_MARKET_VERTICALS: Record<string, string> = {
  bonbeauty: "beauty",
  bonevent: "events",
  mercur: "general",
}

export const DEFAULT_MARKET_NAMES: Record<string, string> = {
  bonbeauty: "BonBeauty",
  bonevent: "BonEvent",
  mercur: "Mercur",
}

export const DEFAULT_VERTICAL_NAMES: Record<string, string> = {
  beauty: "Beauty",
  events: "Events",
  general: "General",
}

export function parseArgs(args: string[] | undefined): {
  instanceId: string
  configRoot: string
} {
  const instanceId = (args?.[0] ?? process.env.GP_INSTANCE_ID ?? "gp-dev").trim()
  const configRoot = (
    process.env.GP_CONFIG_ROOT ?? path.resolve(process.cwd(), "../config")
  ).trim()

  if (!instanceId) {
    throw new Error("instanceId is required (args[0] or GP_INSTANCE_ID)")
  }

  if (!configRoot) {
    throw new Error("configRoot is required (GP_CONFIG_ROOT)")
  }

  return { instanceId, configRoot }
}

export async function readYamlFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8")
  const doc = yaml.load(raw)

  if (!doc || typeof doc !== "object") {
    throw new Error(`Invalid YAML document: ${filePath}`)
  }

  return doc as T
}

function titleize(slug: string): string {
  return slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

export function resolveVerticalSlug(marketRef: InstanceMarketRef, marketConfig: MarketConfig): string {
  return (
    marketConfig.vertical_slug ??
    marketConfig.vertical ??
    DEFAULT_MARKET_VERTICALS[marketConfig.market_id] ??
    DEFAULT_MARKET_VERTICALS[marketRef.market_id] ??
    "general"
  )
}

export function resolveVerticalName(verticalSlug: string): string {
  return DEFAULT_VERTICAL_NAMES[verticalSlug] ?? titleize(verticalSlug)
}

export function resolveMarketName(marketRef: InstanceMarketRef, marketConfig: MarketConfig): string {
  return (
    marketConfig.name ??
    DEFAULT_MARKET_NAMES[marketConfig.market_id] ??
    DEFAULT_MARKET_NAMES[marketRef.market_id] ??
    titleize(marketRef.slug || marketRef.market_id)
  )
}

export async function loadSeedContext(input: {
  instanceId: string
  configRoot: string
}): Promise<{
  instancePath: string
  instanceConfig: InstanceConfig
  markets: LoadedMarketConfig[]
}> {
  const instancePath = path.resolve(input.configRoot, input.instanceId, "instance.yaml")
  const instanceConfig = await readYamlFile<InstanceConfig>(instancePath)

  if (instanceConfig.instance_id !== input.instanceId) {
    throw new Error(
      `instance_id mismatch in ${instancePath}: expected '${input.instanceId}', got '${instanceConfig.instance_id}'`
    )
  }

  const markets: LoadedMarketConfig[] = []
  for (const marketRef of instanceConfig.markets) {
    const filePath = path.resolve(input.configRoot, input.instanceId, marketRef.config_path)
    const config = await readYamlFile<MarketConfig>(filePath)

    if (config.market_id !== marketRef.market_id) {
      throw new Error(
        `market_id mismatch in ${filePath}: expected '${marketRef.market_id}', got '${config.market_id}'`
      )
    }

    markets.push({ ref: marketRef, config, filePath })
  }

  return {
    instancePath,
    instanceConfig,
    markets,
  }
}

export async function seedGpCoreFromFixtures(
  service: GpCoreService,
  input: { instanceId: string; configRoot: string }
): Promise<SeedSummary> {
  const context = await loadSeedContext(input)

  const summary: SeedSummary = {
    instance_id: context.instanceConfig.instance_id,
    instance_path: context.instancePath,
    verticals: { created: 0, updated: 0 },
    markets: { created: 0, updated: 0 },
    vendors: { created: 0, updated: 0 },
    assignments: { created: 0, updated: 0 },
  }

  await service.withTransaction(async (client) => {
    for (const loadedMarket of context.markets) {
      const verticalSlug = resolveVerticalSlug(loadedMarket.ref, loadedMarket.config)
      const verticalName = resolveVerticalName(verticalSlug)
      const existingVertical = await service.getVerticalBySlug(input.instanceId, verticalSlug, client)
      const vertical = await service.upsertVertical(
        {
          instance_id: input.instanceId,
          name: verticalName,
          slug: verticalSlug,
          status: "active",
        },
        client
      )
      summary.verticals[existingVertical ? "updated" : "created"] += 1

      const existingMarket = await service.getMarketBySlug(input.instanceId, loadedMarket.ref.slug, client)
      const salesChannelId = await service.findSalesChannelId(loadedMarket.config.market_id)
      if (!salesChannelId) {
        throw new Error(`Sales channel not found for market '${loadedMarket.config.market_id}'`)
      }

      const payloadVendorId = null // Payload CMS not yet integrated; will be set by 10-7
      const marketInput = {
        instance_id: input.instanceId,
        name: resolveMarketName(loadedMarket.ref, loadedMarket.config),
        slug: loadedMarket.ref.slug,
        vertical_id: vertical.id,
        status: loadedMarket.config.status ?? loadedMarket.ref.status ?? "active",
        sales_channel_id: salesChannelId,
        payload_vendor_id: payloadVendorId,
      }
      const marketUpdate: UpdateMarketInput = {}

      if (existingMarket) {
        if (existingMarket.name !== marketInput.name) {
          marketUpdate.name = marketInput.name
        }

        if (existingMarket.vertical_id !== marketInput.vertical_id) {
          marketUpdate.vertical_id = marketInput.vertical_id
        }

        if (existingMarket.status !== marketInput.status) {
          marketUpdate.status = marketInput.status
        }

        if (existingMarket.sales_channel_id !== marketInput.sales_channel_id) {
          marketUpdate.sales_channel_id = marketInput.sales_channel_id
        }

        if (existingMarket.payload_vendor_id !== marketInput.payload_vendor_id) {
          marketUpdate.payload_vendor_id = marketInput.payload_vendor_id
        }
      }

      const market = existingMarket
        ? Object.keys(marketUpdate).length > 0
          ? await service.updateMarket({ id: existingMarket.id }, marketUpdate, client)
          : existingMarket
        : await service.createMarket(marketInput, client)
      summary.markets[existingMarket ? "updated" : "created"] += 1

      for (const vendorConfig of loadedMarket.config.vendors ?? []) {
        const vendorSeedId = service.buildSeedVendorId(input.instanceId, vendorConfig.vendor_id)
        const existingVendor = await service.getVendor(vendorSeedId, client)

        const vendor = await service.upsertVendor(
          {
            instance_id: input.instanceId,
            vendor_key: vendorConfig.vendor_id,
            name: vendorConfig.display_name ?? titleize(vendorConfig.slug ?? vendorConfig.vendor_id),
            status: vendorConfig.status ?? "onboarded",
          },
          client
        )
        summary.vendors[existingVendor ? "updated" : "created"] += 1

        const existingAssignment = await service.getVendorMarketAssignment(
          input.instanceId,
          vendor.id,
          market.id,
          client
        )
        await service.upsertVendorToMarket(
          {
            instance_id: input.instanceId,
            vendor_id: vendor.id,
            market_id: market.id,
            status: vendorConfig.status === "inactive" ? "inactive" : "active",
          },
          client
        )
        summary.assignments[existingAssignment ? "updated" : "created"] += 1
      }
    }
  })

  return summary
}

export default async function seedGpCore({ container, args }: ExecArgs) {
  const parsed = parseArgs(args)
  const resolved = container.resolve?.(GP_CORE_MODULE) as GpCoreService | undefined
  const service =
    resolved ??
    new GpCoreService(container as Record<string, unknown>, {
      databaseUrl: process.env.GP_CORE_DATABASE_URL,
      mercurDatabaseUrl: process.env.GP_MERCUR_DATABASE_URL,
    })

  try {
    const summary = await seedGpCoreFromFixtures(service, parsed)
    console.log(
      JSON.stringify(
        {
          ok: true,
          ...summary,
        },
        null,
        2
      )
    )
  } finally {
    await service.dispose()
  }
}