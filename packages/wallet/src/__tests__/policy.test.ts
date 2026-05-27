import {
  DefaultWalletFeaturePolicy,
  EnvWalletProviderReadiness,
  type ReleasePromotabilityProbe,
  type WalletFeaturePolicyInput,
  type WalletMarketRegistry,
  type WalletProviderReadiness,
} from ".."

const timestamp = "2026-05-27T08:00:00.000Z"

const allowMarket: WalletMarketRegistry = {
  isWalletRatified: jest.fn(async () => true),
}

const allowRelease: ReleasePromotabilityProbe = {
  isPromotable: jest.fn(async () => true),
}

const allowProvider: WalletProviderReadiness = {
  isEnabled: jest.fn(async () => true),
}

const baseInput: WalletFeaturePolicyInput = {
  entitlement_instance_id: "ei_123",
  market: "bonbeauty",
  release: "v1.10.0",
  actor: {
    actor_id: "cus_123",
    persona: "P4_recipient",
  },
  lifecycle: "ACTIVE",
  provider: "google",
}

function createPolicy(overrides: {
  marketRegistry?: WalletMarketRegistry
  releasePromotability?: ReleasePromotabilityProbe
  providerReadiness?: WalletProviderReadiness
} = {}): DefaultWalletFeaturePolicy {
  return new DefaultWalletFeaturePolicy({
    marketRegistry: overrides.marketRegistry ?? allowMarket,
    releasePromotability: overrides.releasePromotability ?? allowRelease,
    providerReadiness: overrides.providerReadiness ?? allowProvider,
    clock: () => new Date(timestamp),
  })
}

describe("DefaultWalletFeaturePolicy", () => {
  it("pozwala wygenerować pass, gdy wszystkie bramki przechodzą", async () => {
    const result = await createPolicy().check(baseInput)

    expect(result).toEqual({ allowed: true })
    expect("audit_event" in result).toBe(false)
  })

  it("odrzuca market_not_ratified przed kolejnymi sprawdzeniami", async () => {
    const marketRegistry: WalletMarketRegistry = {
      isWalletRatified: jest.fn(async () => false),
    }

    const result = await createPolicy({ marketRegistry }).check(baseInput)

    expect(result).toMatchObject({
      allowed: false,
      reason: "market_not_ratified",
      audit_event: {
        outcome: "rejected_market_not_ratified",
        gate_reason: "market_not_ratified",
      },
    })
  })

  it("odrzuca release_not_promotable po pozytywnym sprawdzeniu marketu", async () => {
    const releasePromotability: ReleasePromotabilityProbe = {
      isPromotable: jest.fn(async () => false),
    }

    const result = await createPolicy({ releasePromotability }).check(baseInput)

    expect(result).toMatchObject({
      allowed: false,
      reason: "release_not_promotable",
      audit_event: {
        outcome: "rejected_release_not_promotable",
        gate_reason: "release_not_promotable",
      },
    })
  })

  it("odrzuca actor_not_p4_recipient, gdy persona aktora nie jest P4", async () => {
    const result = await createPolicy().check({
      ...baseInput,
      actor: { actor_id: "cus_456", persona: "P3_buyer" },
    })

    expect(result).toMatchObject({
      allowed: false,
      reason: "actor_not_p4_recipient",
      audit_event: {
        outcome: "rejected_actor_not_p4_recipient",
        gate_reason: "actor_not_p4_recipient",
        actor_id: "cus_456",
      },
    })
  })

  it.each(["EXPIRED", "REVOKED", "VOIDED"] as const)(
    "odrzuca lifecycle_not_active dla statusu %s",
    async (lifecycle) => {
      const result = await createPolicy().check({ ...baseInput, lifecycle })

      expect(result).toMatchObject({
        allowed: false,
        reason: "lifecycle_not_active",
        audit_event: {
          outcome: "rejected_lifecycle_not_active",
          gate_reason: "lifecycle_not_active",
          lifecycle,
        },
      })
    }
  )

  it("odrzuca PARTIALLY_REDEEMED jako lifecycle_not_active zgodnie z regułą lifecycle != ACTIVE", async () => {
    const result = await createPolicy().check({
      ...baseInput,
      lifecycle: "PARTIALLY_REDEEMED",
    })

    expect(result).toMatchObject({
      allowed: false,
      reason: "lifecycle_not_active",
      audit_event: {
        outcome: "rejected_lifecycle_not_active",
        lifecycle: "PARTIALLY_REDEEMED",
      },
    })
  })

  it("odrzuca provider_disabled po pozytywnym przejściu wcześniejszych bramek", async () => {
    const providerReadiness: WalletProviderReadiness = {
      isEnabled: jest.fn(async (provider) => provider !== "apple"),
    }

    const result = await createPolicy({ providerReadiness }).check({
      ...baseInput,
      provider: "apple",
    })

    expect(result).toMatchObject({
      allowed: false,
      reason: "provider_disabled",
      audit_event: {
        outcome: "rejected_provider_disabled",
        gate_reason: "provider_disabled",
        provider: "apple",
      },
    })
  })

  it("używa domyślnych flag provider readiness dla v1.10.0", async () => {
    const readiness = new EnvWalletProviderReadiness({})

    await expect(readiness.isEnabled("google")).resolves.toBe(true)
    await expect(readiness.isEnabled("apple")).resolves.toBe(false)
  })

  it("zwraca pierwszy deny reason według deterministycznej precedencji", async () => {
    const result = await createPolicy({
      marketRegistry: { isWalletRatified: jest.fn(async () => false) },
      releasePromotability: { isPromotable: jest.fn(async () => false) },
      providerReadiness: { isEnabled: jest.fn(async () => false) },
    }).check({
      ...baseInput,
      actor: { actor_id: "cus_456", persona: "P3_buyer" },
      lifecycle: "EXPIRED",
      provider: "apple",
    })

    expect(result).toMatchObject({
      allowed: false,
      reason: "market_not_ratified",
      audit_event: {
        outcome: "rejected_market_not_ratified",
      },
    })
  })

  it("tworzy forensic audit envelope dla każdego odrzucenia", async () => {
    const result = await createPolicy({
      marketRegistry: { isWalletRatified: jest.fn(async () => false) },
    }).check(baseInput)

    expect(result).toEqual({
      allowed: false,
      reason: "market_not_ratified",
      audit_event: {
        event_type: "wallet.pass_gated",
        outcome: "rejected_market_not_ratified",
        gate_reason: "market_not_ratified",
        entitlement_instance_id: "ei_123",
        provider: "google",
        market: "bonbeauty",
        release: "v1.10.0",
        actor_id: "cus_123",
        lifecycle: "ACTIVE",
        timestamp,
      },
    })
  })
})
