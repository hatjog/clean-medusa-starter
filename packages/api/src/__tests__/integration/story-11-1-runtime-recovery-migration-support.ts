import type { PoolClient } from "pg"

import { Migration1779016000000 } from "../../modules/voucher/migrations/1779016000000_runtime_recovery_rls_boundary"

type SqlCollector = { addSql: (sql: string) => void }

async function collect(method: "up" | "down"): Promise<string[]> {
  const statements: string[] = []
  const collector: SqlCollector = { addSql: (sql) => statements.push(sql) }
  await Migration1779016000000.prototype[method].call(collector)
  return statements
}

/** Executes the actual Mikro-ORM migration SQL only inside the caller's test transaction. */
export async function applyRuntimeRecoveryMigration(client: PoolClient): Promise<void> {
  for (const statement of await collect("up")) {
    await client.query(statement)
  }
}

/** The migration is deliberately forward-fix-only; down must not remove history or scope. */
export async function rollbackRuntimeRecoveryMigration(client: PoolClient): Promise<void> {
  for (const statement of await collect("down")) {
    await client.query(statement)
  }
}

export async function runtimeRecoveryMigrationDownSql(): Promise<string[]> {
  return collect("down")
}
