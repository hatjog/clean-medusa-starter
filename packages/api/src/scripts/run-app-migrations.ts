#!/usr/bin/env node

/* eslint-disable no-console */

import path from "node:path"

import { loadEnv } from "@medusajs/framework/utils"
import { defineConfig, MikroORM } from "@medusajs/deps/mikro-orm/postgresql"
import { Migrator } from "@medusajs/deps/mikro-orm/migrations"

type MigrationSurfaceName = "app" | "legacy-base"

type DbConnection = {
  execute: (sql: string, params?: unknown[]) => Promise<unknown>
}

type MigrationProbe = (connection: DbConnection) => Promise<boolean>

type MigrationPrerequisite = {
  check: MigrationProbe
  reason: string
}

type MigrationSurfaceConfig = {
  path: string
  tableName: string
  snapshotName: string
  adoptionProbes: Record<string, MigrationProbe>
  prerequisites: Record<string, MigrationPrerequisite>
}

const APP_SURFACE_CONFIG: MigrationSurfaceConfig = {
  path: path.resolve(process.cwd(), "packages/api/src/migrations"),
  tableName: "app_mikro_orm_migrations",
  snapshotName: ".snapshot-gp-app",
  adoptionProbes: {
    Migration20260429120000VoucherPiiConsentAuditTable: (connection) =>
      tableExists(connection, "voucher_pii_consent_audit"),
    Migration20260430090000VoucherRecipientPiiTable: (connection) =>
      tableExists(connection, "voucher_recipient_pii"),
    Migration20260430090100VoucherDeliveryDecisionTable: (connection) =>
      tableExists(connection, "voucher_delivery_decision"),
    Migration20260504210000PhaseBSmokeGateRatificationsTable: (connection) =>
      tableExists(connection, "phase_b_smoke_gate_ratifications"),
    Migration20260505000000VendorNotificationLogTable: (connection) =>
      tableExists(connection, "vendor_notification_log"),
    Migration20260505110000OperatorMultiVendorFlagAuditTable: (connection) =>
      tableExists(connection, "operator_multi_vendor_flag_audit"),
    Migration20260505123000OperatorAlertFiringHistoryTable: (connection) =>
      tableExists(connection, "operator_alert_firing_history"),
    Migration20260505163000OperatorAlertEvaluatorTickHistoryTable: (connection) =>
      tableExists(connection, "operator_alert_evaluator_tick_history"),
    Migration20260505190000OperatorT30KickoffTable: (connection) =>
      tableExists(connection, "operator_t30_kickoff"),
    Migration20260507200000VendorLifecycleStateTable: (connection) =>
      tableExists(connection, "vendor_lifecycle_state"),
  },
  prerequisites: {
    Migration20260430090100VoucherDeliveryDecisionTable: {
      check: (connection) => tableExists(connection, "voucher_pii_consent_audit"),
      reason: "voucher_delivery_decision depends on public.voucher_pii_consent_audit",
    },
  },
}

const LEGACY_BASE_SURFACE_CONFIG: MigrationSurfaceConfig = {
  path: path.resolve(process.cwd(), "packages/api/src/migrations-legacy-base"),
  tableName: "legacy_base_mikro_orm_migrations",
  snapshotName: ".snapshot-gp-legacy-base",
  adoptionProbes: {
  Migration20260427000000AddPostingTriggerToLedgerEntry: async (connection) => {
    if (!(await columnExists(connection, "ledger_entry", "posting_trigger"))) {
      return false
    }

    return noNullRows(connection, "ledger_entry", "posting_trigger")
  },
  Migration20260427120000AddLocalesToMarketRuntimeConfig: async (connection) => {
    if (!(await columnExists(connection, "market_runtime_config", "locales"))) {
      return false
    }

    return noNullRows(connection, "market_runtime_config", "locales")
  },
  Migration20260427120000BackfillOrderPlacedV2Payload: async (connection) => {
    if (!(await columnExists(connection, "event_store", "payload_v2"))) {
      return false
    }

    return noNullRows(
      connection,
      "event_store",
      "payload_v2",
      `event_type = 'gp.commerce.order_placed.v1'`,
    )
  },
  },
  prerequisites: {
    Migration20260427000000AddPostingTriggerToLedgerEntry: {
      check: (connection) => tableExists(connection, "ledger_entry"),
      reason: "base table public.ledger_entry is missing in the current DATABASE_URL",
    },
    Migration20260427120000AddLocalesToMarketRuntimeConfig: {
      check: (connection) => tableExists(connection, "market_runtime_config"),
      reason: "base table public.market_runtime_config is missing in the current DATABASE_URL",
    },
    Migration20260427120000BackfillOrderPlacedV2Payload: {
      check: (connection) => tableExists(connection, "event_store"),
      reason: "base table public.event_store is missing in the current DATABASE_URL",
    },
  },
}

type ExecutedMigration = {
  id: number
  name: string
  executed_at: Date | string
}

type PendingMigration = {
  name: string
  path?: string
}

type BlockedMigration = {
  name: string
  reason: string
}

const MIGRATION_SURFACES: Record<MigrationSurfaceName, MigrationSurfaceConfig> = {
  app: APP_SURFACE_CONFIG,
  "legacy-base": LEGACY_BASE_SURFACE_CONFIG,
}

loadEnv(process.env.NODE_ENV || "development", process.cwd())

function resolveSurfaceName(): MigrationSurfaceName {
  const rawSurface = (process.env.GP_MIGRATION_SURFACE || "app").trim().toLowerCase()

  if (rawSurface !== "app" && rawSurface !== "legacy-base") {
    throw new Error(
      `Unsupported GP_MIGRATION_SURFACE '${rawSurface}'. Use 'app' or 'legacy-base'.`,
    )
  }

  return rawSurface
}

const migrationSurfaceName = resolveSurfaceName()
const migrationSurface = MIGRATION_SURFACES[migrationSurfaceName]

function buildConfig() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run app migrations")
  }

  return {
    clientUrl: databaseUrl,
    entities: [],
    discovery: {
      warnWhenNoEntities: false,
    },
    allowGlobalContext: true,
    migrations: {
      path: migrationSurface.path,
      pathTs: migrationSurface.path,
      glob: "!(*.d).{js,ts}",
      tableName: migrationSurface.tableName,
      snapshotName: migrationSurface.snapshotName,
      silent: true,
    },
    extensions: [Migrator],
  }
}

async function readStatus(): Promise<{
  executed: ExecutedMigration[]
  pending: PendingMigration[]
}> {
  const orm = await MikroORM.init(defineConfig(buildConfig()))

  try {
    const migrator = orm.getMigrator()
    const executed = await (migrator.getExecutedMigrations() as Promise<ExecutedMigration[]>)
    const pending = await (migrator.getPendingMigrations() as Promise<PendingMigration[]>)

    return { executed, pending }
  } finally {
    await orm.close(true)
  }
}

async function scalarApplied(connection: DbConnection, sql: string): Promise<boolean> {
  const result = await connection.execute(sql)
  const row = Array.isArray(result) ? result[0] : null

  return Boolean(row?.applied)
}

async function tableExists(connection: DbConnection, tableName: string): Promise<boolean> {
  return scalarApplied(
    connection,
    `select (to_regclass('public.${tableName}') is not null) as applied`,
  )
}

async function columnExists(
  connection: DbConnection,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  return scalarApplied(
    connection,
    `
      select exists (
        select 1
          from information_schema.columns
         where table_schema = 'public'
           and table_name = '${tableName}'
           and column_name = '${columnName}'
      ) as applied
    `,
  )
}

async function noNullRows(
  connection: DbConnection,
  tableName: string,
  columnName: string,
  extraWhere?: string,
): Promise<boolean> {
  const whereClause = extraWhere
    ? `${extraWhere} and ${columnName} is null`
    : `${columnName} is null`

  return scalarApplied(
    connection,
    `
      select not exists (
        select 1
          from public.${tableName}
         where ${whereClause}
      ) as applied
    `,
  )
}

async function adoptExistingMigrations(executed: ExecutedMigration[]): Promise<string[]> {
  const executedNames = new Set(executed.map((migration) => migration.name))
  const migrationNames = Object.keys(migrationSurface.adoptionProbes).filter(
    (migrationName) => !executedNames.has(migrationName),
  )

  if (migrationNames.length === 0) {
    return []
  }

  const orm = await MikroORM.init(defineConfig(buildConfig()))

  try {
    const connection = orm.em.getConnection()
    const adopted: string[] = []

    for (const migrationName of migrationNames) {
      if (!(await migrationSurface.adoptionProbes[migrationName](connection))) {
        continue
      }

      await connection.execute(
        `
          insert into public.${migrationSurface.tableName} (name)
          select ?
          where not exists (
            select 1
              from public.${migrationSurface.tableName}
             where name = ?
          )
        `,
        [migrationName, migrationName],
      )

      adopted.push(migrationName)
    }

    return adopted
  } finally {
    await orm.close(true)
  }
}

function printStatus(executed: ExecutedMigration[], pending: PendingMigration[]): void {
  console.log(`migration_surface=${migrationSurfaceName}`)
  console.log(`migrations_path=${migrationSurface.path}`)
  console.log(`migrations_table=${migrationSurface.tableName}`)
  console.log(`executed=${executed.length}`)
  console.log(`pending=${pending.length}`)

  if (executed.length > 0) {
    console.log("executed_names=")
    for (const migration of executed) {
      console.log(`- ${migration.name}`)
    }
  }

  if (pending.length > 0) {
    console.log("pending_names=")
    for (const migration of pending) {
      console.log(`- ${migration.name}`)
    }
  }
}

async function runPendingMigrations(pending: PendingMigration[]): Promise<BlockedMigration[]> {
  if (pending.length === 0) {
    console.log(`No pending ${migrationSurfaceName} migrations to execute.`)
    return []
  }

  const orm = await MikroORM.init(defineConfig(buildConfig()))

  try {
    const migrator = orm.getMigrator()
    const connection = orm.em.getConnection()
    const blocked: BlockedMigration[] = []
    let appliedCount = 0

    for (const migration of pending) {
      const prerequisite = migrationSurface.prerequisites[migration.name]

      if (prerequisite && !(await prerequisite.check(connection))) {
        blocked.push({
          name: migration.name,
          reason: prerequisite.reason,
        })
        console.log(`blocked ${migration.name}: ${prerequisite.reason}`)
        continue
      }

      console.log(`migrating ${migration.name}`)
      await migrator.up({ migrations: [migration.name] })
      console.log(`migrated ${migration.name}`)
      appliedCount += 1
    }

    console.log(`Applied ${appliedCount} ${migrationSurfaceName} migration(s).`)

    if (blocked.length > 0) {
      console.log("blocked_missing_prerequisites=")
      for (const migration of blocked) {
        console.log(`- ${migration.name}: ${migration.reason}`)
      }
    }

    return blocked
  } finally {
    await orm.close(true)
  }
}

async function main(): Promise<void> {
  const command = (process.argv[2] || "up").trim().toLowerCase()
  const initialStatus = await readStatus()

  if (command === "status") {
    printStatus(initialStatus.executed, initialStatus.pending)
    return
  }

  if (command !== "up") {
    throw new Error(`Unsupported command '${command}'. Use 'up' or 'status'.`)
  }

  const adopted = await adoptExistingMigrations(initialStatus.executed)

  if (adopted.length > 0) {
    console.log("adopted_existing=")
    for (const migrationName of adopted) {
      console.log(`- ${migrationName}`)
    }
  }

  const status = await readStatus()
  printStatus(status.executed, status.pending)

  const blocked = await runPendingMigrations(status.pending)
  const finalStatus = await readStatus()

  if (blocked.length > 0) {
    console.log("final_status_after_partial_run=")
  }

  printStatus(finalStatus.executed, finalStatus.pending)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})