import {
  DefaultWalletFeaturePolicy,
  EnvWalletProviderReadiness,
  mapWalletInvalidationReasonToLifecycle,
  parseWalletFlag,
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

  // F-03/F-06: `EntitlementLifecycleStatus` D-110 zawiera tylko ACTIVE / PARTIALLY_REDEEMED
  // / EXPIRED / VOIDED. `WalletInvalidationReason` (REVOKED/REFUNDED) jest mapowany
  // na lifecycle VOIDED przez `mapWalletInvalidationReasonToLifecycle` PRZED wywołaniem
  // `check()` — dlatego w `it.each` nie ma już "REVOKED"/"REFUNDED".
  it.each(["EXPIRED", "VOIDED"] as const)(
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

  // F-06: REVOKED i REFUNDED to `WalletInvalidationReason` (Story 3.6 subscriber);
  // mapowane na VOIDED przez helper przed wejściem do gate'a. Test fixuje mapowanie
  // i dowodzi że obie ścieżki kończą się tym samym `lifecycle_not_active` denial.
  it("mapuje invalidation reason 'expired' na lifecycle EXPIRED", () => {
    expect(mapWalletInvalidationReasonToLifecycle("expired")).toBe("EXPIRED")
  })

  it.each(["revoked", "refunded"] as const)(
    "mapuje invalidation reason %s na VOIDED i odrzuca lifecycle_not_active",
    async (reason) => {
      const lifecycle = mapWalletInvalidationReasonToLifecycle(reason)
      expect(lifecycle).toBe("VOIDED")

      const result = await createPolicy().check({ ...baseInput, lifecycle })

      expect(result).toMatchObject({
        allowed: false,
        reason: "lifecycle_not_active",
        audit_event: {
          outcome: "rejected_lifecycle_not_active",
          lifecycle: "VOIDED",
        },
      })
    }
  )

  // F-07: domyślny `clock` (gdy caller nie wstrzyknie własnego) musi produkować
  // poprawny ISO 8601 timestamp w envelope; pokrywa default branch arrow function.
  it("używa domyślnego zegara gdy nie wstrzyknięto override", async () => {
    const policy = new DefaultWalletFeaturePolicy({
      marketRegistry: { isWalletRatified: jest.fn(async () => false) },
      releasePromotability: allowRelease,
      providerReadiness: allowProvider,
    })

    const before = Date.now()
    const result = await policy.check(baseInput)
    const after = Date.now()

    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(typeof result.audit_event.timestamp).toBe("string")
      const parsed = Date.parse(result.audit_event.timestamp)
      expect(Number.isNaN(parsed)).toBe(false)
      expect(parsed).toBeGreaterThanOrEqual(before)
      expect(parsed).toBeLessThanOrEqual(after)
    }
  })

  // F-08: błąd portu propaguje się do callera — gate nie połyka wyjątku, caller
  // jest odpowiedzialny za fail-closed obsługę (HTTP 5xx + envelope `outcome: failure`).
  it("propaguje błąd portu zamiast cicho odrzucać (fail-closed po stronie callera)", async () => {
    const boom = new Error("gp-config IO failure")
    const policy = createPolicy({
      marketRegistry: {
        isWalletRatified: jest.fn(async () => {
          throw boom
        }),
      },
    })

    await expect(policy.check(baseInput)).rejects.toBe(boom)
  })

  describe("parseWalletFlag (F-05)", () => {
    it("zwraca defaultValue dla pustego stringa zamiast cichego false", () => {
      expect(parseWalletFlag("", true)).toBe(true)
      expect(parseWalletFlag("   ", true)).toBe(true)
      expect(parseWalletFlag("", false)).toBe(false)
    })

    it.each(["0", "false", "no", "off", "FALSE", " no "])(
      "interpretuje %s jako jawną wartość false",
      (raw) => {
        expect(parseWalletFlag(raw, true)).toBe(false)
      }
    )

    it.each(["1", "true", "yes", "on", "TRUE"])(
      "interpretuje %s jako jawną wartość true",
      (raw) => {
        expect(parseWalletFlag(raw, false)).toBe(true)
      }
    )

    it("dla nieznanej wartości emituje ostrzeżenie i zwraca defaultValue", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})

      try {
        expect(parseWalletFlag("maybe", true)).toBe(true)
        expect(parseWalletFlag("maybe", false)).toBe(false)
        expect(warn).toHaveBeenCalledTimes(2)
        expect(warn).toHaveBeenLastCalledWith(
          expect.stringContaining("Nieznana wartość flagi providera")
        )
      } finally {
        warn.mockRestore()
      }
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
