import { Modules } from "@medusajs/framework/utils"
import { createHash } from "node:crypto"

import { Pool, PoolClient } from "pg"

import {
  MARKET_CREATED_EVENT,
  MARKET_UPDATED_EVENT,
  buildMarketCreatedEnvelope,
  buildMarketRecordChanges,
  buildMarketUpdatePatch,
  buildMarketUpdatedEnvelope,
  normalizeNullable,
  type MarketMutableField,
} from "./market-lifecycle-events"

import {
  AssignVendorToMarketInput,
  CreateMarketInput,
  CreateVendorInput,
  CreateVerticalInput,
  Entitlement,
  EntitlementCreateDto,
  GpCoreMarket,
  GpCoreMarketDetail,
  GpCoreMarketRecord,
  GpCoreModuleOptions,
  GpCoreVendor,
  GpCoreVendorMarketAssignment,
  GpCoreVendorMarketAssignmentDetail,
  GpCoreVertical,
  RedemptionCreateDto,
  UpdateMarketInput,
} from "./models"

export class NotImplementedError extends Error {
  constructor(storyId: string) {
    super(`Not implemented — see ${storyId}`)
    this.name = "NotImplementedError"
  }
}

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">
type EventBusLike = {
  emit: (message: unknown) => Promise<unknown>
}
type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}
type MarketSelector = { id: string } | { instance_id: string; slug: string }

type MarketRow = GpCoreMarketRecord & {
  vertical_entity_id: string
  vertical_instance_id: string
  vertical_name: string
  vertical_slug: string
  vertical_status: string
  vertical_created_at: Date | string
  vertical_updated_at: Date | string
}

type AssignmentRow = GpCoreVendorMarketAssignment & {
  vendor_instance_id: string
  vendor_name: string
  vendor_status: string
  vendor_created_at: Date | string
  vendor_updated_at: Date | string
}

function replaceDatabaseName(databaseUrl: string, databaseName: string): string {
  const parsed = new URL(databaseUrl)
  parsed.pathname = `/${databaseName}`
  return parsed.toString()
}

function deterministicUuid(seed: string): string {
  const hex = createHash("sha1").update(seed).digest("hex").slice(0, 32)
  const normalized = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ]

  return normalized.join("-")
}

function mapMarketRow(row: MarketRow): GpCoreMarket {
  return {
    id: row.id,
    instance_id: row.instance_id,
    name: row.name,
    slug: row.slug,
    vertical_id: row.vertical_id,
    status: row.status,
    sales_channel_id: row.sales_channel_id,
    payload_vendor_id: row.payload_vendor_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    vertical: {
      id: row.vertical_entity_id,
      instance_id: row.vertical_instance_id,
      name: row.vertical_name,
      slug: row.vertical_slug,
      status: row.vertical_status,
      created_at: row.vertical_created_at,
      updated_at: row.vertical_updated_at,
    },
  }
}

function mapAssignmentRow(row: AssignmentRow): GpCoreVendorMarketAssignmentDetail {
  return {
    id: row.id,
    instance_id: row.instance_id,
    vendor_id: row.vendor_id,
    market_id: row.market_id,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    vendor: {
      id: row.vendor_id,
      instance_id: row.vendor_instance_id,
      name: row.vendor_name,
      status: row.vendor_status,
      created_at: row.vendor_created_at,
      updated_at: row.vendor_updated_at,
    },
  }
}

export function resolveGpCoreDatabaseUrl(explicit?: string): string {
  const direct = explicit ?? process.env.GP_CORE_DATABASE_URL
  if (direct) {
    return direct
  }

  if (process.env.DATABASE_URL) {
    return replaceDatabaseName(process.env.DATABASE_URL, "gp_core")
  }

  return "postgres://postgres:postgres@localhost:5432/gp_core"
}

export function resolveMercurDatabaseUrl(explicit?: string): string {
  const direct = explicit ?? process.env.GP_MERCUR_DATABASE_URL
  if (direct) {
    return direct
  }

  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL
  }

  if (process.env.GP_CORE_DATABASE_URL) {
    return replaceDatabaseName(process.env.GP_CORE_DATABASE_URL, "gp_mercur")
  }

  return "postgres://postgres:postgres@localhost:5432/gp_mercur"
}

export default class GpCoreService {
  private readonly container_: Record<string, any>
  private readonly moduleOptions_: GpCoreModuleOptions
  private corePool_: Pool | null = null
  private mercurPool_: Pool | null = null

  constructor(
    container: Record<string, any> = {},
    moduleOptions: GpCoreModuleOptions = {},
    moduleDeclaration: { options?: GpCoreModuleOptions } = {}
  ) {
    this.container_ = container
    this.moduleOptions_ = {
      ...(moduleDeclaration?.options ?? {}),
      ...(moduleOptions ?? {}),
    }
  }

  private get logger_(): LoggerLike {
    return this.resolveContainerDependency<LoggerLike>("logger") ?? console
  }

  private get eventBus_(): EventBusLike | null {
    const eventBus = this.resolveContainerDependency<EventBusLike>(Modules.EVENT_BUS)
    return eventBus && typeof eventBus.emit === "function" ? eventBus : null
  }

  private resolveContainerDependency<T = unknown>(key: string): T | null {
    const direct = this.container_?.[key]
    if (direct) {
      return direct as T
    }

    if (typeof this.container_?.resolve === "function") {
      try {
        const resolved = this.container_.resolve(key)
        return (resolved ?? null) as T | null
      } catch (_error) {
        return null
      }
    }

    return null
  }

  private getCorePool(): Pool {
    if (!this.corePool_) {
      this.corePool_ = new Pool({
        connectionString: resolveGpCoreDatabaseUrl(this.moduleOptions_.databaseUrl),
      })
    }

    return this.corePool_
  }

  private getMercurPool(): Pool {
    if (!this.mercurPool_) {
      this.mercurPool_ = new Pool({
        connectionString: resolveMercurDatabaseUrl(this.moduleOptions_.mercurDatabaseUrl),
      })
    }

    return this.mercurPool_
  }

  private async queryOne<T>(executor: Queryable, sql: string, params: any[] = []): Promise<T | null> {
    const result = await executor.query(sql, params)
    return (result.rows[0] ?? null) as T | null
  }

  private async queryMany<T>(executor: Queryable, sql: string, params: any[] = []): Promise<T[]> {
    const result = await executor.query(sql, params)
    return result.rows as T[]
  }

  private async emitEventOrThrow<T>(name: string, data: T): Promise<void> {
    if (!this.eventBus_) {
      throw new Error("gp_core event bus is required to emit market lifecycle events")
    }

    await this.eventBus_.emit({ name, data })
  }

  private async selectMarketRecord(
    selector: MarketSelector,
    client?: Queryable
  ): Promise<GpCoreMarketRecord | null> {
    const selectCols =
      "id, instance_id, name, slug, vertical_id, status, sales_channel_id, payload_vendor_id, created_at, updated_at"

    if ("id" in selector) {
      return await this.queryOne<GpCoreMarketRecord>(
        client ?? this.getCorePool(),
        `SELECT ${selectCols} FROM gp_core.markets WHERE id = $1`,
        [selector.id]
      )
    }

    return await this.queryOne<GpCoreMarketRecord>(
      client ?? this.getCorePool(),
      `SELECT ${selectCols} FROM gp_core.markets WHERE instance_id = $1 AND slug = $2`,
      [selector.instance_id, selector.slug]
    )
  }

  async dispose(): Promise<void> {
    const tasks: Promise<unknown>[] = []

    if (this.corePool_) {
      tasks.push(this.corePool_.end())
      this.corePool_ = null
    }

    if (this.mercurPool_) {
      tasks.push(this.mercurPool_.end())
      this.mercurPool_ = null
    }

    await Promise.allSettled(tasks)
  }

  async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getCorePool().connect()

    try {
      await client.query("BEGIN")
      const result = await work(client)
      await client.query("COMMIT")
      return result
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  async listVerticals(instanceId?: string): Promise<GpCoreVertical[]> {
    return await this.queryMany<GpCoreVertical>(
      this.getCorePool(),
      `
        SELECT id, instance_id, name, slug, status, created_at, updated_at
        FROM gp_core.verticals
        WHERE ($1::text IS NULL OR instance_id = $1)
        ORDER BY slug ASC
      `,
      [instanceId ?? null]
    )
  }

  async getVerticalBySlug(instanceId: string, slug: string, client?: Queryable): Promise<GpCoreVertical | null> {
    return await this.queryOne<GpCoreVertical>(
      client ?? this.getCorePool(),
      `
        SELECT id, instance_id, name, slug, status, created_at, updated_at
        FROM gp_core.verticals
        WHERE instance_id = $1 AND slug = $2
      `,
      [instanceId, slug]
    )
  }

  async getVerticalById(verticalId: string, client?: Queryable): Promise<GpCoreVertical | null> {
    return await this.queryOne<GpCoreVertical>(
      client ?? this.getCorePool(),
      `
        SELECT id, instance_id, name, slug, status, created_at, updated_at
        FROM gp_core.verticals
        WHERE id = $1
      `,
      [verticalId]
    )
  }

  async createVertical(input: CreateVerticalInput, client?: Queryable): Promise<GpCoreVertical> {
    const vertical = await this.queryOne<GpCoreVertical>(
      client ?? this.getCorePool(),
      `
        INSERT INTO gp_core.verticals (id, instance_id, name, slug, status)
        VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5)
        RETURNING id, instance_id, name, slug, status, created_at, updated_at
      `,
      [input.id ?? null, input.instance_id, input.name, input.slug, input.status ?? "active"]
    )

    if (!vertical) {
      throw new Error(`Failed to create vertical '${input.slug}'`)
    }

    return vertical
  }

  async upsertVertical(input: CreateVerticalInput, client?: Queryable): Promise<GpCoreVertical> {
    const vertical = await this.queryOne<GpCoreVertical>(
      client ?? this.getCorePool(),
      `
        INSERT INTO gp_core.verticals (id, instance_id, name, slug, status)
        VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5)
        ON CONFLICT (instance_id, slug)
        DO UPDATE
        SET name = EXCLUDED.name,
            status = EXCLUDED.status,
            updated_at = now()
        RETURNING id, instance_id, name, slug, status, created_at, updated_at
      `,
      [input.id ?? null, input.instance_id, input.name, input.slug, input.status ?? "active"]
    )

    if (!vertical) {
      throw new Error(`Failed to upsert vertical '${input.slug}'`)
    }

    return vertical
  }

  async listMarkets(instanceId?: string): Promise<GpCoreMarket[]> {
    const rows = await this.queryMany<MarketRow>(
      this.getCorePool(),
      `
        SELECT
          m.id,
          m.instance_id,
          m.name,
          m.slug,
          m.vertical_id,
          m.status,
          m.sales_channel_id,
          m.payload_vendor_id,
          m.created_at,
          m.updated_at,
          v.id AS vertical_entity_id,
          v.instance_id AS vertical_instance_id,
          v.name AS vertical_name,
          v.slug AS vertical_slug,
          v.status AS vertical_status,
          v.created_at AS vertical_created_at,
          v.updated_at AS vertical_updated_at
        FROM gp_core.markets m
        INNER JOIN gp_core.verticals v ON v.id = m.vertical_id
        WHERE ($1::text IS NULL OR m.instance_id = $1)
        ORDER BY m.slug ASC
      `,
      [instanceId ?? null]
    )

    return rows.map(mapMarketRow)
  }

  async getMarketBySlug(instanceId: string, slug: string, client?: Queryable): Promise<GpCoreMarketRecord | null> {
    return await this.queryOne<GpCoreMarketRecord>(
      client ?? this.getCorePool(),
      `
        SELECT id, instance_id, name, slug, vertical_id, status, sales_channel_id, payload_vendor_id, created_at, updated_at
        FROM gp_core.markets
        WHERE instance_id = $1 AND slug = $2
      `,
      [instanceId, slug]
    )
  }

  private async getMarketRow(slug: string, instanceId?: string, client?: Queryable): Promise<MarketRow | null> {
    return await this.queryOne<MarketRow>(
      client ?? this.getCorePool(),
      `
        SELECT
          m.id,
          m.instance_id,
          m.name,
          m.slug,
          m.vertical_id,
          m.status,
          m.sales_channel_id,
          m.payload_vendor_id,
          m.created_at,
          m.updated_at,
          v.id AS vertical_entity_id,
          v.instance_id AS vertical_instance_id,
          v.name AS vertical_name,
          v.slug AS vertical_slug,
          v.status AS vertical_status,
          v.created_at AS vertical_created_at,
          v.updated_at AS vertical_updated_at
        FROM gp_core.markets m
        INNER JOIN gp_core.verticals v ON v.id = m.vertical_id
        WHERE m.slug = $1
          AND ($2::text IS NULL OR m.instance_id = $2)
      `,
      [slug, instanceId ?? null]
    )
  }

  async getMarket(slug: string, instanceId?: string): Promise<GpCoreMarketDetail | null> {
    const row = await this.getMarketRow(slug, instanceId)
    if (!row) {
      return null
    }

    const assignments = await this.queryMany<AssignmentRow>(
      this.getCorePool(),
      `
        SELECT
          a.id,
          a.instance_id,
          a.vendor_id,
          a.market_id,
          a.status,
          a.created_at,
          a.updated_at,
          v.instance_id AS vendor_instance_id,
          v.name AS vendor_name,
          v.status AS vendor_status,
          v.created_at AS vendor_created_at,
          v.updated_at AS vendor_updated_at
        FROM gp_core.vendor_market_assignments a
        INNER JOIN gp_core.vendors v ON v.id = a.vendor_id
        WHERE a.market_id = $1
        ORDER BY v.name ASC
      `,
      [row.id]
    )

    return {
      ...mapMarketRow(row),
      assignments: assignments.map(mapAssignmentRow),
    }
  }

  async createMarket(input: CreateMarketInput, client?: Queryable): Promise<GpCoreMarketRecord> {
    if (!client) {
      return await this.withTransaction((transactionClient) => this.createMarket(input, transactionClient))
    }

    const vertical = await this.getVerticalById(input.vertical_id, client)
    if (!vertical) {
      throw new Error(`Vertical '${input.vertical_id}' not found`)
    }

    const market = await this.queryOne<GpCoreMarketRecord>(
      client,
      `
        INSERT INTO gp_core.markets (
          id,
          instance_id,
          name,
          slug,
          vertical_id,
          status,
          sales_channel_id,
          payload_vendor_id
        )
        VALUES (
          COALESCE($1::uuid, gen_random_uuid()),
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8
        )
        RETURNING id, instance_id, name, slug, vertical_id, status, sales_channel_id, payload_vendor_id, created_at, updated_at
      `,
      [
        input.id ?? null,
        input.instance_id,
        input.name,
        input.slug,
        input.vertical_id,
        input.status ?? "active",
        normalizeNullable(input.sales_channel_id),
        normalizeNullable(input.payload_vendor_id),
      ]
    )

    if (!market) {
      throw new Error(`Failed to create market '${input.slug}'`)
    }

    const createdEnvelope = buildMarketCreatedEnvelope({
      market,
      vertical,
    })

    // CAVEAT: Medusa EventBus is not transactional — emit happens inside the
    // DB transaction but the bus (Redis/in-memory) is not rolled back on
    // ROLLBACK.  A proper outbox pattern is needed for production atomicity.
    // See: specs/architecture/eventing-standard.md §3
    await this.emitEventOrThrow(MARKET_CREATED_EVENT, createdEnvelope)

    return market
  }

  /**
   * Raw upsert without lifecycle event emission.
   * Use createMarket() / updateMarket() for event-driven flows.
   * Retained only for legacy migration paths where event emission is undesirable.
   */
  async upsertMarket(input: CreateMarketInput, client?: Queryable): Promise<GpCoreMarketRecord> {
    const market = await this.queryOne<GpCoreMarketRecord>(
      client ?? this.getCorePool(),
      `
        INSERT INTO gp_core.markets (
          id,
          instance_id,
          name,
          slug,
          vertical_id,
          status,
          sales_channel_id,
          payload_vendor_id
        )
        VALUES (
          COALESCE($1::uuid, gen_random_uuid()),
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8
        )
        ON CONFLICT (instance_id, slug)
        DO UPDATE
        SET name = EXCLUDED.name,
            vertical_id = EXCLUDED.vertical_id,
            status = EXCLUDED.status,
            sales_channel_id = EXCLUDED.sales_channel_id,
            payload_vendor_id = EXCLUDED.payload_vendor_id,
            updated_at = now()
        RETURNING id, instance_id, name, slug, vertical_id, status, sales_channel_id, payload_vendor_id, created_at, updated_at
      `,
      [
        input.id ?? null,
        input.instance_id,
        input.name,
        input.slug,
        input.vertical_id,
        input.status ?? "active",
        normalizeNullable(input.sales_channel_id),
        normalizeNullable(input.payload_vendor_id),
      ]
    )

    if (!market) {
      throw new Error(`Failed to upsert market '${input.slug}'`)
    }

    return market
  }

  async updateMarket(
    selector: MarketSelector,
    update: UpdateMarketInput,
    client?: Queryable
  ): Promise<GpCoreMarketRecord> {
    const selectCols =
      "id, instance_id, name, slug, vertical_id, status, sales_channel_id, payload_vendor_id, created_at, updated_at"

    if (!client) {
      return await this.withTransaction((transactionClient) =>
        this.updateMarket(selector, update, transactionClient)
      )
    }

    const currentMarket = await this.selectMarketRecord(selector, client)
    if (!currentMarket) {
      throw new Error("Market not found")
    }

    const patch = buildMarketUpdatePatch(currentMarket, update)
    const assignments = Object.entries(patch) as Array<[MarketMutableField, unknown]>

    if (assignments.length === 0) {
      return currentMarket
    }

    const setSql = assignments
      .map(([column], index) => `${column} = $${index + 1}`)
      .join(", ") + ", updated_at = now()"
    const values = assignments.map(([, value]) => value)
    const whereSql = "id" in selector
      ? `id = $${values.length + 1}`
      : `instance_id = $${values.length + 1} AND slug = $${values.length + 2}`

    const params = "id" in selector
      ? [...values, selector.id]
      : [...values, selector.instance_id, selector.slug]

    const market = await this.queryOne<GpCoreMarketRecord>(
      client,
      `
        UPDATE gp_core.markets
        SET ${setSql}
        WHERE ${whereSql}
        RETURNING ${selectCols}
      `,
      params
    )

    if (!market) {
      throw new Error("Market not found")
    }

    const changes = buildMarketRecordChanges(currentMarket, market)
    if (Object.keys(changes).length > 0) {
      const updatedEnvelope = buildMarketUpdatedEnvelope({
        before: currentMarket,
        after: market,
        changes,
        updatedBy: update.updated_by ?? "system",
      })

      // CAVEAT: same non-transactional emit caveat as createMarket — see above
      await this.emitEventOrThrow(MARKET_UPDATED_EVENT, updatedEnvelope)
    }

    return market
  }

  async getVendor(vendorId: string, client?: Queryable): Promise<GpCoreVendor | null> {
    return await this.queryOne<GpCoreVendor>(
      client ?? this.getCorePool(),
      `
        SELECT id, instance_id, name, status, created_at, updated_at
        FROM gp_core.vendors
        WHERE id = $1
      `,
      [vendorId]
    )
  }

  buildSeedVendorId(instanceId: string, vendorKey: string): string {
    return deterministicUuid(`vendor:${instanceId}:${vendorKey}`)
  }

  async createVendor(input: CreateVendorInput, client?: Queryable): Promise<GpCoreVendor> {
    const vendor = await this.queryOne<GpCoreVendor>(
      client ?? this.getCorePool(),
      `
        INSERT INTO gp_core.vendors (id, instance_id, name, status)
        VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4)
        RETURNING id, instance_id, name, status, created_at, updated_at
      `,
      [input.id ?? null, input.instance_id, input.name, input.status ?? "onboarded"]
    )

    if (!vendor) {
      throw new Error(`Failed to create vendor '${input.name}'`)
    }

    return vendor
  }

  async upsertVendor(
    input: CreateVendorInput & { vendor_key: string },
    client?: Queryable
  ): Promise<GpCoreVendor> {
    const vendorId = input.id ?? this.buildSeedVendorId(input.instance_id, input.vendor_key)
    const vendor = await this.queryOne<GpCoreVendor>(
      client ?? this.getCorePool(),
      `
        INSERT INTO gp_core.vendors (id, instance_id, name, status)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id)
        DO UPDATE
        SET name = EXCLUDED.name,
            status = EXCLUDED.status,
            updated_at = now()
        RETURNING id, instance_id, name, status, created_at, updated_at
      `,
      [vendorId, input.instance_id, input.name, input.status ?? "onboarded"]
    )

    if (!vendor) {
      throw new Error(`Failed to upsert vendor '${input.vendor_key}'`)
    }

    return vendor
  }

  async listVendors(marketId: string): Promise<GpCoreVendor[]> {
    return await this.queryMany<GpCoreVendor>(
      this.getCorePool(),
      `
        SELECT v.id, v.instance_id, v.name, v.status, v.created_at, v.updated_at
        FROM gp_core.vendors v
        INNER JOIN gp_core.vendor_market_assignments a ON a.vendor_id = v.id
        WHERE a.market_id = $1
        ORDER BY v.name ASC
      `,
      [marketId]
    )
  }

  async getVendorMarketAssignment(
    instanceId: string,
    vendorId: string,
    marketId: string,
    client?: Queryable
  ): Promise<GpCoreVendorMarketAssignment | null> {
    return await this.queryOne<GpCoreVendorMarketAssignment>(
      client ?? this.getCorePool(),
      `
        SELECT id, instance_id, vendor_id, market_id, status, created_at, updated_at
        FROM gp_core.vendor_market_assignments
        WHERE instance_id = $1 AND vendor_id = $2 AND market_id = $3
      `,
      [instanceId, vendorId, marketId]
    )
  }

  async assignVendorToMarket(
    input: AssignVendorToMarketInput,
    client?: Queryable
  ): Promise<GpCoreVendorMarketAssignment> {
    const assignment = await this.queryOne<GpCoreVendorMarketAssignment>(
      client ?? this.getCorePool(),
      `
        INSERT INTO gp_core.vendor_market_assignments (id, instance_id, vendor_id, market_id, status)
        VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5)
        RETURNING id, instance_id, vendor_id, market_id, status, created_at, updated_at
      `,
      [input.id ?? null, input.instance_id, input.vendor_id, input.market_id, input.status ?? "active"]
    )

    if (!assignment) {
      throw new Error(
        `Failed to assign vendor '${input.vendor_id}' to market '${input.market_id}'`
      )
    }

    return assignment
  }

  async upsertVendorToMarket(
    input: AssignVendorToMarketInput,
    client?: Queryable
  ): Promise<GpCoreVendorMarketAssignment> {
    const assignment = await this.queryOne<GpCoreVendorMarketAssignment>(
      client ?? this.getCorePool(),
      `
        INSERT INTO gp_core.vendor_market_assignments (id, instance_id, vendor_id, market_id, status)
        VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5)
        ON CONFLICT (instance_id, vendor_id, market_id)
        DO UPDATE
        SET status = EXCLUDED.status,
            updated_at = now()
        RETURNING id, instance_id, vendor_id, market_id, status, created_at, updated_at
      `,
      [input.id ?? null, input.instance_id, input.vendor_id, input.market_id, input.status ?? "active"]
    )

    if (!assignment) {
      throw new Error(
        `Failed to upsert assignment for vendor '${input.vendor_id}' and market '${input.market_id}'`
      )
    }

    return assignment
  }

  // --- Entitlement Domain Stubs (Story 1.2) ---

  /**
   * @planned ADR-052 — entitlement issuance via Mercur→gp_core event flow (checkout→issue).
   * This stub will be implemented when event-driven integration is built.
   */
  async createEntitlement(_dto: EntitlementCreateDto): Promise<Entitlement> {
    throw new NotImplementedError("Story 1.3")
  }

  /**
   * @deprecated ADR-052 — salon entitlement operations live in apps/web (direct gp_core access).
   * This stub is a historical placeholder from before the gp_core/gp_mercur DB separation was established.
   * Do NOT implement here. If Mercur needs entitlement operations, design a bridge (ADR-052 Option B).
   */
  async claimVoucher(_claimToken: string, _customerId: string): Promise<Entitlement> {
    throw new NotImplementedError("Story 1.3")
  }

  /**
   * @deprecated ADR-052 — salon entitlement operations live in apps/web (direct gp_core access).
   * This stub is a historical placeholder from before the gp_core/gp_mercur DB separation was established.
   * Do NOT implement here. If Mercur needs entitlement operations, design a bridge (ADR-052 Option B).
   */
  async verifyVoucher(_voucherCode: string): Promise<Entitlement> {
    throw new NotImplementedError("Story 1.3")
  }

  /**
   * @deprecated ADR-052 — salon entitlement operations live in apps/web (direct gp_core access).
   * This stub is a historical placeholder from before the gp_core/gp_mercur DB separation was established.
   * Do NOT implement here. If Mercur needs entitlement operations, design a bridge (ADR-052 Option B).
   */
  async redeemVoucher(_dto: RedemptionCreateDto): Promise<Entitlement> {
    throw new NotImplementedError("Story 1.3")
  }

  async resolveVendorId(_mercurSellerId: string): Promise<string> {
    throw new NotImplementedError("Story 1.3")
  }

  /**
   * @deprecated ADR-052 — salon entitlement operations live in apps/web (direct gp_core access).
   * This stub is a historical placeholder from before the gp_core/gp_mercur DB separation was established.
   * Do NOT implement here. If Mercur needs entitlement operations, design a bridge (ADR-052 Option B).
   */
  async searchVouchers(_query: { market_id?: string; vendor_id?: string; status?: string }): Promise<Entitlement[]> {
    throw new NotImplementedError("Story 1.3")
  }

  /**
   * @deprecated ADR-052 — salon entitlement operations live in apps/web (direct gp_core access).
   * This stub is a historical placeholder from before the gp_core/gp_mercur DB separation was established.
   * Do NOT implement here. If Mercur needs entitlement operations, design a bridge (ADR-052 Option B).
   */
  async voidEntitlement(_entitlementId: string, _reason: string): Promise<Entitlement> {
    throw new NotImplementedError("Story 1.3")
  }

  /**
   * @deprecated ADR-052 — salon entitlement operations live in apps/web (direct gp_core access).
   * This stub is a historical placeholder from before the gp_core/gp_mercur DB separation was established.
   * Do NOT implement here. If Mercur needs entitlement operations, design a bridge (ADR-052 Option B).
   */
  async refundEntitlement(_entitlementId: string, _reason: string): Promise<Entitlement> {
    throw new NotImplementedError("Story 1.3")
  }

  async healthCheck(): Promise<{ core: boolean; mercur: boolean }> {
    const result = { core: false, mercur: false }

    try {
      await this.getCorePool().query("SELECT 1")
      result.core = true
    } catch (error) {
      this.logger_.warn?.(`gp_core health check failed (core pool): ${String(error)}`)
    }

    try {
      await this.getMercurPool().query("SELECT 1")
      result.mercur = true
    } catch (error) {
      this.logger_.warn?.(`gp_core health check failed (mercur pool): ${String(error)}`)
    }

    return result
  }

  /**
   * adminSearchEntitlements — Operator entitlement lookup (Story 8.1, DD-16, CST-1).
   *
   * Two query paths:
   * - Email path (contains "@"): Mercur orders WHERE buyer_email ILIKE → collect order_ids → gp_core entitlements.
   *   Two separate DB connections — cross-DB FK is impossible (IP-2, DD-16).
   * - Direct path: ILIKE on voucher_code, exact match on claim_token / order_id.
   *
   * Returns full EntitlementAdminView[] with redemption list + audit log.
   */
  async adminSearchEntitlements(q: string): Promise<import("../../../lib/contracts/admin").EntitlementAdminView[]> {
    const isEmailSearch = q.includes("@")
    const startMs = Date.now()

    if (isEmailSearch) {
      return this.adminSearchByEmail(q, startMs)
    }

    return this.adminSearchDirect(q, startMs)
  }

  private async adminSearchByEmail(
    email: string,
    startMs: number
  ): Promise<import("../../../lib/contracts/admin").EntitlementAdminView[]> {
    // Step 1: Find order_ids in Mercur DB by buyer_email (ILIKE for case-insensitive)
    const orderRows = await this.queryMany<{ id: string }>(
      this.getMercurPool(),
      `SELECT id FROM public.order WHERE buyer_email ILIKE $1 LIMIT 100`,
      [`%${email}%`]
    )

    if (!orderRows.length) {
      this.logger_.info?.(`[admin.entitlement.search] query_type=email result_count=0 duration_ms=${Date.now() - startMs}`)
      return []
    }

    const orderIds = orderRows.map((r) => r.id)

    // Step 2: Fetch entitlements from gp_core by order_id list
    const entitlements = await this.queryMany<import("../../../lib/contracts/admin").EntitlementAdminView & { raw_id: string }>(
      this.getCorePool(),
      `
        SELECT
          e.id,
          e.status,
          e.voucher_code,
          e.claim_token,
          e.order_id,
          e.face_value_minor,
          e.remaining_minor,
          e.currency,
          e.product_name,
          e.vendor_name,
          e.created_at,
          e.expires_at,
          e.claimed_at,
          e.last_redeemed_at
        FROM entitlements e
        WHERE e.order_id = ANY($1)
        ORDER BY e.created_at DESC
        LIMIT 200
      `,
      [orderIds]
    )

    const result = await this.enrichEntitlements(entitlements)
    this.logger_.info?.(`[admin.entitlement.search] query_type=email result_count=${result.length} duration_ms=${Date.now() - startMs}`)
    return result
  }

  private async adminSearchDirect(
    q: string,
    startMs: number
  ): Promise<import("../../../lib/contracts/admin").EntitlementAdminView[]> {
    // Direct path: ILIKE on voucher_code, exact match on claim_token and order_id
    const entitlements = await this.queryMany<import("../../../lib/contracts/admin").EntitlementAdminView>(
      this.getCorePool(),
      `
        SELECT
          e.id,
          e.status,
          e.voucher_code,
          e.claim_token,
          e.order_id,
          e.face_value_minor,
          e.remaining_minor,
          e.currency,
          e.product_name,
          e.vendor_name,
          e.created_at,
          e.expires_at,
          e.claimed_at,
          e.last_redeemed_at
        FROM entitlements e
        WHERE e.voucher_code ILIKE $1
           OR e.claim_token = $2
           OR e.order_id = $2
        ORDER BY e.created_at DESC
        LIMIT 100
      `,
      [`%${q}%`, q]
    )

    const result = await this.enrichEntitlements(entitlements)
    this.logger_.info?.(`[admin.entitlement.search] query_type=direct result_count=${result.length} duration_ms=${Date.now() - startMs}`)
    return result
  }

  private async enrichEntitlements(
    entitlements: import("../../../lib/contracts/admin").EntitlementAdminView[]
  ): Promise<import("../../../lib/contracts/admin").EntitlementAdminView[]> {
    if (!entitlements.length) return []

    const ids = entitlements.map((e) => e.id)

    // Fetch redemptions for all entitlements in one query
    const redemptions = await this.queryMany<{
      id: string
      entitlement_id: string
      amount_minor: number
      vendor_id: string
      redeemed_at: string
      idempotency_key: string
    }>(
      this.getCorePool(),
      `
        SELECT id, entitlement_id, amount_minor, vendor_id, redeemed_at, idempotency_key
        FROM redemptions
        WHERE entitlement_id = ANY($1)
        ORDER BY redeemed_at ASC
      `,
      [ids]
    )

    // Fetch audit log entries (table may not exist yet — graceful skip)
    let auditEntries: Array<{
      id: string
      entitlement_id: string
      action: string
      actor: string
      reason: string | null
      created_at: string
    }> = []

    try {
      auditEntries = await this.queryMany<{
        id: string
        entitlement_id: string
        action: string
        actor: string
        reason: string | null
        created_at: string
      }>(
        this.getCorePool(),
        `
          SELECT id, entitlement_id, action, actor, reason, created_at
          FROM entitlement_audit_log
          WHERE entitlement_id = ANY($1)
          ORDER BY created_at ASC
        `,
        [ids]
      )
    } catch {
      // entitlement_audit_log table may not exist yet
    }

    // Group by entitlement_id
    const redemptionsByEntitlement = new Map<string, typeof redemptions>()
    const auditByEntitlement = new Map<string, typeof auditEntries>()

    for (const r of redemptions) {
      const list = redemptionsByEntitlement.get(r.entitlement_id) ?? []
      list.push(r)
      redemptionsByEntitlement.set(r.entitlement_id, list)
    }

    for (const a of auditEntries) {
      const list = auditByEntitlement.get(a.entitlement_id) ?? []
      list.push(a)
      auditByEntitlement.set(a.entitlement_id, list)
    }

    return entitlements.map((e) => ({
      ...e,
      created_at: e.created_at ? new Date(e.created_at).toISOString() : e.created_at,
      expires_at: e.expires_at ? new Date(e.expires_at).toISOString() : null,
      claimed_at: e.claimed_at ? new Date(e.claimed_at).toISOString() : null,
      last_redeemed_at: e.last_redeemed_at ? new Date(e.last_redeemed_at).toISOString() : null,
      redemptions: (redemptionsByEntitlement.get(e.id) ?? []).map((r) => ({
        id: r.id,
        amount_minor: r.amount_minor,
        vendor_id: r.vendor_id,
        redeemed_at: new Date(r.redeemed_at).toISOString(),
        idempotency_key: r.idempotency_key,
      })),
      audit_log: (auditByEntitlement.get(e.id) ?? []).map((a) => ({
        id: a.id,
        action: a.action,
        actor: a.actor,
        reason: a.reason,
        created_at: new Date(a.created_at).toISOString(),
      })),
    }))
  }

  async findSalesChannelId(marketId: string): Promise<string | null> {
    try {
      const byMetadata = await this.queryOne<{ id: string }>(
        this.getMercurPool(),
        `
          SELECT id
          FROM public.sales_channel
          WHERE COALESCE(metadata->>'gp_market_id', '') = $1
          ORDER BY id ASC
          LIMIT 1
        `,
        [marketId]
      )

      if (byMetadata?.id) {
        return byMetadata.id
      }

      const fallback = await this.queryOne<{ id: string }>(
        this.getMercurPool(),
        `
          SELECT id
          FROM public.sales_channel
          WHERE name = 'Default Sales Channel'
          ORDER BY id ASC
          LIMIT 1
        `
      )

      return fallback?.id ?? null
    } catch (error) {
      this.logger_.warn?.(`gp_core sales channel lookup failed for '${marketId}': ${String(error)}`)
      return null
    }
  }
}
