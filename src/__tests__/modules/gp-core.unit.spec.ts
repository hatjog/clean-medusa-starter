import fs from "node:fs/promises"
import path from "node:path"

import { Pool } from "pg"

import GpCoreService from "../../modules/gp-core/service"
import {
  DEFAULT_MARKET_VERTICALS,
  parseArgs,
  seedGpCoreFromFixtures,
} from "../../scripts/seed-gp-core"

const BACKEND_ROOT = path.resolve(__dirname, "../../../")
const REPO_ROOT = path.resolve(BACKEND_ROOT, "../..")
const CONFIG_ROOT = path.resolve(BACKEND_ROOT, "../config")
const SQL_PATH = path.resolve(REPO_ROOT, "infra/postgres/init/02-gp-core-tables.sql")

function replaceDatabaseName(databaseUrl: string, databaseName: string): string {
  const parsed = new URL(databaseUrl)
  parsed.pathname = `/${databaseName}`
  return parsed.toString()
}

const BASE_DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/gp_mercur"
const TEST_DATABASE_URL = replaceDatabaseName(BASE_DATABASE_URL, "gp_core_test")
const ADMIN_DATABASE_URL = replaceDatabaseName(BASE_DATABASE_URL, "postgres")

let adminPool: Pool
let testPool: Pool
let service: GpCoreService
const eventBus = {
  emit: async (_message: unknown) => undefined,
}

async function ensureTestDatabase() {
  const existing = await adminPool.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname = $1",
    ["gp_core_test"]
  )

  if (existing.rowCount === 0) {
    await adminPool.query("CREATE DATABASE gp_core_test")
  }
}

async function readSqlFile(): Promise<string> {
  const raw = await fs.readFile(SQL_PATH, "utf8")
  return raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("\\connect"))
    .join("\n")
}

async function resetDatabase() {
  await testPool.query("DROP SCHEMA IF EXISTS gp_core CASCADE")
  await testPool.query("DROP TABLE IF EXISTS public.sales_channel")

  const sql = await readSqlFile()
  await testPool.query(sql)

  await testPool.query(`
    CREATE TABLE public.sales_channel (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb
    )
  `)

  await testPool.query(
    `
      INSERT INTO public.sales_channel (id, name, metadata)
      VALUES
        ('gp-core-test-sc-bonbeauty', 'BonBeauty Channel', '{"gp_market_id":"bonbeauty"}'::jsonb),
        ('gp-core-test-sc-bonevent', 'BonEvent Channel', '{"gp_market_id":"bonevent"}'::jsonb),
        ('gp-core-test-sc-mercur', 'Default Sales Channel', '{}'::jsonb)
    `
  )
}

describe("gp_core schema and service", () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: ADMIN_DATABASE_URL })
    await ensureTestDatabase()

    testPool = new Pool({ connectionString: TEST_DATABASE_URL })
    service = new GpCoreService(
      {
        event_bus: eventBus,
      },
      {
        databaseUrl: TEST_DATABASE_URL,
        mercurDatabaseUrl: TEST_DATABASE_URL,
      }
    )
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  afterAll(async () => {
    await service.dispose()
    await Promise.allSettled([testPool.end(), adminPool.end()])
  })

  it("parseArgs defaults to gp-dev and backend-adjacent config root", () => {
    const result = parseArgs(undefined)
    expect(result.instanceId).toBe("gp-dev")
    expect(result.configRoot).toContain("config")
  })

  it("creates the gp_core tables and named indexes", async () => {
    const tables = await testPool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'gp_core'
      ORDER BY table_name
    `)

    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "markets",
      "vendor_market_assignments",
      "vendors",
      "verticals",
    ])

    const indexes = await testPool.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'gp_core'
      ORDER BY indexname
    `)

    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining(["uq_markets_instance_slug", "uq_vma_instance_vendor_market"])
    )
  })

  it("seed creates 4 markets, 3 verticals and 8 assignments", async () => {
    const summary = await seedGpCoreFromFixtures(service, {
      instanceId: "gp-dev",
      configRoot: CONFIG_ROOT,
    })

    expect(summary.markets.created).toBe(4)
    expect(summary.verticals.created).toBe(3)
    expect(summary.assignments.created).toBe(8)

    const markets = await service.listMarkets("gp-dev")
    const verticals = await service.listVerticals("gp-dev")

    expect(markets).toHaveLength(4)
    expect(verticals).toHaveLength(3)
    expect(verticals.map((vertical) => vertical.slug).sort()).toEqual(
      Object.values(DEFAULT_MARKET_VERTICALS).sort()
    )
  })

  it("seed is idempotent across two runs", async () => {
    const first = await seedGpCoreFromFixtures(service, {
      instanceId: "gp-dev",
      configRoot: CONFIG_ROOT,
    })
    const second = await seedGpCoreFromFixtures(service, {
      instanceId: "gp-dev",
      configRoot: CONFIG_ROOT,
    })

    expect(first.markets.created).toBe(4)
    expect(second.markets.created).toBe(0)
    expect(second.markets.updated).toBe(4)
    expect(second.verticals.updated).toBe(4)

    const counts = await testPool.query(`
      SELECT
        (SELECT COUNT(*) FROM gp_core.markets) AS markets,
        (SELECT COUNT(*) FROM gp_core.verticals) AS verticals,
        (SELECT COUNT(*) FROM gp_core.vendors) AS vendors,
        (SELECT COUNT(*) FROM gp_core.vendor_market_assignments) AS assignments
    `)

    expect(counts.rows[0]).toMatchObject({
      markets: "4",
      verticals: "3",
      vendors: "8",
      assignments: "8",
    })
  })

  it("createMarket rejects duplicate slug within one instance", async () => {
    const vertical = await service.createVertical({
      instance_id: "gp-dev",
      name: "Beauty",
      slug: "beauty",
    })

    await service.createMarket({
      instance_id: "gp-dev",
      name: "BonBeauty",
      slug: "bonbeauty",
      vertical_id: vertical.id,
    })

    await expect(
      service.createMarket({
        instance_id: "gp-dev",
        name: "BonBeauty Duplicate",
        slug: "bonbeauty",
        vertical_id: vertical.id,
      })
    ).rejects.toThrow(/duplicate key value/i)
  })

  it("assignVendorToMarket creates a vendor_market_assignments row", async () => {
    const vertical = await service.createVertical({
      instance_id: "gp-dev",
      name: "Beauty",
      slug: "beauty",
    })
    const market = await service.createMarket({
      instance_id: "gp-dev",
      name: "BonBeauty",
      slug: "bonbeauty",
      vertical_id: vertical.id,
    })
    const vendor = await service.createVendor({
      instance_id: "gp-dev",
      name: "Studio Nova",
    })

    const assignment = await service.assignVendorToMarket({
      instance_id: "gp-dev",
      vendor_id: vendor.id,
      market_id: market.id,
    })

    expect(assignment.market_id).toBe(market.id)
    expect(assignment.vendor_id).toBe(vendor.id)
  })

  it("duplicate assignment hits the unique constraint", async () => {
    const vertical = await service.createVertical({
      instance_id: "gp-dev",
      name: "Beauty",
      slug: "beauty",
    })
    const market = await service.createMarket({
      instance_id: "gp-dev",
      name: "BonBeauty",
      slug: "bonbeauty",
      vertical_id: vertical.id,
    })
    const vendor = await service.createVendor({
      instance_id: "gp-dev",
      name: "Studio Nova",
    })

    await service.assignVendorToMarket({
      instance_id: "gp-dev",
      vendor_id: vendor.id,
      market_id: market.id,
    })

    await expect(
      service.assignVendorToMarket({
        instance_id: "gp-dev",
        vendor_id: vendor.id,
        market_id: market.id,
      })
    ).rejects.toThrow(/duplicate key value/i)
  })

  it("listVendors returns only vendors assigned to the selected market", async () => {
    const vertical = await service.createVertical({
      instance_id: "gp-dev",
      name: "General",
      slug: "general",
    })
    const marketA = await service.createMarket({
      instance_id: "gp-dev",
      name: "Mercur",
      slug: "mercur",
      vertical_id: vertical.id,
    })
    const marketB = await service.createMarket({
      instance_id: "gp-dev",
      name: "BonEvent",
      slug: "bonevent",
      vertical_id: vertical.id,
    })
    const vendorA = await service.createVendor({
      instance_id: "gp-dev",
      name: "MercurJS Store",
    })
    const vendorB = await service.createVendor({
      instance_id: "gp-dev",
      name: "SmakiZabawy",
    })

    await service.assignVendorToMarket({
      instance_id: "gp-dev",
      vendor_id: vendorA.id,
      market_id: marketA.id,
    })
    await service.assignVendorToMarket({
      instance_id: "gp-dev",
      vendor_id: vendorB.id,
      market_id: marketB.id,
    })

    const vendors = await service.listVendors(marketA.id)

    expect(vendors).toHaveLength(1)
    expect(vendors[0].name).toBe("MercurJS Store")
  })

  it("getMarket returns joined vertical and assignments", async () => {
    await seedGpCoreFromFixtures(service, {
      instanceId: "gp-dev",
      configRoot: CONFIG_ROOT,
    })

    const market = await service.getMarket("bonbeauty", "gp-dev")

    expect(market).not.toBeNull()
    expect(market?.vertical.slug).toBe("beauty")
    expect(market?.assignments).toHaveLength(3)
    expect(market?.assignments.map((a) => a.vendor.name).sort()).toEqual(
      ["City Beauty", "KREM i DOTYK", "Studio Nova"]
    )
  })

  it("seed populates sales_channel_id for each market", async () => {
    await seedGpCoreFromFixtures(service, {
      instanceId: "gp-dev",
      configRoot: CONFIG_ROOT,
    })

    const markets = await service.listMarkets("gp-dev")
    const bySlug = Object.fromEntries(markets.map((market) => [market.slug, market]))

    expect(bySlug.bonbeauty.sales_channel_id).toBe("gp-core-test-sc-bonbeauty")
    expect(bySlug.bonevent.sales_channel_id).toBe("gp-core-test-sc-bonevent")
    expect(bySlug.mercur.sales_channel_id).toBe("gp-core-test-sc-mercur")
  })

  it("updateMarket provides a clean mutation entry point for later stories", async () => {
    const vertical = await service.createVertical({
      instance_id: "gp-dev",
      name: "Beauty",
      slug: "beauty",
    })
    const market = await service.createMarket({
      instance_id: "gp-dev",
      name: "BonBeauty",
      slug: "bonbeauty",
      vertical_id: vertical.id,
    })

    const updated = await service.updateMarket(
      { instance_id: "gp-dev", slug: "bonbeauty" },
      {
        status: "published",
        payload_vendor_id: "studio-nova",
      }
    )

    expect(updated.id).toBe(market.id)
    expect(updated.status).toBe("published")
    expect(updated.payload_vendor_id).toBe("studio-nova")
  })
})