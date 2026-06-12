import {
  isWalletProviderKind,
  normalizeWalletLocale,
  type WalletAuditEnvelope,
  type WalletInvalidationReason,
  type WalletLocale,
  type WalletProviderKind,
} from "./payload"
import { toAuditProvider } from "@gp/audit"
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
  ): Promise<{ save_url: string; audit_event: WalletAuditEnvelope }>

  invalidatePass(
    entitlement_instance_id: string,
    provider: WalletProviderKind,
    reason: WalletInvalidationReason
  ): Promise<{ audit_event: WalletAuditEnvelope }>
}

export type WalletProviderRegistry = Partial<
  Record<WalletProviderKind, WalletPassProvider>
>

export interface WalletPassFacadeOptions {
  now?: () => Date
}

export class UnsupportedWalletProviderError extends Error {
  constructor(readonly audit_event: WalletAuditEnvelope) {
    super(`Unsupported wallet provider: ${audit_event.provider}`)
    this.name = "UnsupportedWalletProviderError"
  }
}

export class WalletPassGenerationError extends Error {
  constructor(
    message: string,
    readonly audit_event: WalletAuditEnvelope,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = "WalletPassGenerationError"
  }
}

export class WalletPassInvalidationError extends Error {
  constructor(
    message: string,
    readonly audit_event: WalletAuditEnvelope,
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
  ): Promise<{ save_url: string; audit_event: WalletAuditEnvelope }> {
    const requested_locale = String(locale)
    // R-H2 (phase-4): extract a safe stringified id once and reuse in every
    // pre-payload guard catch path. The previous code passed the raw
    // `entitlement_instance_id` variable into the second guard's emit, which
    // for non-string truthy inputs (object/number) produced distinct_ids like
    // `actor:P4:[object Object]` and broke the funnel-join contract.
    const safeInstanceId = String(entitlement_instance_id ?? "")

    // R-H6 (phase-4): `normalizeWalletLocale` can throw on unknown locales,
    // and it used to run BEFORE the P2 try/catch — silently swallowing the
    // very pre-payload failure P2 was supposed to surface. Wrap it; on
    // throw, emit pass_failed (failure_code='client_error', locale='unknown'),
    // then re-throw.
    let effective_locale: WalletLocale
    try {
      effective_locale = normalizeWalletLocale(requested_locale)
    } catch (error) {
      emitWalletCounter("pass_failed", {
        provider,
        market: "unknown",
        locale: "pl-PL",
        actor: "P4",
        entitlement_type: "unknown",
        entitlement_instance_id: safeInstanceId,
        failure_code: "client_error",
        error_message: sanitizeWalletErrorMessage("invalid_locale"),
      })
      throw error
    }

    // P2: emit `pass_failed` for pre-payload-build failures too. The previous
    // implementation threw out of `requireEntitlementInstanceId` /
    // `resolveProvider` BEFORE entering the try/catch block, so failures
    // from missing entitlement id, unsupported provider, or unregistered DI
    // never surfaced on the PostHog counter.
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
        entitlement_instance_id: safeInstanceId,
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
        // R-H2 (phase-4): consistent safe stringified id (was raw variable).
        entitlement_instance_id: safeInstanceId,
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
  ): Promise<{ audit_event: WalletAuditEnvelope }> {
    // R-H3 (phase-4): mirror P2 pre-payload guard wrapping for
    // `invalidatePass`. Previously these guards threw outside any try/catch
    // and bypassed telemetry entirely on missing id / unsupported provider /
    // unregistered DI. Emit `pass_failed` (re-using the v1.10.0 enum since
    // there is no separate `pass_invalidation_failed` counter), then re-throw.
    const safeInstanceId = String(entitlement_instance_id ?? "")

    try {
      this.requireEntitlementInstanceId(
        entitlement_instance_id,
        provider,
        "wallet.pass_invalidation_failed",
        reason
      )
    } catch (error) {
      emitWalletCounter("pass_failed", {
        provider,
        market: "unknown",
        locale: "pl-PL",
        actor: "P4",
        entitlement_type: "unknown",
        entitlement_instance_id: safeInstanceId,
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
        "wallet.pass_invalidation_failed",
        reason
      )
    } catch (error) {
      emitWalletCounter("pass_failed", {
        provider,
        market: "unknown",
        locale: "pl-PL",
        actor: "P4",
        entitlement_type: "unknown",
        entitlement_instance_id: safeInstanceId,
        failure_code: "provider_error",
        error_message: sanitizeWalletErrorMessage(errorMessage(error)),
      })
      throw error
    }

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
    event_type: WalletAuditEnvelope["event_type"]
    entitlement_instance_id: string
    provider: string
    outcome: WalletAuditEnvelope["outcome"]
    save_url?: string
    reason?: WalletInvalidationReason
    error_code?: string
    error_message?: string
    requested_locale?: string
    effective_locale?: WalletLocale
  }): WalletAuditEnvelope {
    return {
      event_type: input.event_type,
      entitlement_instance_id: input.entitlement_instance_id,
      provider: toAuditProvider(input.provider),
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
