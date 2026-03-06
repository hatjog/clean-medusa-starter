import fs from "node:fs/promises"
import path from "node:path"

import { Pool } from "pg"

import {
  MARKET_CREATED_EVENT,
  MARKET_UPDATED_EVENT,
  assertEventEnvelopeMatchesContract,
} from "../../modules/gp-core/market-lifecycle-events"
import GpCoreService from "../../modules/gp-core/service"

class RecordingEventBus {
  readonly messages: Array<{ name: string; data: unknown }> = []

  async emit(message: { name: string; data: unknown } | Array<{ name: string; data: unknown }>) {
    if (Array.isArray(message)) {
      this.messages.push(...message)
      return
    }

    this.messages.push(message)
  }

  reset() {
    this.messages.length = 0
  }
}

const BACKEND_ROOT = path.resolve(__dirname, "../../../")
const REPO_ROOT = path.resolve(BACKEND_ROOT, "../..")
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
let eventBus: RecordingEventBus
let service: GpCoreService

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

  const sql = await readSqlFile()
  await testPool.query(sql)
}

describe("gp_core market lifecycle eventing", () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: ADMIN_DATABASE_URL })
    await ensureTestDatabase()

    testPool = new Pool({ connectionString: TEST_DATABASE_URL })
    eventBus = new RecordingEventBus()
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
    eventBus.reset()
    await resetDatabase()
  })

  afterAll(async () => {
    await service.dispose()
    await Promise.allSettled([testPool.end(), adminPool.end()])
  })

  it("createMarket emits a gp.markets.market_created.v1 event", async () => {
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
      status: "published",
      sales_channel_id: "sc_bonbeauty",
    })

    expect(eventBus.messages).toHaveLength(1)
    expect(eventBus.messages[0].name).toBe(MARKET_CREATED_EVENT)
    expect(eventBus.messages[0].data).toMatchObject({
      event_type: MARKET_CREATED_EVENT,
      scope: {
        instance_id: "gp-dev",
        market_id: market.id,
      },
      payload: {
        market_id: market.id,
        slug: "bonbeauty",
        status: "active",
        instance_id: "gp-dev",
      },
    })
  })

  it("updateMarket emits a gp.markets.market_updated.v1 event with diff", async () => {
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
      status: "published",
    })

    eventBus.reset()

    const updated = await service.updateMarket(
      { id: market.id },
      {
        status: "suspended",
        sales_channel_id: "sc_bonbeauty",
        updated_by: "admin",
      }
    )

    expect(eventBus.messages).toHaveLength(1)
    expect(eventBus.messages[0].name).toBe(MARKET_UPDATED_EVENT)
    expect(eventBus.messages[0].data).toMatchObject({
      event_type: MARKET_UPDATED_EVENT,
      actor: "market_operator",
      payload: {
        market_id: updated.id,
        slug: "bonbeauty",
        status: "suspended",
        updated_by: "admin",
        changes: {
          status: {
            old: "active",
            new: "suspended",
          },
          sales_channel_id: {
            old: null,
            new: "sc_bonbeauty",
          },
        },
      },
    })
  })

  it("emitted market lifecycle events match the JSON Schema contracts", async () => {
    const vertical = await service.createVertical({
      instance_id: "gp-dev",
      name: "Events",
      slug: "events",
    })

    const market = await service.createMarket({
      instance_id: "gp-dev",
      name: "BonEvent",
      slug: "bonevent",
      vertical_id: vertical.id,
      status: "draft",
    })

    expect(() =>
      assertEventEnvelopeMatchesContract(eventBus.messages[0].data, MARKET_CREATED_EVENT)
    ).not.toThrow()

    eventBus.reset()

    await service.updateMarket(
      { id: market.id },
      {
        status: "published",
        payload_vendor_id: "vendor_bonevent",
      }
    )

    expect(() =>
      assertEventEnvelopeMatchesContract(eventBus.messages[0].data, MARKET_UPDATED_EVENT)
    ).not.toThrow()
  })

  it("updateMarket with identical values does not emit an event", async () => {
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
      status: "active",
      sales_channel_id: "sc_bonbeauty",
    })

    eventBus.reset()

    const result = await service.updateMarket(
      { id: market.id },
      {
        name: "BonBeauty",
        status: "active",
        sales_channel_id: "sc_bonbeauty",
      }
    )

    expect(result.id).toBe(market.id)
    expect(eventBus.messages).toHaveLength(0)
  })
})