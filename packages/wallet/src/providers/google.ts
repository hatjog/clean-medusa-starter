import type {
  WalletInvalidationReason,
  WalletLocale,
  WalletPayload,
} from "../payload"
import type { WalletPassProvider } from "../provider"
import {
  buildGoogleWalletClassId,
  buildGoogleWalletObjectId,
  GOOGLE_WALLET_SAVE_BASE,
  GoogleWalletConfigMissingError,
  resolveGoogleWalletProviderConfig,
  type GoogleWalletProviderConfig,
} from "./google-config"
import {
  GoogleWalletApiClient,
  GoogleWalletApiError,
} from "./google-api-client"
import {
  buildGoogleOfferClass,
  buildOfferClassPayload,
  GoogleWalletPayloadError,
  type GoogleWalletMarketBranding,
} from "./google-offer-class-mapper"
import {
  GoogleWalletSigningError,
  signSaveJWT,
} from "./google-jwt-signer"

export type GoogleWalletProviderAuditEventType =
  | "wallet_pass_generated"
  | "wallet_pass_generation_rejected"
  | "wallet_pass_invalidated"
  | "wallet_pass_invalidation_rejected"

export interface GoogleWalletProviderAuditEnvelope {
  event_type: GoogleWalletProviderAuditEventType
  provider: "google"
  entitlement_instance_id: string
  save_url?: string
  effective_locale?: WalletLocale
  reason?: WalletInvalidationReason
  outcome:
    | "success"
    | "rejected_google_api_error"
    | "rejected_google_wallet_config_missing"
    | "rejected_google_wallet_payload_invalid"
    | "rejected_google_wallet_signing_failed"
  error_code?: string
  error_message?: string
}

export interface GoogleWalletIssueResult {
  save_url: string
  audit_event: GoogleWalletProviderAuditEnvelope
}

export interface GoogleWalletInvalidateResult {
  audit_event: GoogleWalletProviderAuditEnvelope
}

export interface GoogleWalletProviderOptions {
  api_client?: Pick<GoogleWalletApiClient, "upsertOfferClass" | "patchOfferObject">
  signer?: typeof signSaveJWT
  now?: () => Date
  market_branding?: Partial<GoogleWalletMarketBranding>
}

export class GoogleWalletProviderIssueError extends Error {
  constructor(
    message: string,
    readonly audit_event: GoogleWalletProviderAuditEnvelope,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = "GoogleWalletProviderIssueError"
  }
}

export class GoogleWalletProviderInvalidationError extends Error {
  constructor(
    message: string,
    readonly audit_event: GoogleWalletProviderAuditEnvelope,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = "GoogleWalletProviderInvalidationError"
  }
}

export class GoogleWalletProvider implements WalletPassProvider {
  private readonly now: () => Date
  private readonly signer: typeof signSaveJWT
  private readonly injected_api_client?: Pick<
    GoogleWalletApiClient,
    "upsertOfferClass" | "patchOfferObject"
  >
  private readonly market_branding: Partial<GoogleWalletMarketBranding>
  // M3: config jest resolvowany leniwie (raz, przy pierwszym wywołaniu) i
  // cache'owany — eliminuje potrójną walidację (provider + signer + api-client)
  // i jednocześnie zachowuje audit envelope na fail-closed config.
  private cached_config?: GoogleWalletProviderConfig
  private cached_config_error?: GoogleWalletConfigMissingError
  private readonly raw_config: Partial<GoogleWalletProviderConfig>
  private api_client?: Pick<GoogleWalletApiClient, "upsertOfferClass" | "patchOfferObject">

  constructor(
    config: Partial<GoogleWalletProviderConfig>,
    options: GoogleWalletProviderOptions = {}
  ) {
    this.raw_config = config
    this.now = options.now ?? (() => new Date())
    this.signer = options.signer ?? signSaveJWT
    this.injected_api_client = options.api_client
    this.market_branding = options.market_branding ?? {}
  }

  async issueSaveUrl(
    payload: WalletPayload,
    locale: WalletLocale
  ): Promise<GoogleWalletIssueResult> {
    try {
      const config = this.resolveConfig()
      const class_id = buildGoogleWalletClassId(config)
      const object_id = buildGoogleWalletObjectId(
        class_id,
        payload.entitlement_instance_id
      )
      const branding = this.buildBranding(config, class_id, object_id)
      const offerClass = buildGoogleOfferClass(payload, locale, branding)
      // L2: przekazujemy zbudowany OfferClass jako prebuilt, żeby
      // buildOfferClassPayload nie powtarzał pracy po raz drugi.
      const offerObject = buildOfferClassPayload(
        payload,
        locale,
        branding,
        offerClass
      )

      await this.getApiClient(config).upsertOfferClass(offerClass)

      // L3: signer już nie dostaje offerClass — JWT przenosi tylko offerObject,
      // OfferClass leci wyłącznie kanałem HTTP (upsertOfferClass).
      const jwt = this.signer(offerObject, config, {
        now: this.now,
      })
      const save_url = `${config.origin_save_base ?? GOOGLE_WALLET_SAVE_BASE}${jwt}`
      const audit_event = this.successAudit(
        "wallet_pass_generated",
        payload.entitlement_instance_id,
        locale,
        save_url
      )

      return { save_url, audit_event }
    } catch (error) {
      throw this.issueError(payload.entitlement_instance_id, locale, error)
    }
  }

  async invalidate(
    entitlement_instance_id: string,
    reason: WalletInvalidationReason
  ): Promise<GoogleWalletInvalidateResult> {
    try {
      const config = this.resolveConfig()
      const class_id = buildGoogleWalletClassId(config)
      const object_id = buildGoogleWalletObjectId(
        class_id,
        entitlement_instance_id
      )

      await this.getApiClient(config).patchOfferObject(object_id, {
        state: "INACTIVE",
      })

      return {
        audit_event: {
          event_type: "wallet_pass_invalidated",
          provider: "google",
          entitlement_instance_id,
          reason,
          outcome: "success",
        },
      }
    } catch (error) {
      throw this.invalidationError(entitlement_instance_id, reason, error)
    }
  }

  private resolveConfig(): GoogleWalletProviderConfig {
    if (this.cached_config_error) throw this.cached_config_error
    if (this.cached_config) return this.cached_config

    try {
      this.cached_config = resolveGoogleWalletProviderConfig(this.raw_config)
    } catch (error) {
      if (error instanceof GoogleWalletConfigMissingError) {
        this.cached_config_error = error
      }
      throw error
    }

    return this.cached_config
  }

  private getApiClient(
    config: GoogleWalletProviderConfig
  ): Pick<GoogleWalletApiClient, "upsertOfferClass" | "patchOfferObject"> {
    if (this.injected_api_client) return this.injected_api_client
    if (!this.api_client) {
      this.api_client = new GoogleWalletApiClient(config)
    }

    return this.api_client
  }

  private buildBranding(
    config: GoogleWalletProviderConfig,
    class_id: string,
    object_id: string
  ): GoogleWalletMarketBranding {
    return {
      class_id,
      object_id,
      issuer_name: config.issuer_name ?? "Grow Platform",
      background: this.market_branding.background,
      logo: this.market_branding.logo,
      logo_url: this.market_branding.logo_url,
      salon_name: this.market_branding.salon_name,
      salon_address: this.market_branding.salon_address,
      latitude: this.market_branding.latitude,
      longitude: this.market_branding.longitude,
      localized_titles: this.market_branding.localized_titles,
      now: this.now,
    }
  }

  private successAudit(
    event_type: "wallet_pass_generated",
    entitlement_instance_id: string,
    effective_locale: WalletLocale,
    save_url: string
  ): GoogleWalletProviderAuditEnvelope {
    return {
      event_type,
      provider: "google",
      entitlement_instance_id,
      save_url,
      effective_locale,
      outcome: "success",
    }
  }

  private issueError(
    entitlement_instance_id: string,
    locale: WalletLocale,
    error: unknown
  ): Error {
    const audit_event = this.rejectedAudit(
      "wallet_pass_generation_rejected",
      entitlement_instance_id,
      locale,
      undefined,
      error
    )

    if (error instanceof GoogleWalletConfigMissingError) {
      return new GoogleWalletConfigMissingError(
        error.missing_fields,
        audit_event
      )
    }

    return new GoogleWalletProviderIssueError(
      "Google Wallet save URL generation failed",
      audit_event,
      error
    )
  }

  private invalidationError(
    entitlement_instance_id: string,
    reason: WalletInvalidationReason,
    error: unknown
  ): Error {
    const audit_event = this.rejectedAudit(
      "wallet_pass_invalidation_rejected",
      entitlement_instance_id,
      undefined,
      reason,
      error
    )

    if (error instanceof GoogleWalletConfigMissingError) {
      return new GoogleWalletConfigMissingError(
        error.missing_fields,
        audit_event
      )
    }

    return new GoogleWalletProviderInvalidationError(
      "Google Wallet pass invalidation failed",
      audit_event,
      error
    )
  }

  private rejectedAudit(
    event_type:
      | "wallet_pass_generation_rejected"
      | "wallet_pass_invalidation_rejected",
    entitlement_instance_id: string,
    effective_locale: WalletLocale | undefined,
    reason: WalletInvalidationReason | undefined,
    error: unknown
  ): GoogleWalletProviderAuditEnvelope {
    return {
      event_type,
      provider: "google",
      entitlement_instance_id,
      effective_locale,
      reason,
      outcome: rejectedOutcome(error),
      error_code: errorCode(error),
      error_message: errorMessage(error),
    }
  }
}

function rejectedOutcome(
  error: unknown
): GoogleWalletProviderAuditEnvelope["outcome"] {
  if (error instanceof GoogleWalletConfigMissingError) {
    return "rejected_google_wallet_config_missing"
  }
  if (error instanceof GoogleWalletPayloadError) {
    return "rejected_google_wallet_payload_invalid"
  }
  if (error instanceof GoogleWalletSigningError) {
    return "rejected_google_wallet_signing_failed"
  }
  return "rejected_google_api_error"
}

function errorCode(error: unknown): string {
  if (
    error instanceof GoogleWalletConfigMissingError ||
    error instanceof GoogleWalletPayloadError ||
    error instanceof GoogleWalletSigningError ||
    error instanceof GoogleWalletApiError
  ) {
    return error.error_code
  }

  return error instanceof Error ? error.name : "UNKNOWN_ERROR"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
