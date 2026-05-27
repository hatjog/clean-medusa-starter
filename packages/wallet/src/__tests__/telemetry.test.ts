import {
  emitWalletCounter,
  sanitizeWalletErrorMessage,
  setWalletPostHogClient,
  setWalletSentryClient,
} from "../telemetry"

const baseProps = {
  provider: "google" as const,
  market: "bonbeauty",
  locale: "pl-PL" as const,
  actor: "P4" as const,
  entitlement_type: "voucher",
  entitlement_instance_id: "ei_123",
}

describe("wallet telemetry", () => {
  afterEach(() => {
    setWalletPostHogClient(null)
    setWalletSentryClient(null)
  })

  it("emits wallet counter with deterministic non-PII distinct_id", () => {
    const capture = jest.fn()
    setWalletPostHogClient({ capture })

    emitWalletCounter("pass_generated", baseProps)

    expect(capture).toHaveBeenCalledWith({
      distinctId: "actor:P4:ei_123",
      event: "wallet.pass_generated",
      properties: expect.objectContaining(baseProps),
    })
  })

  it("does not throw when PostHog capture fails and mirrors to Sentry", () => {
    const captureMessage = jest.fn()
    setWalletPostHogClient({
      capture: jest.fn(() => {
        throw new Error("posthog down")
      }),
    })
    setWalletSentryClient({ captureMessage })

    expect(() => emitWalletCounter("pass_generated", baseProps)).not.toThrow()
    expect(captureMessage).toHaveBeenCalledWith(
      "posthog_emit_failed",
      expect.objectContaining({
        extra: expect.objectContaining({ counter: "pass_generated" }),
      })
    )
  })

  it("sanitizes PII and truncates wallet failure messages", () => {
    const sanitized = sanitizeWalletErrorMessage(
      "GoogleWallet john@example.com +48 501 222 333 123e4567-e89b-12d3-a456-426614174000 ".repeat(
        3
      )
    )

    expect(sanitized).not.toContain("john@example.com")
    expect(sanitized).not.toContain("+48 501")
    expect(sanitized).not.toContain("123e4567")
    expect(sanitized.length).toBeLessThanOrEqual(120)
  })

  it("keeps pass_gated separate from pass_failed for policy denies", () => {
    const capture = jest.fn()
    setWalletPostHogClient({ capture })

    emitWalletCounter("pass_gated", {
      ...baseProps,
      gate_reason: "market_not_pilot",
    })

    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: "wallet.pass_gated" })
    )
    expect(capture).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "wallet.pass_failed" })
    )
  })
})
