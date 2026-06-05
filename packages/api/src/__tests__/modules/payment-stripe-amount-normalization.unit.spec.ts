/**
 * Path B fix for the minor-vs-major ×100 payment defect.
 *
 * GP stores amounts in MINOR units (grosze); the upstream @medusajs/payment-
 * stripe provider assumes MAJOR units and re-scales by the currency exponent.
 * Unbridged, a 26000-grosze (260 PLN) charge became 2 600 000 grosze. These
 * tests lock the boundary translation:
 *   1. the pure helpers round-trip exactly + honour currency decimals + guards
 *   2. the withResolverGate mixin applies them on the right in/out methods and
 *      leaves pass-through methods untouched.
 */
import { jest } from "@jest/globals"

import {
  gpMinorToProviderMajor,
  providerMajorToGpMinor,
} from "../../modules/payment-stripe-multi-market/amount-normalization"
import { withResolverGate } from "../../modules/payment-stripe-multi-market/service"

describe("amount-normalization helpers — minor↔major boundary", () => {
  it("converts grosze→major for a 2-decimal currency (PLN)", () => {
    expect(gpMinorToProviderMajor(26000, "pln")).toBe(260)
    expect(providerMajorToGpMinor(260, "pln")).toBe(26000)
  })

  it("round-trips exactly for integer minor amounts", () => {
    for (const grosze of [1, 99, 26000, 12345, 100000000]) {
      expect(providerMajorToGpMinor(gpMinorToProviderMajor(grosze, "pln"), "pln")).toBe(grosze)
    }
  })

  it("is a no-op for a 0-decimal currency (JPY has no minor unit)", () => {
    expect(gpMinorToProviderMajor(26000, "jpy")).toBe(26000)
    expect(providerMajorToGpMinor(26000, "jpy")).toBe(26000)
  })

  it("round-trips for a 3-decimal currency (KWD)", () => {
    // KWD multiplier is 1000; round-trip must preserve a clean minor value.
    expect(providerMajorToGpMinor(gpMinorToProviderMajor(260000, "kwd"), "kwd")).toBe(260000)
  })

  it("passes null/undefined through untouched (e.g. updatePayment without amount)", () => {
    expect(gpMinorToProviderMajor(null, "pln")).toBeNull()
    expect(gpMinorToProviderMajor(undefined, "pln")).toBeUndefined()
    expect(providerMajorToGpMinor(null, "pln")).toBeNull()
  })

  it("passes the amount through untouched when currency is missing", () => {
    expect(gpMinorToProviderMajor(26000, undefined)).toBe(26000)
    expect(providerMajorToGpMinor(26000, "")).toBe(26000)
  })
})

/**
 * Minimal fake of the upstream StripeBase so the mixin can be exercised
 * without a real Stripe SDK. Methods MUST live on the prototype (regular
 * class methods) so `super.<method>` inside the mixin resolves to them.
 */
class FakeStripeBase {
  options_: Record<string, unknown> = {}
  stripe_: unknown = {}
  received: Record<string, unknown[]> = {}
  retrieveReturn: unknown
  webhookReturn: unknown
  webhookEvent: unknown

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_cradle: unknown, _opts: unknown) {}

  private record(name: string, input: unknown) {
    ;(this.received[name] ??= []).push(input)
  }

  async initiatePayment(input: any) {
    this.record("initiatePayment", input)
    return { id: "pi_test", status: "pending" }
  }
  async refundPayment(input: any) {
    this.record("refundPayment", input)
    return { data: input.data }
  }
  async updatePayment(input: any) {
    this.record("updatePayment", input)
    return { status: "pending" }
  }
  async capturePayment(input: any) {
    this.record("capturePayment", input)
    // Upstream capture returns the RAW Stripe intent (already smallest-unit).
    return { data: { amount: 26000, currency: "pln" } }
  }
  async retrievePayment(input: any) {
    this.record("retrievePayment", input)
    return this.retrieveReturn
  }
  async getWebhookActionAndData(input: any) {
    this.record("getWebhookActionAndData", input)
    return this.webhookReturn
  }
  constructWebhookEvent(_raw: unknown) {
    return this.webhookEvent
  }
}

const LEGACY_OPTS = {
  __allowLegacyExplicitKeys: true,
  apiKey: "sk_test_fixture",
  webhookSecret: "whsec_test_fixture",
}

function makeService(): any {
  // withResolverGate returns an abstract class (compile-time only); at runtime
  // it is a normal constructor. Legacy-key opts make ensureResolved short-
  // circuit so no SecretsAdapter / Stripe SDK is touched.
  const Mixed: any = withResolverGate(FakeStripeBase as any, "bonbeauty")
  return new Mixed({}, LEGACY_OPTS)
}

describe("withResolverGate — amount boundary wiring", () => {
  it("initiatePayment converts the grosze amount to major before delegating", async () => {
    const svc = makeService()
    await svc.initiatePayment({ amount: 26000, currency_code: "pln", data: {} })
    expect(svc.received.initiatePayment[0].amount).toBe(260)
  })

  it("initiatePayment without an amount delegates unchanged (no crash)", async () => {
    const svc = makeService()
    await svc.initiatePayment({ currency_code: "pln", data: {} })
    expect(svc.received.initiatePayment[0].amount).toBeUndefined()
  })

  it("refundPayment converts using data.currency", async () => {
    const svc = makeService()
    await svc.refundPayment({ amount: 9900, data: { id: "pi", currency: "pln" } })
    expect(svc.received.refundPayment[0].amount).toBe(99)
  })

  it("updatePayment converts the grosze amount to major", async () => {
    const svc = makeService()
    await svc.updatePayment({ amount: 26000, currency_code: "pln", data: { id: "pi" } })
    expect(svc.received.updatePayment[0].amount).toBe(260)
  })

  it("retrievePayment converts the returned major amount back to grosze", async () => {
    const svc = makeService()
    svc.retrieveReturn = { data: { id: "pi", amount: 260, currency: "pln" } }
    const res = await svc.retrievePayment({ data: { id: "pi" } })
    expect(res.data.amount).toBe(26000)
  })

  it("getWebhookActionAndData converts the returned major amount back to grosze", async () => {
    const svc = makeService()
    svc.webhookReturn = { action: "captured", data: { session_id: "ps", amount: 260 } }
    svc.webhookEvent = { data: { object: { currency: "pln" } } }
    const res = await svc.getWebhookActionAndData({ rawBody: "x" })
    expect(res.data.amount).toBe(26000)
  })

  it("getWebhookActionAndData leaves the amount untouched when the event cannot be parsed", async () => {
    const svc = makeService()
    svc.webhookReturn = { action: "captured", data: { session_id: "ps", amount: 260 } }
    jest.spyOn(FakeStripeBase.prototype, "constructWebhookEvent").mockImplementationOnce(() => {
      throw new Error("bad signature")
    })
    const res = await svc.getWebhookActionAndData({ rawBody: "x" })
    expect(res.data.amount).toBe(260)
  })

  it("capturePayment is a pass-through — the raw smallest-unit amount is NOT re-scaled", async () => {
    const svc = makeService()
    const res = await svc.capturePayment({ data: { id: "pi" } })
    expect(res.data.amount).toBe(26000)
  })
})
