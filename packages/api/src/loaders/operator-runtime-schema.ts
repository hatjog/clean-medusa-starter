import type { MedusaContainer } from "@medusajs/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import { ensureOperatorRuntimeSchema } from "../lib/operator-runtime-schema"

export default async function operatorRuntimeSchemaLoader({
  container,
}: {
  container: MedusaContainer
}): Promise<void> {
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  await ensureOperatorRuntimeSchema(db)
}