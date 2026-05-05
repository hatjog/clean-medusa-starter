import type { Knex } from "knex"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

const TABLE = "operator_t30_kickoff"

type Scope = { resolve: (key: string) => unknown }

export type OperatorT30KickoffRecord = {
  id: string
  started_at: string
  t0_target: string
  triggered_by: string
  vendor_count: number
  admin_note: string | null
  override: boolean
  created_at: string
}

export type AppendOperatorT30KickoffInput = Omit<
  OperatorT30KickoffRecord,
  "id" | "created_at"
> & {
  id?: string
  created_at?: string
}

function resolveDb(scope: Scope): Knex {
  return scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
}

export async function appendOperatorT30Kickoff(
  scope: Scope,
  input: AppendOperatorT30KickoffInput,
): Promise<OperatorT30KickoffRecord> {
  const db = resolveDb(scope)
  const insert: Record<string, unknown> = {
    started_at: input.started_at,
    t0_target: input.t0_target,
    triggered_by: input.triggered_by,
    vendor_count: input.vendor_count,
    admin_note: input.admin_note ?? null,
    override: input.override,
  }

  if (input.id) insert.id = input.id
  if (input.created_at) insert.created_at = input.created_at

  const [row] = await db<OperatorT30KickoffRecord>(TABLE)
    .insert(insert)
    .returning("*")

  if (!row) {
    throw new Error("operator_t30_kickoff_insert_returned_no_row")
  }

  return row
}

export async function getLastOperatorT30Kickoff(
  scope: Scope,
): Promise<OperatorT30KickoffRecord | null> {
  const db = resolveDb(scope)
  const row = await db<OperatorT30KickoffRecord>(TABLE)
    .select("*")
    .orderBy("started_at", "desc")
    .first()

  return row ?? null
}