import { updateRegionsWorkflow } from "@medusajs/core-flows"
import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import fs from "node:fs/promises"
import path from "node:path"

import * as yaml from "js-yaml"

import { parseDryRunFlag } from "./gp-sync-dry-run"

type MarketRuntimeConfig = {
  currency?: string
  countries?: string[]
  payments?: {
    psp_provider_id?: string | null
  }
}

type ParsedArgs = {
  instanceId: string
  marketId: string
  configRoot: string
  dryRun: boolean
}

type RegionRow = {
  id: string
  name: string
  currency_code: string
  country_codes: string[]
}

type PaymentProviderResolution = {
  providerId: string
  fallbackApplied: boolean
  warning?: string
}

export function parseArgs(args: string[] | undefined): ParsedArgs {
  const instanceId = (args?.[0] ?? process.env.GP_INSTANCE_ID ?? "gp-dev").trim()
  const marketId = (args?.[1] ?? process.env.GP_MARKET_ID ?? "bonbeauty").trim()
  const configRoot = (
    process.env.GP_CONFIG_ROOT ?? path.resolve(process.cwd(), "../config")
  ).trim()
  const dryRun = parseDryRunFlag(args)

  if (!instanceId) throw new Error("instanceId is required (args[0] or GP_INSTANCE_ID)")
  if (!marketId) throw new Error("marketId is required (args[1] or GP_MARKET_ID)")
  if (!configRoot) throw new Error("configRoot is required (GP_CONFIG_ROOT)")

  return { instanceId, marketId, configRoot, dryRun }
}

function normalizeCurrencyCode(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase()
}

function normalizeCountryCode(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase()
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

async function readYamlFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8")
  const doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA })

  if (!doc || typeof doc !== "object") {
    throw new Error(`Invalid YAML document: ${filePath}`)
  }

  return doc as T
}

async function loadMarketRuntimeConfig(args: ParsedArgs): Promise<MarketRuntimeConfig> {
  const marketPath = path.resolve(
    args.configRoot,
    args.instanceId,
    "markets",
    args.marketId,
    "market.yaml"
  )

  return readYamlFile<MarketRuntimeConfig>(marketPath)
}

function extractRows<T>(result: any): T[] {
  if (Array.isArray(result?.rows)) return result.rows as T[]
  if (Array.isArray(result)) return result as T[]
  return []
}

export async function listRegionsWithCountries(db: Knex): Promise<RegionRow[]> {
  const result = await db.raw(
    `
      SELECT
        r.id,
        r.name,
        lower(r.currency_code) AS currency_code,
        COALESCE(array_remove(array_agg(DISTINCT lower(rc.iso_2)), NULL), '{}') AS country_codes
      FROM region r
      LEFT JOIN region_country rc
        ON rc.region_id = r.id
       AND rc.deleted_at IS NULL
      WHERE r.deleted_at IS NULL
      GROUP BY r.id, r.name, r.currency_code
      ORDER BY r.name ASC
    `
  )

  return extractRows<RegionRow>(result).map((row) => ({
    ...row,
    country_codes: Array.isArray(row.country_codes)
      ? row.country_codes.map((code) => normalizeCountryCode(String(code)))
      : [],
  }))
}

export function selectRegionForMarket(
  regions: RegionRow[],
  currency: string,
  countries: string[]
): RegionRow {
  const normalizedCurrency = normalizeCurrencyCode(currency)
  const normalizedCountries = uniq(countries.map((country) => normalizeCountryCode(country)))

  const currencyMatches = regions.filter(
    (region) => normalizeCurrencyCode(region.currency_code) === normalizedCurrency
  )

  if (currencyMatches.length === 0) {
    throw new Error(`No region found for currency '${currency}'`)
  }

  if (normalizedCountries.length > 0) {
    const exactCountryMatches = currencyMatches.filter((region) =>
      normalizedCountries.every((country) => region.country_codes.includes(country))
    )

    if (exactCountryMatches.length === 1) {
      return exactCountryMatches[0]
    }

    if (exactCountryMatches.length > 1) {
      throw new Error(
        `Multiple regions found for currency '${currency}' and countries '${normalizedCountries.join(",")}'`
      )
    }
  }

  if (currencyMatches.length === 1) {
    return currencyMatches[0]
  }

  throw new Error(
    `Multiple regions found for currency '${currency}' and no unique country match could be resolved`
  )
}

export async function listEnabledPaymentProviderIds(db: Knex): Promise<string[]> {
  const result = await db.raw(
    `
      SELECT id
      FROM payment_provider
      WHERE deleted_at IS NULL
        AND is_enabled = TRUE
      ORDER BY id ASC
    `
  )

  return extractRows<{ id: string }>(result)
    .map((row) => row.id)
    .filter(Boolean)
}

export function resolvePaymentProviderId(
  configuredProviderId: string,
  availableProviderIds: string[]
): PaymentProviderResolution {
  if (!configuredProviderId.trim()) {
    throw new Error("market.payments.psp_provider_id is required")
  }

  if (availableProviderIds.includes(configuredProviderId)) {
    return { providerId: configuredProviderId, fallbackApplied: false }
  }

  // Naming-drift alias (ADR-100 / medusa-config `id: "stripe"` intent): the
  // market config uses the module-level id `pp_stripe`, but the runtime may
  // register a plugin-/method-suffixed id (e.g. `pp_stripe_stripe`, and the
  // multi-market variants `pp_stripe-blik_stripe` / `pp_stripe-przelewy24_stripe`).
  // When the exact id is absent, alias to an available `pp_stripe<sep>…` provider,
  // preferring the canonical card provider (`<configured>_stripe`), then the
  // shortest candidate. Auditable via fallbackApplied + warning; a truly absent
  // provider still throws (unchanged contract).
  const candidates = availableProviderIds
    .filter((id) => id.startsWith(`${configuredProviderId}_`) || id.startsWith(`${configuredProviderId}-`))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
  if (candidates.length > 0) {
    const canonical = `${configuredProviderId}_stripe`
    const providerId = candidates.includes(canonical) ? canonical : candidates[0]
    return {
      providerId,
      fallbackApplied: true,
      warning:
        `Payment provider '${configuredProviderId}' not enabled verbatim; aliased to '${providerId}' ` +
        `(available: ${availableProviderIds.join(", ")}). Naming-drift tolerated per ADR-100.`,
    }
  }

  const available = availableProviderIds.length > 0 ? availableProviderIds.join(", ") : "none"
  throw new Error(
    `Configured payment provider '${configuredProviderId}' is not enabled in runtime. Available providers: ${available}`
  )
}

async function syncRegionPaymentProviders(container: any, regionId: string, providerId: string) {
  await updateRegionsWorkflow(container).run({
    input: {
      selector: { id: regionId },
      update: {
        payment_providers: [providerId],
      },
    },
  })
}

export default async function gpConfigSyncPayments({ container, args }: ExecArgs) {
  const parsedArgs = parseArgs(args)
  const marketConfig = await loadMarketRuntimeConfig(parsedArgs)
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex

  const configuredProviderId = marketConfig.payments?.psp_provider_id?.trim() ?? ""
  const currency = marketConfig.currency?.trim() ?? ""
  const countries = Array.isArray(marketConfig.countries) ? marketConfig.countries : []

  if (!currency) {
    throw new Error("market.currency is required to resolve region payment providers")
  }

  const [regions, availableProviderIds] = await Promise.all([
    listRegionsWithCountries(db),
    listEnabledPaymentProviderIds(db),
  ])

  const region = selectRegionForMarket(regions, currency, countries)
  const resolution = resolvePaymentProviderId(
    configuredProviderId,
    availableProviderIds
  )

  if (resolution.warning) {
    console.warn(resolution.warning)
  }

  if (parsedArgs.dryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dry_run: true,
          instance_id: parsedArgs.instanceId,
          market_id: parsedArgs.marketId,
          region_id: region.id,
          region_name: region.name,
          configured_provider_id: configuredProviderId,
          effective_provider_id: resolution.providerId,
          fallback_applied: resolution.fallbackApplied,
          available_provider_ids: availableProviderIds,
        },
        null,
        2
      )
    )
    return
  }

  await syncRegionPaymentProviders(container, region.id, resolution.providerId)

  console.log(
    JSON.stringify(
      {
        ok: true,
        instance_id: parsedArgs.instanceId,
        market_id: parsedArgs.marketId,
        region_id: region.id,
        region_name: region.name,
        configured_provider_id: configuredProviderId,
        effective_provider_id: resolution.providerId,
        fallback_applied: resolution.fallbackApplied,
        available_provider_ids: availableProviderIds,
      },
      null,
      2
    )
  )
}