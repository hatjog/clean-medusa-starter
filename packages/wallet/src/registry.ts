import { AppleWalletProvider, type AppleWalletProviderConfig } from "./providers/apple"
import type { WalletPassProvider } from "./provider"
import type { WalletProviderRegistry } from "./facade"

/**
 * Opcje DI helpera `createWalletProviderRegistry`.
 *
 * DRIFT vs T3 brief: brief proponował pozycjonalny argument `googleProvider`,
 * tutaj używamy options-object aby (1) ułatwić Story 3.2 wpięcie `google`
 * bez breaking changes w sygnaturze, (2) umożliwić przekazanie opcjonalnego
 * `AppleWalletProviderConfig` (passTypeIdentifier / teamIdentifier / factory),
 * (3) zachować backward compat przy dodaniu kolejnych adapterów (D-108).
 *
 * Uwaga (F-06): `apple` config jest ignorowany gdy `WALLET_APPLE_ENABLED !== "true"`.
 * Pokryte testem "ignoruje apple config gdy flag-off".
 */
export interface CreateWalletProviderRegistryOptions {
  google?: WalletPassProvider
  apple?: AppleWalletProviderConfig
}

export function createWalletProviderRegistry(
  env: Pick<NodeJS.ProcessEnv, "WALLET_APPLE_ENABLED">,
  providers: CreateWalletProviderRegistryOptions = {}
): WalletProviderRegistry {
  const registry: WalletProviderRegistry = {}

  if (providers.google) {
    registry.google = providers.google
  }

  if (env.WALLET_APPLE_ENABLED === "true") {
    registry.apple = new AppleWalletProvider(providers.apple)
  }

  return registry
}
