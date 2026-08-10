const updateRegionsRun = jest.fn().mockResolvedValue({})
jest.mock("@medusajs/core-flows", () => ({
  updateRegionsWorkflow: jest.fn(() => ({ run: updateRegionsRun })),
}))

import {
  parseArgs,
  resolvePaymentProviderId,
  selectRegionForMarket,
  syncRegionPaymentProviders,
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

  it("aliases pp_stripe to the canonical card provider (pp_stripe_stripe) on naming drift", () => {
    const result = resolvePaymentProviderId("pp_stripe", [
      "pp_stripe-blik_stripe",
      "pp_stripe-przelewy24_stripe",
      "pp_stripe_stripe",
      "pp_system_default",
    ])
    expect(result.providerId).toBe("pp_stripe_stripe")
    expect(result.fallbackApplied).toBe(true)
    expect(result.warning).toMatch(/aliased to 'pp_stripe_stripe'/)
  })

  it("aliases to the only pp_stripe* candidate when the canonical card id is absent", () => {
    const result = resolvePaymentProviderId("pp_stripe", ["pp_stripe-blik_stripe", "pp_system_default"])
    expect(result.providerId).toBe("pp_stripe-blik_stripe")
    expect(result.fallbackApplied).toBe(true)
  })

  it("throws when configured provider has no exact match and no pp_stripe* alias candidate", () => {
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

describe("gp-config-sync-payments.syncRegionPaymentProviders", () => {
  /**
   * Region `Poland` jest wspoldzielony przez piec rynkow, a orkiestrator uruchamia sync
   * per rynek. Do 2026-08-10 zapis szedl jako `payment_providers: [providerId]`, wiec
   * kolejny rynek KASOWAL wklad poprzedniego — zmierzone na gp-dev: bonbeauty dolozylo
   * Stripe o 10:16:03, bonevent skasowalo go o 10:16:09, a checkout zostal z samym
   * `pp_system_default`.
   */
  const makeDb = (existing: string[]) => {
    const chain = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      pluck: jest.fn().mockResolvedValue(existing),
    }
    const db = jest.fn(() => chain) as unknown as Parameters<
      typeof syncRegionPaymentProviders
    >[1]
    return { db, chain }
  }

  const container = {} as any

  beforeEach(() => {
    updateRegionsRun.mockClear()
  })

  it("dokłada providera rynku, nie kasując wkładu innego rynku dzielącego region", async () => {
    const { db } = makeDb(["pp_system_default"])
    const result = await syncRegionPaymentProviders(container, db, "reg_1", "pp_stripe_stripe")

    expect(result.added).toBe(true)
    expect(result.providers).toEqual(["pp_stripe_stripe", "pp_system_default"])
    // Kontrola dodatnia: `pp_system_default` MUSI przetrwac dopisanie Stripe'a.
    expect(updateRegionsRun.mock.calls[0][0].input.update.payment_providers).toEqual([
      "pp_stripe_stripe",
      "pp_system_default",
    ])
  })

  it("nie zapisuje niczego, gdy provider rynku jest już na regionie", async () => {
    const { db } = makeDb(["pp_stripe_stripe", "pp_system_default"])
    const result = await syncRegionPaymentProviders(container, db, "reg_1", "pp_system_default")

    expect(result.added).toBe(false)
    expect(updateRegionsRun).not.toHaveBeenCalled()
  })

  it("odtwarza zmierzoną sekwencję pięciu rynków — Stripe zostaje na końcu", async () => {
    let state: string[] = []
    for (const provider of [
      "pp_system_default", // mercur
      "pp_stripe_stripe", // bonbeauty
      "pp_system_default", // bonevent
      "pp_system_default", // bongarden
      "pp_system_default", // testmarketb
    ]) {
      const { db } = makeDb(state)
      state = (await syncRegionPaymentProviders(container, db, "reg_1", provider)).providers
    }

    // Przed naprawa konczylo sie na `["pp_system_default"]` i checkout nie mial Stripe'a.
    expect(state).toEqual(["pp_stripe_stripe", "pp_system_default"])
  })
})
