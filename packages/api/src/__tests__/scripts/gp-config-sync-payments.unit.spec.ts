import {
  parseArgs,
  resolvePaymentProviderId,
  selectRegionForMarket,
} from "../../scripts/gp-config-sync-payments"

describe("gp-config-sync-payments.parseArgs", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.GP_INSTANCE_ID
    delete process.env.GP_MARKET_ID
    delete process.env.GP_CONFIG_ROOT
    delete process.env.GP_DRY_RUN
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it("parses args array and dry-run flag", () => {
    const result = parseArgs(["gp-dev", "bonbeauty", "--dry-run"])

    expect(result).toEqual({
      instanceId: "gp-dev",
      marketId: "bonbeauty",
      configRoot: expect.any(String),
      dryRun: true,
    })
  })

  it("falls back to env vars", () => {
    process.env.GP_INSTANCE_ID = "gp-stage"
    process.env.GP_MARKET_ID = "bonevent"
    process.env.GP_CONFIG_ROOT = "/tmp/gp-config"

    const result = parseArgs(undefined)

    expect(result).toEqual({
      instanceId: "gp-stage",
      marketId: "bonevent",
      configRoot: "/tmp/gp-config",
      dryRun: false,
    })
  })
})

describe("gp-config-sync-payments.selectRegionForMarket", () => {
  const regions = [
    {
      id: "reg-pl",
      name: "Poland",
      currency_code: "pln",
      country_codes: ["pl"],
    },
    {
      id: "reg-eu",
      name: "Europe",
      currency_code: "eur",
      country_codes: ["de", "fr", "it"],
    },
  ]

  it("selects an exact currency and country match", () => {
    const region = selectRegionForMarket(regions, "PLN", ["PL"])
    expect(region.id).toBe("reg-pl")
  })

  it("falls back to the unique currency match when countries are not provided", () => {
    const region = selectRegionForMarket(regions, "EUR", [])
    expect(region.id).toBe("reg-eu")
  })

  it("throws when region cannot be resolved uniquely", () => {
    expect(() =>
      selectRegionForMarket(
        [
          ...regions,
          {
            id: "reg-eu-2",
            name: "Europe Backup",
            currency_code: "eur",
            country_codes: ["es"],
          },
        ],
        "EUR",
        []
      )
    ).toThrow(/Multiple regions found for currency 'EUR'/)
  })
})

describe("gp-config-sync-payments.resolvePaymentProviderId", () => {
  it("keeps the configured provider when it is available", () => {
    expect(resolvePaymentProviderId("pp_stripe", ["pp_stripe", "pp_system_default"])).toEqual({
      providerId: "pp_stripe",
      fallbackApplied: false,
    })
  })

  it("throws when configured provider is not in available list", () => {
    expect(() =>
      resolvePaymentProviderId("pp_stripe", ["pp_system_default"])
    ).toThrow(/Configured payment provider 'pp_stripe' is not enabled in runtime/)
  })

  it("throws with none when available list is empty", () => {
    expect(() =>
      resolvePaymentProviderId("pp_stripe", [])
    ).toThrow(/Available providers: none/)
  })
})
