import {
  isWalletProviderKind,
  normalizeWalletLocale,
  type AuditEnvelope,
  type WalletInvalidationReason,
  type WalletProviderKind,
} from "./payload"
import type { WalletPayloadBuilder } from "./payload-builder"
import type { WalletPassProvider } from "./provider"

export interface WalletPassFacade {
  generatePass(
    entitlement_instance_id: string,
    provider: WalletProviderKind,
    locale: string
  ): Promise<{ save_url: string; audit_event: AuditEnvelope }>

  invalidatePass(
    entitlement_instance_id: string,
    provider: WalletProviderKind,
    reason: WalletInvalidationReason
  ): Promise<{ audit_event: AuditEnvelope }>
}

export type WalletProviderRegistry = Record<WalletProviderKind, WalletPassProvider>

export interface WalletPassFacadeOptions {
  now?: () => Date
}

export class UnsupportedWalletProviderError extends Error {
  constructor(readonly audit_event: AuditEnvelope) {
    super(`Unsupported wallet provider: ${audit_event.provider}`)
    this.name = "UnsupportedWalletProviderError"
  }
}

export class WalletPassGenerationError extends Error {
  constructor(
    message: string,
    readonly audit_event: AuditEnvelope,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = "WalletPassGenerationError"
  }
}

export class WalletPassInvalidationError extends Error {
  constructor(
    message: string,
    readonly audit_event: AuditEnvelope,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = "WalletPassInvalidationError"
  }
}

export class DefaultWalletPassFacade implements WalletPassFacade {
  private readonly now: () => Date

  constructor(
    private readonly providers: WalletProviderRegistry,
    private readonly payload_builder: WalletPayloadBuilder,
    options: WalletPassFacadeOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
  }

  async generatePass(
    entitlement_instance_id: string,
    provider: WalletProviderKind,
    locale: string
  ): Promise<{ save_url: string; audit_event: AuditEnvelope }> {
    const provider_impl = this.resolveProvider(
      entitlement_instance_id,
      provider,
      "wallet.pass_failed"
    )

    try {
      const normalized_locale = normalizeWalletLocale(locale)
      const payload = await this.payload_builder.buildFromEntitlement(
        entitlement_instance_id,
        normalized_locale
      )
      const { save_url } = await provider_impl.issueSaveUrl(
        payload,
        normalized_locale
      )
      const audit_event = this.createAuditEvent({
        event_type: "wallet.pass_generated",
        entitlement_instance_id,
        provider,
        save_url,
        outcome: "success",
      })

      return { save_url, audit_event }
    } catch (error) {
      const audit_event = this.createAuditEvent({
        event_type: "wallet.pass_failed",
        entitlement_instance_id,
        provider,
        outcome: "failure",
        error_code: errorName(error),
        error_message: errorMessage(error),
      })
      throw new WalletPassGenerationError(
        `Failed to generate wallet pass for entitlement_instance ${entitlement_instance_id}`,
        audit_event,
        error
      )
    }
  }

  async invalidatePass(
    entitlement_instance_id: string,
    provider: WalletProviderKind,
    reason: WalletInvalidationReason
  ): Promise<{ audit_event: AuditEnvelope }> {
    const provider_impl = this.resolveProvider(
      entitlement_instance_id,
      provider,
      "wallet.pass_invalidation_failed"
    )

    try {
      await provider_impl.invalidate(entitlement_instance_id, reason)
      const audit_event = this.createAuditEvent({
        event_type: "wallet.pass_invalidated",
        entitlement_instance_id,
        provider,
        reason,
        outcome: "success",
      })

      return { audit_event }
    } catch (error) {
      const audit_event = this.createAuditEvent({
        event_type: "wallet.pass_invalidation_failed",
        entitlement_instance_id,
        provider,
        reason,
        outcome: "failure",
        error_code: errorName(error),
        error_message: errorMessage(error),
      })
      throw new WalletPassInvalidationError(
        `Failed to invalidate wallet pass for entitlement_instance ${entitlement_instance_id}`,
        audit_event,
        error
      )
    }
  }

  private resolveProvider(
    entitlement_instance_id: string,
    provider: WalletProviderKind,
    failure_event_type:
      | "wallet.pass_failed"
      | "wallet.pass_invalidation_failed"
  ): WalletPassProvider {
    if (!isWalletProviderKind(provider)) {
      const audit_event = this.createAuditEvent({
        event_type: failure_event_type,
        entitlement_instance_id,
        provider: String(provider),
        outcome: "failure",
        error_code: "UNSUPPORTED_PROVIDER",
        error_message: `Unsupported wallet provider: ${String(provider)}`,
      })
      throw new UnsupportedWalletProviderError(audit_event)
    }

    return this.providers[provider]
  }

  private createAuditEvent(input: {
    event_type: AuditEnvelope["event_type"]
    entitlement_instance_id: string
    provider: string
    outcome: AuditEnvelope["outcome"]
    save_url?: string
    reason?: WalletInvalidationReason
    error_code?: string
    error_message?: string
  }): AuditEnvelope {
    return {
      event_type: input.event_type,
      entitlement_instance_id: input.entitlement_instance_id,
      provider: input.provider,
      save_url: input.save_url,
      reason: input.reason,
      timestamp: this.now().toISOString(),
      outcome: input.outcome,
      error_code: input.error_code,
      error_message: input.error_message,
    }
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UNKNOWN_ERROR"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
