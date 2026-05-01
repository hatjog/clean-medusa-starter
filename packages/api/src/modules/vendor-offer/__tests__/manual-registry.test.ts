import { describe, expect, it } from "@jest/globals"

import {
  findCallsite,
  isCallsiteRegistered,
  loadRegistry,
  PRIMARY_VENDOR_CALLSITES_SETTINGS_KEY,
  RegistryLookupError,
  V150_DEFAULT_CALLSITES,
  type RegisteredCallsite,
  type SettingsTableReader,
} from "../manual-registry"

class StubSettingsReader implements SettingsTableReader {
  public lastKey: string | null = null
  constructor(private readonly value: unknown | null) {}
  async getJson(key: string): Promise<unknown | null> {
    this.lastKey = key
    return this.value
  }
}

describe("manual-registry — settings-table backed READ-only", () => {
  it("returns the v1.5.0 default callsites when settings key is unset", async () => {
    const reader = new StubSettingsReader(null)
    const rows = await loadRegistry(reader)
    expect(rows).toEqual(V150_DEFAULT_CALLSITES)
    expect(rows.length).toBe(4)
    expect(reader.lastKey).toBe(PRIMARY_VENDOR_CALLSITES_SETTINGS_KEY)
  })

  it("returns the persisted rows when the settings table has a JSON array", async () => {
    const persisted: RegisteredCallsite[] = [
      {
        callsite: "custom-callsite",
        file: "GP/storefront/src/components/sections/custom.tsx",
        function: "CustomSection",
        reads_via: "data/vendor-offer/primary-resolver",
        added_at: "2026-05-15",
        reviewer: "@team-vendors",
      },
    ]
    const reader = new StubSettingsReader(persisted)
    const rows = await loadRegistry(reader)
    expect(rows).toEqual(persisted)
  })

  it("throws REGISTRY_MALFORMED when the persisted JSON is not an array", async () => {
    const reader = new StubSettingsReader({ not: "an array" })
    await expect(loadRegistry(reader)).rejects.toBeInstanceOf(RegistryLookupError)
    try {
      await loadRegistry(reader)
    } catch (e) {
      expect((e as RegistryLookupError).code).toBe("REGISTRY_MALFORMED")
    }
  })

  it("throws REGISTRY_MALFORMED when a row has the wrong shape", async () => {
    const reader = new StubSettingsReader([
      { callsite: "ok-shape", file: "f", function: "fn", reads_via: "data/vendor-offer/primary-resolver", added_at: "2026-04-30", reviewer: "@x" },
      { callsite: "broken", file: 42 /* wrong type */ },
    ])
    await expect(loadRegistry(reader)).rejects.toBeInstanceOf(RegistryLookupError)
    try {
      await loadRegistry(reader)
    } catch (e) {
      expect((e as RegistryLookupError).code).toBe("REGISTRY_MALFORMED")
    }
  })

  it("throws DUPLICATE_CALLSITE when the same callsite key repeats", async () => {
    const reader = new StubSettingsReader([
      {
        callsite: "dup",
        file: "f1",
        function: "Fn1",
        reads_via: "data/vendor-offer/primary-resolver",
        added_at: "2026-04-30",
        reviewer: "@x",
      },
      {
        callsite: "dup",
        file: "f2",
        function: "Fn2",
        reads_via: "data/vendor-offer/primary-resolver",
        added_at: "2026-04-30",
        reviewer: "@y",
      },
    ])
    await expect(loadRegistry(reader)).rejects.toBeInstanceOf(RegistryLookupError)
    try {
      await loadRegistry(reader)
    } catch (e) {
      expect((e as RegistryLookupError).code).toBe("DUPLICATE_CALLSITE")
    }
  })

  it("findCallsite returns the row by key or null", async () => {
    const reader = new StubSettingsReader(null)
    const hit = await findCallsite(reader, "pdp-product-page")
    expect(hit).not.toBeNull()
    expect(hit?.file).toBe(
      "GP/storefront/src/app/[locale]/(main)/products/[handle]/page.tsx"
    )
    const miss = await findCallsite(reader, "nonexistent-callsite-key")
    expect(miss).toBeNull()
  })

  it("isCallsiteRegistered is a convenience predicate", async () => {
    const reader = new StubSettingsReader(null)
    expect(await isCallsiteRegistered(reader, "cart-line-item")).toBe(true)
    expect(await isCallsiteRegistered(reader, "definitely-not-real")).toBe(false)
  })

  it("v1.5.0 default set covers the 4 AC-PVR-4.2-04 callsites", () => {
    const keys = new Set(V150_DEFAULT_CALLSITES.map((r) => r.callsite))
    expect(keys.has("pdp-product-page")).toBe(true)
    expect(keys.has("cart-line-item")).toBe(true)
    expect(keys.has("listing-card")).toBe(true)
    expect(keys.has("order-detail")).toBe(true)
  })
})
