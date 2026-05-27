import type {
  AuditEnvelope,
  WalletPassStatus,
  WalletProviderKind,
} from "./payload"

export type WalletDenyReason =
  | "market_not_ratified"
  | "release_not_promotable"
  | "actor_not_p4_recipient"
  | "lifecycle_not_active"
  | "provider_disabled"

export interface WalletActorContext {
  actor_id: string
  persona: "P4_recipient" | string
}

export type EntitlementLifecycleStatus =
  | WalletPassStatus
  | "PARTIALLY_REDEEMED"
  | "VOIDED"

export interface WalletFeaturePolicyInput {
  entitlement_instance_id: string
  market: string
  release: string
  actor: WalletActorContext
  lifecycle: EntitlementLifecycleStatus
  provider: WalletProviderKind
}

export type WalletFeaturePolicyResult =
  | { allowed: true }
  | { allowed: false; reason: WalletDenyReason; audit_event: AuditEnvelope }

export interface WalletFeaturePolicy {
  check(input: WalletFeaturePolicyInput): Promise<WalletFeaturePolicyResult>
}

export interface WalletMarketRegistry {
  isWalletRatified(market: string): Promise<boolean>
}

export interface ReleasePromotabilityProbe {
  isPromotable(release: string): Promise<boolean>
}

export interface WalletProviderReadiness {
  isEnabled(provider: WalletProviderKind): Promise<boolean>
}

export interface WalletFeaturePolicyDependencies {
  marketRegistry: WalletMarketRegistry
  releasePromotability: ReleasePromotabilityProbe
  providerReadiness: WalletProviderReadiness
  clock?: () => Date
}

export class DefaultWalletFeaturePolicy implements WalletFeaturePolicy {
  private readonly clock: () => Date

  constructor(private readonly deps: WalletFeaturePolicyDependencies) {
    this.clock = deps.clock ?? (() => new Date())
  }

  async check(
    input: WalletFeaturePolicyInput
  ): Promise<WalletFeaturePolicyResult> {
    if (!(await this.deps.marketRegistry.isWalletRatified(input.market))) {
      return this.deny(input, "market_not_ratified")
    }

    if (!(await this.deps.releasePromotability.isPromotable(input.release))) {
      return this.deny(input, "release_not_promotable")
    }

    if (input.actor.persona !== "P4_recipient") {
      return this.deny(input, "actor_not_p4_recipient")
    }

    if (input.lifecycle !== "ACTIVE") {
      return this.deny(input, "lifecycle_not_active")
    }

    if (!(await this.deps.providerReadiness.isEnabled(input.provider))) {
      return this.deny(input, "provider_disabled")
    }

    return { allowed: true }
  }

  private deny(
    input: WalletFeaturePolicyInput,
    reason: WalletDenyReason
  ): WalletFeaturePolicyResult {
    return {
      allowed: false,
      reason,
      audit_event: {
        event_type: "wallet.pass_gated",
        entitlement_instance_id: input.entitlement_instance_id,
        provider: input.provider,
        market: input.market,
        release: input.release,
        actor_id: input.actor.actor_id,
        lifecycle: input.lifecycle,
        timestamp: this.clock().toISOString(),
        outcome: `rejected_${reason}`,
        gate_reason: reason,
      },
    }
  }
}

export class EnvWalletProviderReadiness implements WalletProviderReadiness {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async isEnabled(provider: WalletProviderKind): Promise<boolean> {
    const raw =
      provider === "google"
        ? this.env.WALLET_GOOGLE_ENABLED
        : this.env.WALLET_APPLE_ENABLED
    const defaultValue = provider === "google"

    return parseWalletFlag(raw, defaultValue)
  }
}

function parseWalletFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
}
