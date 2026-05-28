import type { WalletLocale, WalletProviderKind } from "../payload"

export const WALLET_COUNTERS = [
  "pass_generated",
  "pass_failed",
  "pass_gated",
] as const

export type WalletCounter = (typeof WALLET_COUNTERS)[number]

// P25 (D2): extended with `auth_expired` and `client_error` to disambiguate
// non-network catch-all paths in apps/web `classifyHttpFailureCode`. Keep this
// in lockstep with the duplicates in
//   apps/web/src/lib/telemetry/wallet.ts
//   GP/storefront/src/lib/telemetry/wallet.ts
// and the runbook property schema enumeration.
export type WalletFailureCode =
  | "provider_error"
  | "network"
  | "policy_deny"
  | "auth_expired"
  | "client_error"

// TODO(F13): re-export `WalletGateReason` from `@gp/wallet/policy` once Story
// 3.4 (WalletFeaturePolicy) lands so this enum is not duplicated. Until then
// keep this list in sync with the policy SSOT — adding a new reason here
// without updating the policy will surface a TS error at the call site.
export type WalletGateReason =
  | "market_not_pilot"
  | "apple_disabled"
  | "release_pre_flag_flip"
  | "lifecycle_invalidated"

export interface WalletCounterCommonProps {
  provider: WalletProviderKind
  market: string
  locale: WalletLocale
  actor: "P4"
  entitlement_type: string
  entitlement_instance_id: string
}

export type WalletCounterProps =
  | WalletCounterCommonProps
  | (WalletCounterCommonProps & {
      failure_code: WalletFailureCode
      error_message: string
    })
  | (WalletCounterCommonProps & {
      gate_reason: WalletGateReason
    })

export interface PostHogCaptureClient {
  capture(input: {
    distinctId: string
    event: string
    properties: Record<string, unknown>
  }): void
  shutdown?(): Promise<void> | void
  flush?(): Promise<void> | void
}

export interface SentryCaptureClient {
  captureMessage(
    message: string,
    context?: { extra?: Record<string, unknown> }
  ): void
}
