import {
  DefaultWalletPassFacade,
  UnsupportedWalletProviderError,
  WalletPassGenerationError,
  WalletPassInvalidationError,
  type WalletPassProvider,
  type WalletPayload,
  type WalletPayloadBuilder,
  type WalletProviderRegistry,
} from ".."

const timestamp = "2026-05-26T10:00:00.000Z"

const payload: WalletPayload = {
  entitlement_instance_id: "ei_123",
  code: "BB-2026-0001",
  title: "BonBeauty voucher",
  status: "ACTIVE",
  expires_at: "2026-12-31T23:59:59.000Z",
  deep_link: "https://bonbeauty.example/pl/vouchers/BB-2026-0001",
  barcode_spec: { format: "QR", value: "BB-2026-0001" },
  qr_code: "BB-2026-0001",
  branding: {
    logo_url: "https://assets.example/logo.svg",
    primary_color: "#111111",
    accent_color: "#22C55E",
  },
  locale: "pl-PL",
}

function createProvider(save_url: string): jest.Mocked<WalletPassProvider> {
  return {
    issueSaveUrl: jest.fn<
      ReturnType<WalletPassProvider["issueSaveUrl"]>,
      Parameters<WalletPassProvider["issueSaveUrl"]>
    >(async () => ({ save_url })),
    invalidate: jest.fn<
      ReturnType<WalletPassProvider["invalidate"]>,
      Parameters<WalletPassProvider["invalidate"]>
    >(async () => undefined),
  }
}

function createBuilder(): jest.Mocked<WalletPayloadBuilder> {
  return {
    build: jest.fn<
      ReturnType<WalletPayloadBuilder["build"]>,
      Parameters<WalletPayloadBuilder["build"]>
    >(() => payload),
    buildFromEntitlement: jest.fn<
      ReturnType<WalletPayloadBuilder["buildFromEntitlement"]>,
      Parameters<WalletPayloadBuilder["buildFromEntitlement"]>
    >(async () => payload),
  }
}

function createFacade(
  providers: WalletProviderRegistry,
  builder = createBuilder()
): DefaultWalletPassFacade {
  return new DefaultWalletPassFacade(providers, builder, {
    now: () => new Date(timestamp),
  })
}

describe("DefaultWalletPassFacade", () => {
  it.each([
    ["google" as const, "https://pay.google.com/gp/v/save/google-token"],
    ["apple" as const, "https://wallet.apple.example/pass/apple-token"],
  ])("generatePass delegates to %s provider", async (provider, save_url) => {
    const google = createProvider("https://pay.google.com/gp/v/save/google-token")
    const apple = createProvider("https://wallet.apple.example/pass/apple-token")
    const builder = createBuilder()
    const facade = createFacade({ google, apple }, builder)

    const result = await facade.generatePass("ei_123", provider, "pl-PL")

    expect(builder.buildFromEntitlement).toHaveBeenCalledWith("ei_123", "pl-PL")
    expect(result.save_url).toBe(save_url)
    expect(result.audit_event).toMatchObject({
      event_type: "wallet.pass_generated",
      entitlement_instance_id: "ei_123",
      provider,
      save_url,
      timestamp,
      outcome: "success",
    })
    expect(
      provider === "google" ? google.issueSaveUrl : apple.issueSaveUrl
    ).toHaveBeenCalledWith(payload, "pl-PL")
    expect(
      provider === "google" ? apple.issueSaveUrl : google.issueSaveUrl
    ).not.toHaveBeenCalled()
  })

  it("normalizes unsupported locale before delegating to builder and provider", async () => {
    const google = createProvider("https://pay.google.com/gp/v/save/token")
    const apple = createProvider("https://wallet.apple.example/pass/token")
    const builder = createBuilder()
    const facade = createFacade({ google, apple }, builder)

    await facade.generatePass("ei_123", "google", "fr-FR")

    expect(builder.buildFromEntitlement).toHaveBeenCalledWith("ei_123", "pl-PL")
    expect(google.issueSaveUrl).toHaveBeenCalledWith(payload, "pl-PL")
  })

  it("uses runtime clock when no fixed clock is injected", async () => {
    const facade = new DefaultWalletPassFacade(
      {
        google: createProvider("https://pay.google.com/gp/v/save/token"),
        apple: createProvider("https://wallet.apple.example/pass/token"),
      },
      createBuilder()
    )

    const result = await facade.generatePass("ei_123", "google", "pl-PL")

    expect(Date.parse(result.audit_event.timestamp)).not.toBeNaN()
  })

  it("throws UnsupportedWalletProviderError with audit envelope for enum mismatch", async () => {
    const facade = createFacade({
      google: createProvider("https://pay.google.com/gp/v/save/token"),
      apple: createProvider("https://wallet.apple.example/pass/token"),
    })

    await expect(
      facade.generatePass("ei_123", "samsung" as never, "pl-PL")
    ).rejects.toMatchObject({
      name: "UnsupportedWalletProviderError",
      audit_event: {
        event_type: "wallet.pass_failed",
        entitlement_instance_id: "ei_123",
        provider: "samsung",
        timestamp,
        outcome: "failure",
        error_code: "UNSUPPORTED_PROVIDER",
      },
    } satisfies Partial<UnsupportedWalletProviderError>)
  })

  it("throws UnsupportedWalletProviderError for invalidate enum mismatch", async () => {
    const facade = createFacade({
      google: createProvider("https://pay.google.com/gp/v/save/token"),
      apple: createProvider("https://wallet.apple.example/pass/token"),
    })

    await expect(
      facade.invalidatePass("ei_123", "samsung" as never, "revoked")
    ).rejects.toMatchObject({
      name: "UnsupportedWalletProviderError",
      audit_event: {
        event_type: "wallet.pass_invalidation_failed",
        entitlement_instance_id: "ei_123",
        provider: "samsung",
        timestamp,
        outcome: "failure",
        error_code: "UNSUPPORTED_PROVIDER",
      },
    } satisfies Partial<UnsupportedWalletProviderError>)
  })

  it("wraps provider failure and preserves failure audit event", async () => {
    const google = createProvider("https://pay.google.com/gp/v/save/token")
    google.issueSaveUrl.mockRejectedValueOnce(new Error("provider down"))
    const facade = createFacade({
      google,
      apple: createProvider("https://wallet.apple.example/pass/token"),
    })

    await expect(facade.generatePass("ei_123", "google", "pl-PL")).rejects.toMatchObject({
      name: "WalletPassGenerationError",
      cause: expect.any(Error),
      audit_event: {
        event_type: "wallet.pass_failed",
        entitlement_instance_id: "ei_123",
        provider: "google",
        timestamp,
        outcome: "failure",
        error_code: "Error",
        error_message: "provider down",
      },
    } satisfies Partial<WalletPassGenerationError>)
  })

  it("wraps non-Error builder failure with failure audit event", async () => {
    const builder = createBuilder()
    builder.buildFromEntitlement.mockRejectedValueOnce("read model unavailable")
    const facade = createFacade(
      {
        google: createProvider("https://pay.google.com/gp/v/save/token"),
        apple: createProvider("https://wallet.apple.example/pass/token"),
      },
      builder
    )

    await expect(facade.generatePass("ei_123", "google", "pl-PL")).rejects.toMatchObject({
      name: "WalletPassGenerationError",
      audit_event: {
        event_type: "wallet.pass_failed",
        entitlement_instance_id: "ei_123",
        provider: "google",
        timestamp,
        outcome: "failure",
        error_code: "UNKNOWN_ERROR",
        error_message: "read model unavailable",
      },
    } satisfies Partial<WalletPassGenerationError>)
  })

  it("invalidatePass delegates to provider and returns audit event with reason", async () => {
    const google = createProvider("https://pay.google.com/gp/v/save/token")
    const facade = createFacade({
      google,
      apple: createProvider("https://wallet.apple.example/pass/token"),
    })

    const result = await facade.invalidatePass("ei_123", "google", "revoked")

    expect(google.invalidate).toHaveBeenCalledWith("ei_123", "revoked")
    expect(result.audit_event).toMatchObject({
      event_type: "wallet.pass_invalidated",
      entitlement_instance_id: "ei_123",
      provider: "google",
      reason: "revoked",
      timestamp,
      outcome: "success",
    })
  })

  it("wraps invalidate failure and preserves failure audit event", async () => {
    const apple = createProvider("https://wallet.apple.example/pass/token")
    apple.invalidate.mockRejectedValueOnce(new Error("revocation rejected"))
    const facade = createFacade({
      google: createProvider("https://pay.google.com/gp/v/save/token"),
      apple,
    })

    await expect(facade.invalidatePass("ei_123", "apple", "refunded")).rejects.toMatchObject({
      name: "WalletPassInvalidationError",
      audit_event: {
        event_type: "wallet.pass_invalidation_failed",
        entitlement_instance_id: "ei_123",
        provider: "apple",
        reason: "refunded",
        timestamp,
        outcome: "failure",
        error_message: "revocation rejected",
      },
    } satisfies Partial<WalletPassInvalidationError>)
  })
})
