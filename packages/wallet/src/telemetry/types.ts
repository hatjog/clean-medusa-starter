import type { WalletLocale, WalletProviderKind } from "../payload"

export const WALLET_COUNTERS = [
  "pass_generated",
  "pass_failed",
  "pass_gated",
] as const

export type WalletCounter = (typeof WALLET_COUNTERS)[number]

export type WalletFailureCode = "provider_error" | "network" | "policy_deny"

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
}

export interface SentryCaptureClient {
  captureMessage(
    message: string,
    context?: { extra?: Record<string, unknown> }
  ): void
}
