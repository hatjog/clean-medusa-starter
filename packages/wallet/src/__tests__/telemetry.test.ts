import {
  emitWalletCounter,
  resetWalletPostHogEnvInit,
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
  // R-M10 (phase-4): reset env-init guard between every test so jest worker
  // pollution from earlier suites does not leak `envInitAttempted=true` into
  // tests that need the env-driven init path.
  beforeEach(() => {
    resetWalletPostHogEnvInit()
  })

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

  it("R-L1 (phase-4): wallet package.json does not declare ESM (no drift)", () => {
    // R-L1 (phase-4): the previous P20 assertion `typeof require === 'function'`
    // passed trivially in jest's CJS runner and could not detect a drift to
    // `"type": "module"` in the package's own package.json. Read the manifest
    // and assert directly.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../../package.json") as { type?: string }
    expect(pkg.type).not.toBe("module")
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

  it("R-H5 (phase-4): validator rejection mirrors to Sentry", () => {
    const capture = jest.fn()
    const captureMessage = jest.fn()
    setWalletPostHogClient({ capture })
    setWalletSentryClient({ captureMessage })

    emitWalletCounter("pass_failed", {
      ...baseProps,
      // @ts-expect-error testing runtime guard
      failure_code: "bogus_value",
      error_message: "x",
    })
    expect(capture).not.toHaveBeenCalled()
    expect(captureMessage).toHaveBeenCalledWith(
      "wallet_counter_validator_rejected",
      expect.objectContaining({
        extra: expect.objectContaining({
          counter: "pass_failed",
          failure_code: "bogus_value",
        }),
      })
    )

    captureMessage.mockClear()
    emitWalletCounter("pass_gated", {
      ...baseProps,
      // @ts-expect-error testing runtime guard
      gate_reason: "not_a_real_reason",
    })
    expect(captureMessage).toHaveBeenCalledWith(
      "wallet_counter_validator_rejected",
      expect.objectContaining({
        extra: expect.objectContaining({
          counter: "pass_gated",
          gate_reason: "not_a_real_reason",
        }),
      })
    )
  })

  it("R-L7 (phase-4): pins literal redaction tokens", () => {
    // R-L7 (phase-4): the runbook documents the literal placeholder tokens;
    // a silent refactor renaming them would silently break operator search
    // queries. Pin the tokens in tests.
    expect(sanitizeWalletErrorMessage("user@example.com")).toContain(
      "<redacted_email>"
    )
    expect(sanitizeWalletErrorMessage("+48 501 222 333")).toContain(
      "<redacted_phone>"
    )
    expect(
      sanitizeWalletErrorMessage("123e4567-e89b-12d3-a456-426614174000")
    ).toContain("<entitlement_id>")
  })

  it("R-M1 (phase-4): grapheme truncation counts graphemes not UTF-16 units", () => {
    // 200 emojis @ .length===2 each is 400 code units; previous accounting
    // would cap at ~60 emojis (120/2). With grapheme counting we keep 120.
    const input = "😀".repeat(200)
    const out = sanitizeWalletErrorMessage(input)
    // Intl.Segmenter is available in modern Node; emoji should be preserved
    // up to 120 graphemes. Each emoji is 2 UTF-16 units so we expect 240
    // code units in the output, well over the previous 120-units cap.
    expect(out.length).toBeGreaterThan(120)
    // Count graphemes; should be exactly 120.
    const SegmenterCtor = (
      globalThis as {
        Intl?: {
          Segmenter?: new (
            locale?: string,
            opts?: { granularity?: string }
          ) => { segment(s: string): Iterable<{ segment: string }> }
        }
      }
    ).Intl?.Segmenter
    if (typeof SegmenterCtor !== "function") {
      // Skip the strict assertion on runtimes lacking Intl.Segmenter; the
      // unit length check above already proves the new accounting kept more
      // than the previous 120-code-unit cap.
      return
    }
    const segmenter = new SegmenterCtor(undefined, { granularity: "grapheme" })
    let count = 0
    for (const _ of segmenter.segment(out)) count++
    expect(count).toBe(120)
  })

  it("R-M2 (phase-4): phone regex does not over-match dates/IPs/timestamps/IDs", () => {
    // These must pass UN-redacted.
    expect(sanitizeWalletErrorMessage("at 2026-05-28T18:00:00Z")).not.toContain(
      "<redacted_phone>"
    )
    expect(sanitizeWalletErrorMessage("from 127.0.0.1:8080")).not.toContain(
      "<redacted_phone>"
    )
    expect(sanitizeWalletErrorMessage("ts 1700000000")).not.toContain(
      "<redacted_phone>"
    )
    expect(
      sanitizeWalletErrorMessage("pi_3OAbCdEf1234567890")
    ).not.toContain("<redacted_phone>")
    expect(
      sanitizeWalletErrorMessage("posthog-node@4.2.1")
    ).not.toContain("<redacted_phone>")
    // These must redact.
    expect(sanitizeWalletErrorMessage("call +48 123 456 789")).toContain(
      "<redacted_phone>"
    )
    expect(sanitizeWalletErrorMessage("ring (555) 123-4567")).toContain(
      "<redacted_phone>"
    )
  })

  it("R-M5 + R-M6 (phase-4): shutdown nulls reference first and resets guard", async () => {
    const captures: unknown[] = []
    const capture = jest.fn((evt: unknown) => {
      captures.push(evt)
    })
    let shutdownResolve: () => void = () => {}
    const shutdown = jest.fn(
      () => new Promise<void>((r) => (shutdownResolve = r))
    )
    setWalletPostHogClient({ capture, shutdown })

    const p = shutdownWalletPostHogClient()
    // R-M5: a concurrent emit observed during the in-flight shutdown must
    // NOT use the soon-to-be-closed client (posthogClient is nulled FIRST).
    emitWalletCounter("pass_generated", baseProps)
    expect(capture).not.toHaveBeenCalled()

    shutdownResolve()
    await p
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it("R-H1 (phase-4): server-only guard is in package.json sideEffects", () => {
    // R-H1 (phase-4): package.json must mark posthog.ts as a side-effect so
    // tree-shaking does not drop the browser-bundle import guard.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../../package.json") as {
      sideEffects?: ReadonlyArray<string>
    }
    expect(pkg.sideEffects).toEqual(
      expect.arrayContaining([expect.stringMatching(/telemetry\/posthog/)])
    )
  })

  it("R-M4 (phase-4): pass_generated skipped on empty entitlement_instance_id", () => {
    const capture = jest.fn()
    setWalletPostHogClient({ capture })

    emitWalletCounter("pass_generated", { ...baseProps, entitlement_instance_id: "" })
    expect(capture).not.toHaveBeenCalled()
  })

  it("R-M4 (phase-4): pass_failed uses anon distinct_id on empty id", () => {
    const capture = jest.fn()
    setWalletPostHogClient({ capture })

    emitWalletCounter("pass_failed", {
      ...baseProps,
      entitlement_instance_id: "",
      failure_code: "client_error",
      error_message: "boom",
    })
    emitWalletCounter("pass_failed", {
      ...baseProps,
      entitlement_instance_id: "",
      failure_code: "client_error",
      error_message: "boom2",
    })
    expect(capture).toHaveBeenCalledTimes(2)
    const calls = capture.mock.calls.map((c) => c[0] as { distinctId: string })
    expect(calls[0]!.distinctId).toMatch(/^actor:P4:anon-/)
    expect(calls[1]!.distinctId).toMatch(/^actor:P4:anon-/)
    expect(calls[0]!.distinctId).not.toBe(calls[1]!.distinctId)
  })
})
