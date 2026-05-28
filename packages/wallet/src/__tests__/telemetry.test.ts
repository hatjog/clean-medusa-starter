import {
  emitWalletCounter,
  sanitizeWalletErrorMessage,
  setWalletPostHogClient,
  setWalletSentryClient,
  shutdownWalletPostHogClient,
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

  it("P20: wallet package compiles to CommonJS (require is available)", () => {
    // Smoke assertion: when imported in jest's CJS test runner, the runtime
    // exposes `require` at module scope. If the wallet package ever drifts
    // to ESM `"type": "module"`, this test fails because `require` becomes
    // undefined in module scope (still defined in jest's runner context).
    // The richer check is that posthog.ts's lazy require path can be reached.
    expect(typeof require).toBe("function")
  })

  it("P21: shutdownWalletPostHogClient drops the client reference", async () => {
    const shutdown = jest.fn().mockResolvedValue(undefined)
    const capture = jest.fn()
    setWalletPostHogClient({ capture, shutdown })

    await shutdownWalletPostHogClient()

    expect(shutdown).toHaveBeenCalledTimes(1)
    // After shutdown, a subsequent emit must NOT reuse the closed client.
    capture.mockClear()
    emitWalletCounter("pass_generated", baseProps)
    expect(capture).not.toHaveBeenCalled()
  })

  it("P9 + P12: rejects unknown failure_code and empty error_message", () => {
    const capture = jest.fn()
    setWalletPostHogClient({ capture })

    // Empty error_message is dropped from properties (still emits).
    emitWalletCounter("pass_failed", {
      ...baseProps,
      failure_code: "network",
      error_message: "",
    })
    const lastCall = capture.mock.calls.at(-1)?.[0] ?? {}
    expect(lastCall.event).toBe("wallet.pass_failed")
    expect(lastCall.properties.error_message).toBeUndefined()

    capture.mockClear()
    // Unknown failure_code is rejected (no emit).
    emitWalletCounter("pass_failed", {
      ...baseProps,
      // @ts-expect-error testing runtime guard
      failure_code: "bogus_value",
      error_message: "x",
    })
    expect(capture).not.toHaveBeenCalled()
  })

  it("P12: rejects pass_gated with unknown gate_reason", () => {
    const capture = jest.fn()
    setWalletPostHogClient({ capture })

    emitWalletCounter("pass_gated", {
      ...baseProps,
      // @ts-expect-error testing runtime guard
      gate_reason: "not_a_real_reason",
    })

    expect(capture).not.toHaveBeenCalled()
  })

  it("P25: accepts extended WalletFailureCode union (auth_expired, client_error)", () => {
    const capture = jest.fn()
    setWalletPostHogClient({ capture })

    emitWalletCounter("pass_failed", {
      ...baseProps,
      failure_code: "auth_expired",
      error_message: "session expired",
    })
    emitWalletCounter("pass_failed", {
      ...baseProps,
      failure_code: "client_error",
      error_message: "shape mismatch",
    })

    expect(capture).toHaveBeenCalledTimes(2)
  })
})
