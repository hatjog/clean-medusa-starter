import type { MedusaContainer } from "@medusajs/types"
import { asValue } from "awilix"
import { EnvSecretsAdapter } from "../lib/secrets/env-adapter"

export default async function secretsLoader({ container }: { container: MedusaContainer }): Promise<void> {
  const adapter = new EnvSecretsAdapter()
  container.register("secretsAdapter", asValue(adapter))
}
