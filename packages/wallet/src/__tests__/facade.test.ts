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
  market: "bonbeauty",
  entitlement_type: "voucher",
  status: "ACTIVE",
  expires_at: "2026-12-31T23:59:59.000Z",
  salon_name: "BonBeauty Warszawa Mokotów",
  salon_address: "ul. Puławska 123, Warszawa",
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

  it("normalizes unsupported locale and records requested/effective in audit envelope (F-04)", async () => {
    const google = createProvider("https://pay.google.com/gp/v/save/token")
    const apple = createProvider("https://wallet.apple.example/pass/token")
    const builder = createBuilder()
    const facade = createFacade({ google, apple }, builder)

    // Cast symuluje niekanoniczny locale z JS callera albo luznego rzutowania.
    const result = await facade.generatePass(
      "ei_123",
      "google",
      "fr-FR" as never
    )

    expect(builder.buildFromEntitlement).toHaveBeenCalledWith("ei_123", "pl-PL")
    expect(google.issueSaveUrl).toHaveBeenCalledWith(payload, "pl-PL")
    expect(result.audit_event.requested_locale).toBe("fr-FR")
    expect(result.audit_event.effective_locale).toBe("pl-PL")
  })

  it("preserves canonical locale in audit envelope when caller passes it cleanly", async () => {
    const google = createProvider("https://pay.google.com/gp/v/save/token")
    const apple = createProvider("https://wallet.apple.example/pass/token")
    const facade = createFacade({ google, apple })

    const result = await facade.generatePass("ei_123", "google", "en-US")

    expect(result.audit_event.requested_locale).toBe("en-US")
    expect(result.audit_event.effective_locale).toBe("en-US")
  })

  it("throws UnsupportedWalletProviderError with PROVIDER_NOT_REGISTERED when provider is missing in registry (F-01)", async () => {
    // v1.10.0 Apple flag-off: DI rejestruje tylko `google`.
    const google = createProvider("https://pay.google.com/gp/v/save/token")
    const facade = new DefaultWalletPassFacade({ google }, createBuilder(), {
      now: () => new Date(timestamp),
    })

    await expect(facade.generatePass("ei_123", "apple", "pl-PL")).rejects.toMatchObject({
      name: "UnsupportedWalletProviderError",
      audit_event: {
        event_type: "wallet.pass_failed",
        entitlement_instance_id: "ei_123",
        provider: "apple",
        timestamp,
        outcome: "failure",
        error_code: "PROVIDER_NOT_REGISTERED",
      },
    } satisfies Partial<UnsupportedWalletProviderError>)
  })

  it("invalidatePass also raises PROVIDER_NOT_REGISTERED with reason in audit (F-01 invalidate path)", async () => {
    const google = createProvider("https://pay.google.com/gp/v/save/token")
    const facade = new DefaultWalletPassFacade({ google }, createBuilder(), {
      now: () => new Date(timestamp),
    })

    await expect(
      facade.invalidatePass("ei_123", "apple", "revoked")
    ).rejects.toMatchObject({
      name: "UnsupportedWalletProviderError",
      audit_event: {
        event_type: "wallet.pass_invalidation_failed",
        provider: "apple",
        reason: "revoked",
        error_code: "PROVIDER_NOT_REGISTERED",
      },
    })
  })

  it.each([
    ["", "generatePass"],
    ["   ", "generatePass"],
  ])(
    "rejects empty entitlement_instance_id %p in generatePass with ENTITLEMENT_INSTANCE_ID_MISSING (F-06)",
    async (id) => {
      const facade = createFacade({
        google: createProvider("https://pay.google.com/gp/v/save/token"),
        apple: createProvider("https://wallet.apple.example/pass/token"),
      })

      await expect(facade.generatePass(id, "google", "pl-PL")).rejects.toMatchObject({
        name: "WalletPassGenerationError",
        audit_event: {
          event_type: "wallet.pass_failed",
          provider: "google",
          outcome: "failure",
          error_code: "ENTITLEMENT_INSTANCE_ID_MISSING",
        },
      })
    }
  )

  it("rejects empty entitlement_instance_id in invalidatePass with ENTITLEMENT_INSTANCE_ID_MISSING (F-06)", async () => {
    const facade = createFacade({
      google: createProvider("https://pay.google.com/gp/v/save/token"),
      apple: createProvider("https://wallet.apple.example/pass/token"),
    })

    await expect(facade.invalidatePass("", "google", "revoked")).rejects.toMatchObject({
      name: "WalletPassInvalidationError",
      audit_event: {
        event_type: "wallet.pass_invalidation_failed",
        provider: "google",
        reason: "revoked",
        error_code: "ENTITLEMENT_INSTANCE_ID_MISSING",
      },
    })
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
      // Note: no `satisfies` here — "samsung" is not WalletProviderKind but is
      // preserved verbatim at runtime by toAuditProviderSafe (M-1 + L-2 fix).
      audit_event: {
        event_type: "wallet.pass_failed",
        entitlement_instance_id: "ei_123",
        provider: "samsung",
        timestamp,
        outcome: "failure",
        error_code: "UNSUPPORTED_PROVIDER",
      },
    })
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
      // Note: no `satisfies` here — "samsung" is not WalletProviderKind but is
      // preserved verbatim at runtime by toAuditProviderSafe (M-1 + L-2 fix).
      audit_event: {
        event_type: "wallet.pass_invalidation_failed",
        entitlement_instance_id: "ei_123",
        provider: "samsung",
        timestamp,
        outcome: "failure",
        error_code: "UNSUPPORTED_PROVIDER",
      },
    })
  })

  // M-1 regression test: provider completely outside AuditProvider enum (e.g. "foobar")
  // must still produce UnsupportedWalletProviderError — not a secondary generic Error from
  // toAuditProvider throwing before the envelope is built.
  it("throws UnsupportedWalletProviderError with preserved provider value for provider completely outside AuditProvider enum (M-1)", async () => {
    const facade = createFacade({
      google: createProvider("https://pay.google.com/gp/v/save/token"),
      apple: createProvider("https://wallet.apple.example/pass/token"),
    })

    await expect(
      facade.generatePass("ei_123", "foobar" as never, "pl-PL")
    ).rejects.toMatchObject({
      name: "UnsupportedWalletProviderError",
      // Note: no `satisfies` here — "foobar" is not WalletProviderKind but must
      // be preserved verbatim by toAuditProviderSafe for telemetry diagnostics.
      audit_event: {
        event_type: "wallet.pass_failed",
        entitlement_instance_id: "ei_123",
        provider: "foobar",
        timestamp,
        outcome: "failure",
        error_code: "UNSUPPORTED_PROVIDER",
      },
    })
  })

  it("throws UnsupportedWalletProviderError for invalidatePass with provider completely outside enum (M-1)", async () => {
    const facade = createFacade({
      google: createProvider("https://pay.google.com/gp/v/save/token"),
      apple: createProvider("https://wallet.apple.example/pass/token"),
    })

    await expect(
      facade.invalidatePass("ei_123", "foobar" as never, "revoked")
    ).rejects.toMatchObject({
      name: "UnsupportedWalletProviderError",
      // Note: no `satisfies` here — "foobar" is not WalletProviderKind but must
      // be preserved verbatim by toAuditProviderSafe for telemetry diagnostics.
      audit_event: {
        event_type: "wallet.pass_invalidation_failed",
        entitlement_instance_id: "ei_123",
        provider: "foobar",
        timestamp,
        outcome: "failure",
        error_code: "UNSUPPORTED_PROVIDER",
      },
    })
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
