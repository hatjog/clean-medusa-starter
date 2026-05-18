import type { MedusaContainer } from "@medusajs/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import { configureMagicLinkRuntime } from "../lib/auth/magic-link"
import {
  PostgresMagicLinkStore,
  createMagicLinkRuntimeBindings,
} from "../lib/auth/magic-link-revocation"

export default async function magicLinkRuntimeLoader({
  container,
}: {
  container: MedusaContainer
}): Promise<void> {
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  const store = new PostgresMagicLinkStore(db)

  configureMagicLinkRuntime(createMagicLinkRuntimeBindings(store))
}
