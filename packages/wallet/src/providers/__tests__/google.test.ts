import { performance } from "node:perf_hooks"

import {
  GoogleWalletConfigMissingError,
  type GoogleWalletProviderConfig,
} from "../google-config"
import {
  GoogleWalletProvider,
  GoogleWalletProviderInvalidationError,
  GoogleWalletProviderIssueError,
} from "../google"
import { GoogleWalletSigningError } from "../google-jwt-signer"
import type { GoogleOfferObject } from "../google-offer-class-mapper"
import type { WalletPayload } from "../../payload"

const config: GoogleWalletProviderConfig = {
  issuer_id: "3388000000022223333",
  service_account_email: "wallet-demo@example.iam.gserviceaccount.com",
  private_key: "fake-private-key",
  class_id_template: "{issuer_id}.{market_code}_voucher_v1",
  origin_save_base: "https://pay.google.com/gp/v/save/",
  market_code: "bonbeauty",
  issuer_name: "Grow Platform",
}

const payload: WalletPayload & {
  salon_name: string
  salon_address: string
} = {
  entitlement_instance_id: "ei_123",
  code: "BB-2026-0001",
  title: "Voucher spa",
  status: "ACTIVE",
  expires_at: "2026-12-31T23:59:59.000Z",
  deep_link: "https://bonbeauty.example/pl/vouchers/BB-2026-0001",
  barcode_spec: { format: "QR", value: "QR-BB-2026-0001" },
  qr_code: "QR-BB-2026-0001",
  branding: {
    logo_url: "https://assets.example/logo.png",
    primary_color: "#111827",
    accent_color: "#C9A227",
  },
  locale: "pl-PL",
  salon_name: "BonBeauty Mokotow",
  salon_address: "ul. Testowa 1, Warszawa",
}

function createApiClient() {
  return {
    upsertOfferClass: jest.fn(async () => undefined),
    patchOfferObject: jest.fn(async () => undefined),
  }
}

describe("GoogleWalletProvider", () => {
  it("generuje save_url, upsertuje OfferClass i zwraca sub-envelope sukcesu", async () => {
    const api_client = createApiClient()
    const signer = jest.fn(() => "signed.jwt")
    const provider = new GoogleWalletProvider(config, {
      api_client,
      signer,
      now: () => new Date("2026-05-27T10:00:00.000Z"),
    })

    const result = await provider.issueSaveUrl(payload, "pl-PL")

    expect(result.save_url).toBe("https://pay.google.com/gp/v/save/signed.jwt")
    expect(result.audit_event).toMatchObject({
      event_type: "wallet_pass_generated",
      provider: "google",
      entitlement_instance_id: "ei_123",
      effective_locale: "pl-PL",
      outcome: "success",
    })
    expect(api_client.upsertOfferClass).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "3388000000022223333.bonbeauty_voucher_v1",
        provider: "BonBeauty Mokotow",
      })
    )
    expect(signer).toHaveBeenCalledWith(
      expect.objectContaining<Partial<GoogleOfferObject>>({
        id: "3388000000022223333.bonbeauty_voucher_v1.ei_123",
        classId: "3388000000022223333.bonbeauty_voucher_v1",
        redemptionCode: "BB-2026-0001",
      }),
      expect.objectContaining({ issuer_id: "3388000000022223333" }),
      expect.objectContaining({ offerClass: expect.any(Object) })
    )
  })

  it("fail-closed dla brakujacej konfiguracji Google Wallet", async () => {
    const provider = new GoogleWalletProvider({
      service_account_email: config.service_account_email,
      private_key: config.private_key,
    })

    await expect(provider.issueSaveUrl(payload, "pl-PL")).rejects.toMatchObject({
      name: "GoogleWalletConfigMissingError",
      error_code: "GOOGLE_WALLET_CONFIG_MISSING",
      audit_event: {
        event_type: "wallet_pass_generation_rejected",
        outcome: "rejected_google_wallet_config_missing",
      },
    } satisfies Partial<GoogleWalletConfigMissingError>)
  })

  it("opakowuje blad API w audit envelope rejected_google_api_error", async () => {
    const api_client = createApiClient()
    api_client.upsertOfferClass.mockRejectedValueOnce(new Error("api down"))
    const provider = new GoogleWalletProvider(config, {
      api_client,
      signer: jest.fn(() => "signed.jwt"),
    })

    await expect(provider.issueSaveUrl(payload, "pl-PL")).rejects.toMatchObject({
      name: "GoogleWalletProviderIssueError",
      audit_event: {
        event_type: "wallet_pass_generation_rejected",
        provider: "google",
        entitlement_instance_id: "ei_123",
        outcome: "rejected_google_api_error",
        error_code: "Error",
        error_message: "api down",
      },
    } satisfies Partial<GoogleWalletProviderIssueError>)
  })

  it("opakowuje blad payload jako rejected_google_wallet_payload_invalid", async () => {
    const provider = new GoogleWalletProvider(config, {
      api_client: createApiClient(),
      signer: jest.fn(() => "signed.jwt"),
    })

    await expect(
      provider.issueSaveUrl(
        {
          ...payload,
          salon_name: undefined,
        } as WalletPayload,
        "pl-PL"
      )
    ).rejects.toMatchObject({
      name: "GoogleWalletProviderIssueError",
      audit_event: {
        event_type: "wallet_pass_generation_rejected",
        provider: "google",
        entitlement_instance_id: "ei_123",
        outcome: "rejected_google_wallet_payload_invalid",
        error_code: "GOOGLE_WALLET_SALON_NAME_MISSING",
      },
    } satisfies Partial<GoogleWalletProviderIssueError>)
  })

  it("opakowuje blad podpisu jako rejected_google_wallet_signing_failed", async () => {
    const provider = new GoogleWalletProvider(config, {
      api_client: createApiClient(),
      signer: jest.fn(() => {
        throw new GoogleWalletSigningError("bad key")
      }),
    })

    await expect(provider.issueSaveUrl(payload, "pl-PL")).rejects.toMatchObject({
      name: "GoogleWalletProviderIssueError",
      audit_event: {
        event_type: "wallet_pass_generation_rejected",
        provider: "google",
        entitlement_instance_id: "ei_123",
        outcome: "rejected_google_wallet_signing_failed",
        error_code: "GOOGLE_WALLET_SIGNING_FAILED",
      },
    } satisfies Partial<GoogleWalletProviderIssueError>)
  })

  it("invalidate patchuje OfferObject jako INACTIVE i zwraca audit envelope", async () => {
    const api_client = createApiClient()
    const provider = new GoogleWalletProvider(config, { api_client })

    const result = await provider.invalidate("ei_123", "revoked")

    expect(api_client.patchOfferObject).toHaveBeenCalledWith(
      "3388000000022223333.bonbeauty_voucher_v1.ei_123",
      { state: "INACTIVE" }
    )
    expect(result.audit_event).toMatchObject({
      event_type: "wallet_pass_invalidated",
      provider: "google",
      entitlement_instance_id: "ei_123",
      reason: "revoked",
      outcome: "success",
    })
  })

  it("invalidate fail-closed dla brakujacej konfiguracji", async () => {
    const provider = new GoogleWalletProvider({
      issuer_id: config.issuer_id,
      service_account_email: config.service_account_email,
    })

    await expect(provider.invalidate("ei_123", "expired")).rejects.toMatchObject({
      name: "GoogleWalletConfigMissingError",
      error_code: "GOOGLE_WALLET_CONFIG_MISSING",
      audit_event: {
        event_type: "wallet_pass_invalidation_rejected",
        reason: "expired",
        outcome: "rejected_google_wallet_config_missing",
      },
    } satisfies Partial<GoogleWalletConfigMissingError>)
  })

  it("invalidate opakowuje blad API w audit envelope", async () => {
    const api_client = createApiClient()
    api_client.patchOfferObject.mockRejectedValueOnce(new Error("patch down"))
    const provider = new GoogleWalletProvider(config, { api_client })

    await expect(provider.invalidate("ei_123", "refunded")).rejects.toMatchObject({
      name: "GoogleWalletProviderInvalidationError",
      audit_event: {
        event_type: "wallet_pass_invalidation_rejected",
        provider: "google",
        entitlement_instance_id: "ei_123",
        reason: "refunded",
        outcome: "rejected_google_api_error",
        error_code: "Error",
        error_message: "patch down",
      },
    } satisfies Partial<GoogleWalletProviderInvalidationError>)
  })

  it("utrzymuje szybka sciezke CPU-only przy mockowanym API", async () => {
    const provider = new GoogleWalletProvider(config, {
      api_client: createApiClient(),
      signer: jest.fn(() => "signed.jwt"),
    })
    const started = performance.now()

    await provider.issueSaveUrl(payload, "pl-PL")

    expect(performance.now() - started).toBeLessThan(200)
  })
})
