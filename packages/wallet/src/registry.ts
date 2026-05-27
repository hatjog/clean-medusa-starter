import { AppleWalletProvider, type AppleWalletProviderConfig } from "./providers/apple"
import type { WalletPassProvider } from "./provider"
import type { WalletProviderRegistry } from "./facade"

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
