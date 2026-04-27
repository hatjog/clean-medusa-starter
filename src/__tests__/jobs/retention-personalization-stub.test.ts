import { describe, it, expect, jest, beforeEach } from "@jest/globals"

import retentionPersonalizationStub, {
  SCHEDULE_NAME,
  SCHEDULE_CRON,
  config,
} from "../../jobs/retention-personalization-stub"

/**
 * Unit tests for the v1.4.0 retention-personalization stub job (STORY-D65 AC #7).
 *
 * Asserts:
 *   - Schedule registration metadata (name, cron expression).
 *   - Log output contains ONLY timestamp + schedule name (no PII fields).
 *   - Stub does not invoke any DB read/delete (no resolve("voucherPersonalizationService"),
 *     no SQL execution).
 */

const PII_FIELD_NAMES = [
  "recipient_email",
  "recipient_phone",
  "recipient_name",
  "entitlement_id",
  "buyer_message",
] as const

function buildContainer(loggerOverride?: {
  info: jest.Mock
  warn?: jest.Mock
  error?: jest.Mock
}) {
  const logger = loggerOverride ?? {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
  const resolve = jest.fn((key: string) => {
    if (key === "logger") return logger
    return null
  })
  return { resolve, logger }
}

describe("retention-personalization-stub (D-65 + ADR-065)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("exports schedule registration with correct name + cron expression", () => {
    expect(config.name).toBe("retention-personalization-stub")
    expect(config.name).toBe(SCHEDULE_NAME)
    expect(config.schedule).toBe("0 3 * * *")
    expect(config.schedule).toBe(SCHEDULE_CRON)
  })

  it("emits exactly one log line per tick", async () => {
    const ctx = buildContainer()
    await retentionPersonalizationStub(ctx as any)
    expect(ctx.logger.info).toHaveBeenCalledTimes(1)
  })

  it("log line contains schedule name + ISO-8601 timestamp", async () => {
    const ctx = buildContainer()
    await retentionPersonalizationStub(ctx as any)
    const logArg = (ctx.logger.info as jest.Mock).mock.calls[0]?.[0] as string
    expect(logArg).toContain(SCHEDULE_NAME)
    // ISO-8601 UTC timestamp — e.g. 2026-04-27T12:34:56.789Z
    expect(logArg).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
  })

  it("log line MUST NOT contain any PII field name", async () => {
    const ctx = buildContainer()
    await retentionPersonalizationStub(ctx as any)
    const logArg = (ctx.logger.info as jest.Mock).mock.calls[0]?.[0] as string
    for (const piiField of PII_FIELD_NAMES) {
      expect(logArg).not.toContain(piiField)
    }
    // Sanity: no '@' (would indicate an email address) and no '+<digits>' (E.164 phone)
    expect(logArg).not.toMatch(/@/)
    expect(logArg).not.toMatch(/\+\d{2,}/)
  })

  it("does NOT resolve any service that would read PII rows", async () => {
    const ctx = buildContainer()
    await retentionPersonalizationStub(ctx as any)
    // Only "logger" should ever be resolved by the stub
    const resolvedKeys = (ctx.resolve as jest.Mock).mock.calls.map((c) => c[0])
    for (const key of resolvedKeys) {
      expect(key).toBe("logger")
    }
    // Explicit assertions on the most dangerous keys
    expect(resolvedKeys).not.toContain("voucherPersonalizationService")
    expect(resolvedKeys).not.toContain("voucher_personalization")
    expect(resolvedKeys).not.toContain("entitlementService")
    expect(resolvedKeys).not.toContain("manager") // typeorm manager — would imply DB access
  })

  it("is safe to call with a partial container (no logger registered)", async () => {
    // ANTI-PII guarantee #2: stub MUST NOT throw on a degraded container; it falls
    // back to console.info silently. Otherwise the job runner could leak unhandled
    // promise rejections that include the container shape in stack traces.
    const partialContainer = {
      resolve: jest.fn(() => {
        throw new Error("logger not registered in this test mock")
      }),
    }
    await expect(
      retentionPersonalizationStub(partialContainer as any),
    ).resolves.toBeUndefined()
  })
})
