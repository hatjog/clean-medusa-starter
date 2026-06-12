import { toAuditProvider } from "@gp/audit"
import type {
  EntitlementLifecycleStatus,
  WalletAuditEnvelope,
  WalletDenyReason,
  WalletInvalidationReason,
  WalletProviderKind,
} from "./payload"

export type { EntitlementLifecycleStatus, WalletDenyReason } from "./payload"

// Persona aktora wallet — zamknięta lista czterech person zgodnych z architecture
// §282 (P1 admin / P2 vendor / P3 buyer / P4 recipient). Gate akceptuje wyłącznie
// `P4_recipient`; pozostałe → `actor_not_p4_recipient`. Lista zamknięta zapobiega
// erozji typu przez literałową unię z `string`.
export type WalletPersona =
  | "P4_recipient"
  | "P3_buyer"
  | "P2_vendor"
  | "P1_admin"

export interface WalletActorContext {
  actor_id: string
  persona: WalletPersona
}

// Mapowanie `WalletInvalidationReason` (Story 3.6 subscriber) na lifecycle gate'a
// D-110. Caller (route handler / subscriber) MUSI zmapować invalidation reason
// na lifecycle przed wywołaniem `check()` — gate nie zna invalidation semantyki.
export function mapWalletInvalidationReasonToLifecycle(
  reason: WalletInvalidationReason
): EntitlementLifecycleStatus {
  switch (reason) {
    case "expired":
      return "EXPIRED"
    case "revoked":
    case "refunded":
      // D-110 nie posiada osobnych statusów REVOKED/REFUNDED — oba reasony
      // kończą lifecycle w stanie VOIDED (terminal, non-recoverable).
      return "VOIDED"
  }
}

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
  | { allowed: false; reason: WalletDenyReason; audit_event: WalletAuditEnvelope }

export interface WalletFeaturePolicy {
  check(input: WalletFeaturePolicyInput): Promise<WalletFeaturePolicyResult>
}

export interface WalletMarketRegistry {
  isWalletRatified(market: string): Promise<boolean>
}

export interface ReleasePromotabilityProbe {
  isPromotable(release: string): Promise<boolean>
}

// F-10: sygnatura `isEnabled` jest async, ponieważ port docelowo może czytać ze
// zdalnego flag store (np. Redis / gp-config IO); domyślna `EnvWalletProviderReadiness`
// jest synchroniczna w środku, ale interfejs nie wymusza tego konsumentom.
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

  // Side-effect free. Błąd portu (`marketRegistry`, `releasePromotability`,
  // `providerReadiness`) propagowany jest do callera — caller jest odpowiedzialny
  // za fail-closed obsługę (D-112): złapać wyjątek, wyemitować audit envelope
  // `outcome: "failure"` oraz odpowiedzieć HTTP 5xx zamiast wpuszczać użytkownika.
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
        provider: toAuditProvider(input.provider),
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

const TRUTHY_FLAG_VALUES = new Set(["1", "true", "yes", "on"])
const FALSY_FLAG_VALUES = new Set(["0", "false", "no", "off"])

// F-05: explicit allowlist + denylist. Pusty string oraz wartości spoza obu list
// nie zmieniają defaultu — chroni przed nieintencjonalnym wyłączeniem providera
// przez pomyłkowy `WALLET_GOOGLE_ENABLED=""` w `.env`. Nieznane wartości produkują
// `console.warn`, aby ułatwić diagnostykę bez zatrzymywania startu procesu.
export function parseWalletFlag(
  value: string | undefined,
  defaultValue: boolean
): boolean {
  if (value === undefined) {
    return defaultValue
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === "") {
    return defaultValue
  }
  if (TRUTHY_FLAG_VALUES.has(normalized)) {
    return true
  }
  if (FALSY_FLAG_VALUES.has(normalized)) {
    return false
  }

  // eslint-disable-next-line no-console
  console.warn(
    `[wallet/policy] Nieznana wartość flagi providera: "${value}". Używam wartości domyślnej ${defaultValue}.`
  )
  return defaultValue
}
