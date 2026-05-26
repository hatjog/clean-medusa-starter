import {
  DefaultWalletPayloadBuilder,
  WalletPayloadError,
  type EntitlementInstance,
  type EntitlementInstanceReadModel,
} from ".."

const fullEntitlement: EntitlementInstance = {
  id: "ei_123",
  code: "BB-2026-0001",
  title: {
    "pl-PL": "Voucher spa",
    "en-US": "Spa voucher",
    "uk-UA": "Спа ваучер",
    "de-DE": "Spa Gutschein",
  },
  status: "ACTIVE",
  expires_at: new Date("2026-12-31T23:59:59.000Z"),
  deep_link: "https://bonbeauty.example/pl/vouchers/BB-2026-0001",
  barcode_spec: { format: "PDF417", value: "PDF417-BB-2026-0001" },
  branding: {
    logo_url: "https://assets.example/logo.svg",
    primary_color: "#111111",
    accent_color: "#22C55E",
  },
}

describe("DefaultWalletPayloadBuilder", () => {
  it("builds wallet payload from a hydrated Layer 4 entitlement instance", () => {
    const builder = new DefaultWalletPayloadBuilder()

    const payload = builder.build(fullEntitlement, "pl-PL")

    expect(payload).toEqual({
      entitlement_instance_id: "ei_123",
      code: "BB-2026-0001",
      title: "Voucher spa",
      status: "ACTIVE",
      expires_at: "2026-12-31T23:59:59.000Z",
      deep_link: "https://bonbeauty.example/pl/vouchers/BB-2026-0001",
      barcode_spec: { format: "PDF417", value: "PDF417-BB-2026-0001" },
      qr_code: "PDF417-BB-2026-0001",
      barcode: { format: "PDF417", value: "PDF417-BB-2026-0001" },
      branding: {
        logo_url: "https://assets.example/logo.svg",
        primary_color: "#111111",
        accent_color: "#22C55E",
      },
      locale: "pl-PL",
    })
  })

  it.each([
    ["pl-PL", "Voucher spa"],
    ["en-US", "Spa voucher"],
    ["uk-UA", "Спа ваучер"],
    ["de-DE", "Spa Gutschein"],
  ])("uses localized title for %s", (locale, expectedTitle) => {
    const builder = new DefaultWalletPayloadBuilder()

    expect(builder.build(fullEntitlement, locale).title).toBe(expectedTitle)
  })

  it("falls back to canonical locale and default branding when optional projection is absent", () => {
    const builder = new DefaultWalletPayloadBuilder()
    const entitlement: EntitlementInstance = {
      id: "ei_124",
      code: "BB-2026-0002",
      title: { "pl-PL": "Bon podarunkowy" },
      status: "ACTIVE",
      expires_at: "2026-12-01",
      deep_link: "https://bonbeauty.example/pl/vouchers/BB-2026-0002",
    }

    const payload = builder.build(entitlement, "fr-FR")

    expect(payload.locale).toBe("pl-PL")
    expect(payload.title).toBe("Bon podarunkowy")
    expect(payload.barcode_spec).toEqual({ format: "QR", value: "BB-2026-0002" })
    expect(payload.barcode).toBeUndefined()
    expect(payload.branding).toMatchObject({
      logo_url: expect.stringContaining("bonbeauty"),
      primary_color: "#111827",
      accent_color: "#16A34A",
    })
  })

  it.each([
    ["ACTIVE" as const],
    ["EXPIRED" as const],
    ["REVOKED" as const],
    ["REFUNDED" as const],
  ])("preserves normalized wallet status %s", (status) => {
    const builder = new DefaultWalletPayloadBuilder()

    expect(builder.build({ ...fullEntitlement, status }, "pl-PL").status).toBe(status)
  })

  it.each([
    ["ISSUED", "ACTIVE"],
    ["VOIDED", "REVOKED"],
    ["EXPIRED", "EXPIRED"],
    ["REFUNDED", "REFUNDED"],
  ])("maps entitlement_instance state %s to wallet status %s", (state, expected) => {
    const builder = new DefaultWalletPayloadBuilder()
    const entitlement: EntitlementInstance = {
      ...fullEntitlement,
      status: undefined,
      state,
    }

    expect(builder.build(entitlement, "pl-PL").status).toBe(expected)
  })

  it("uses wallet metadata projection before generic entitlement fields", () => {
    const builder = new DefaultWalletPayloadBuilder()
    const entitlement: EntitlementInstance = {
      ...fullEntitlement,
      metadata: {
        wallet: {
          code: "META-CODE",
          title: { "en-US": "Metadata title", "pl-PL": "Tytuł metadata" },
          deep_link: "https://bonbeauty.example/en/vouchers/META-CODE",
          barcode_spec: { format: "QR", value: "META-CODE" },
          branding: { accent_color: "#0000FF" },
        },
      },
    }

    const payload = builder.build(entitlement, "en-US")

    expect(payload).toMatchObject({
      code: "META-CODE",
      title: "Metadata title",
      deep_link: "https://bonbeauty.example/en/vouchers/META-CODE",
      barcode_spec: { format: "QR", value: "META-CODE" },
      branding: { accent_color: "#0000FF" },
    })
  })

  it("reads only the Layer 4 read model in buildFromEntitlement", async () => {
    const getById = jest.fn(async () => fullEntitlement)
    const layer3Repository = { getById: jest.fn() }
    const readModel: EntitlementInstanceReadModel = { getById }
    const builder = new DefaultWalletPayloadBuilder(readModel)

    const payload = await builder.buildFromEntitlement("ei_123", "pl-PL")

    expect(payload.code).toBe("BB-2026-0001")
    expect(getById).toHaveBeenCalledWith("ei_123")
    expect(layer3Repository.getById).not.toHaveBeenCalled()
  })

  it("throws typed error when entitlement instance is missing", async () => {
    const builder = new DefaultWalletPayloadBuilder({
      getById: jest.fn(async () => null),
    })

    await expect(builder.buildFromEntitlement("missing", "pl-PL")).rejects.toMatchObject({
      name: "WalletPayloadError",
      code: "ENTITLEMENT_INSTANCE_NOT_FOUND",
    } satisfies Partial<WalletPayloadError>)
  })

  it.each([
    [{ code: "" }, "CODE_MISSING"],
    [{ title: {} }, "TITLE_MISSING"],
    [{ status: undefined, state: "DISPUTED" }, "STATUS_UNSUPPORTED"],
    [{ expires_at: "not-a-date" }, "EXPIRES_AT_INVALID"],
    [{ deep_link: "" }, "DEEP_LINK_MISSING"],
    [{ barcode_spec: { format: "AZTEC", value: "x" } }, "BARCODE_FORMAT_UNSUPPORTED"],
  ])("throws %s for invalid projection", (patch, expectedCode) => {
    const builder = new DefaultWalletPayloadBuilder()
    const entitlement = { ...fullEntitlement, ...patch } as EntitlementInstance

    expect(() => builder.build(entitlement, "pl-PL")).toThrow(
      expect.objectContaining({
        name: "WalletPayloadError",
        code: expectedCode,
      })
    )
  })
})
