import {
  isWalletProviderKind,
  normalizeWalletLocale,
  type AuditEnvelope,
  type WalletInvalidationReason,
  type WalletLocale,
  type WalletProviderKind,
} from "./payload"
import type { WalletPayloadBuilder } from "./payload-builder"
import type { WalletPassProvider } from "./provider"
import { emitWalletCounter, sanitizeWalletErrorMessage } from "./telemetry"

export interface WalletPassFacade {
  /**
   * Generuje wallet pass dla danego entitlement_instance.
   *
   * @param entitlement_instance_id - L4 entitlement_instance ID (non-empty).
   * @param provider - kanoniczny `WalletProviderKind` ("google" | "apple").
   * @param locale - kanoniczny BCP 47 locale z `WALLET_LOCALES`. Jeśli caller
   *   poda string spoza unionu (np. via cast / JS), facade zaaplikuje silent
   *   fallback do "pl-PL" oraz oznaczy to w `audit_event.requested_locale`
   *   oraz `audit_event.effective_locale`.
   */
  generatePass(
    entitlement_instance_id: string,
    provider: WalletProviderKind,
    locale: WalletLocale
  ): Promise<{ save_url: string; audit_event: AuditEnvelope }>

  invalidatePass(
    entitlement_instance_id: string,
    provider: WalletProviderKind,
    reason: WalletInvalidationReason
  ): Promise<{ audit_event: AuditEnvelope }>
}

export type WalletProviderRegistry = Partial<
  Record<WalletProviderKind, WalletPassProvider>
>

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
    locale: WalletLocale
  ): Promise<{ save_url: string; audit_event: AuditEnvelope }> {
    const requested_locale = String(locale)
    const effective_locale = normalizeWalletLocale(requested_locale)

    // P2: emit `pass_failed` for pre-payload-build failures too. The previous
    // implementation threw out of `requireEntitlementInstanceId` /
    // `resolveProvider` BEFORE entering the try/catch block, so failures
    // from missing entitlement id, unsupported provider, or unregistered DI
    // never surfaced on the PostHog counter. We catch the throw, emit a
    // counter with `failure_code='provider_error'` (or 'client_error' for
    // shape problems), then re-throw the original error so callers /
    // audit-envelope semantics are preserved.
    try {
      this.requireEntitlementInstanceId(
        entitlement_instance_id,
        provider,
        "wallet.pass_failed"
      )
    } catch (error) {
      emitWalletCounter("pass_failed", {
        provider,
        market: "unknown",
        locale: effective_locale,
        actor: "P4",
        entitlement_type: "unknown",
        entitlement_instance_id: String(entitlement_instance_id ?? ""),
        failure_code: "client_error",
        error_message: sanitizeWalletErrorMessage(errorMessage(error)),
      })
      throw error
    }

    let provider_impl: WalletPassProvider
    try {
      provider_impl = this.resolveProvider(
        entitlement_instance_id,
        provider,
        "wallet.pass_failed"
      )
    } catch (error) {
      emitWalletCounter("pass_failed", {
        provider,
        market: "unknown",
        locale: effective_locale,
        actor: "P4",
        entitlement_type: "unknown",
        entitlement_instance_id,
        failure_code: "provider_error",
        error_message: sanitizeWalletErrorMessage(errorMessage(error)),
      })
      throw error
    }

    // F2: capture market / entitlement_type as soon as the payload is built so
    // that the catch path can report the best known values instead of falling
    // back to "unknown" on every provider failure (which destroys per-market
    // breakdown of `wallet.pass_failed`).
    let market = "unknown"
    let entitlement_type = "unknown"

    try {
      const payload = await this.payload_builder.buildFromEntitlement(
        entitlement_instance_id,
        effective_locale
      )
      market = payload.market
      entitlement_type = payload.entitlement_type
      const { save_url } = await provider_impl.issueSaveUrl(
        payload,
        effective_locale
      )
      const audit_event = this.createAuditEvent({
        event_type: "wallet.pass_generated",
        entitlement_instance_id,
        provider,
        save_url,
        outcome: "success",
        requested_locale,
        effective_locale,
      })
      emitWalletCounter("pass_generated", {
        provider,
        market: payload.market,
        locale: effective_locale,
        actor: "P4",
        entitlement_type: payload.entitlement_type,
        entitlement_instance_id,
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
        requested_locale,
        effective_locale,
      })
      emitWalletCounter("pass_failed", {
        provider,
        market,
        locale: effective_locale,
        actor: "P4",
        entitlement_type,
        entitlement_instance_id,
        failure_code: "provider_error",
        error_message: sanitizeWalletErrorMessage(errorMessage(error)),
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
    this.requireEntitlementInstanceId(
      entitlement_instance_id,
      provider,
      "wallet.pass_invalidation_failed",
      reason
    )

    const provider_impl = this.resolveProvider(
      entitlement_instance_id,
      provider,
      "wallet.pass_invalidation_failed",
      reason
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

  private requireEntitlementInstanceId(
    entitlement_instance_id: string,
    provider: WalletProviderKind,
    failure_event_type:
      | "wallet.pass_failed"
      | "wallet.pass_invalidation_failed",
    reason?: WalletInvalidationReason
  ): void {
    if (
      typeof entitlement_instance_id !== "string" ||
      entitlement_instance_id.trim().length === 0
    ) {
      const audit_event = this.createAuditEvent({
        event_type: failure_event_type,
        entitlement_instance_id: String(entitlement_instance_id ?? ""),
        provider: String(provider),
        outcome: "failure",
        error_code: "ENTITLEMENT_INSTANCE_ID_MISSING",
        error_message: "entitlement_instance_id is required and must be a non-empty string",
        reason,
      })
      const ErrorCtor =
        failure_event_type === "wallet.pass_failed"
          ? WalletPassGenerationError
          : WalletPassInvalidationError
      throw new ErrorCtor(
        "entitlement_instance_id is required and must be a non-empty string",
        audit_event
      )
    }
  }

  private resolveProvider(
    entitlement_instance_id: string,
    provider: WalletProviderKind,
    failure_event_type:
      | "wallet.pass_failed"
      | "wallet.pass_invalidation_failed",
    reason?: WalletInvalidationReason
  ): WalletPassProvider {
    if (!isWalletProviderKind(provider)) {
      const audit_event = this.createAuditEvent({
        event_type: failure_event_type,
        entitlement_instance_id,
        provider: String(provider),
        outcome: "failure",
        error_code: "UNSUPPORTED_PROVIDER",
        error_message: `Unsupported wallet provider: ${String(provider)}`,
        reason,
      })
      throw new UnsupportedWalletProviderError(audit_event)
    }

    const impl = this.providers[provider]
    if (!impl) {
      const audit_event = this.createAuditEvent({
        event_type: failure_event_type,
        entitlement_instance_id,
        provider,
        outcome: "failure",
        error_code: "PROVIDER_NOT_REGISTERED",
        error_message: `Wallet provider not registered in DI: ${provider}`,
        reason,
      })
      throw new UnsupportedWalletProviderError(audit_event)
    }

    return impl
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
    requested_locale?: string
    effective_locale?: WalletLocale
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
      requested_locale: input.requested_locale,
      effective_locale: input.effective_locale,
    }
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UNKNOWN_ERROR"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
