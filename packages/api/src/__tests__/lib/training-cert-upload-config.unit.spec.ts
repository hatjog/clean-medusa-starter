/**
 * Story v160-cleanup-39-magicbyte-validator (TF-93) — config validation tests.
 *
 * Verifies:
 *   - Default 10 MiB when env unset
 *   - Custom positive integer respected
 *   - Boot-time RangeError on non-numeric / zero / negative values
 *   - Cached on first call (subsequent reads do not re-validate)
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals"
import {
  getMaxUploadBytes,
  resetMaxUploadBytesForTests,
} from "../../../src/lib/training-cert-upload-config"

const ENV_KEY = "GP_TRAINING_CERT_MAX_BYTES"
const originalEnv = process.env[ENV_KEY]

describe("getMaxUploadBytes", () => {
  beforeEach(() => {
    resetMaxUploadBytesForTests()
    delete process.env[ENV_KEY]
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY]
    } else {
      process.env[ENV_KEY] = originalEnv
    }
    resetMaxUploadBytesForTests()
  })

  it("returns default 10 MiB when env unset", () => {
    expect(getMaxUploadBytes()).toBe(10 * 1024 * 1024)
  })

  it("returns parsed value when env set to a positive integer", () => {
    process.env[ENV_KEY] = String(5 * 1024 * 1024)
    expect(getMaxUploadBytes()).toBe(5 * 1024 * 1024)
  })

  it("throws RangeError on zero", () => {
    process.env[ENV_KEY] = "0"
    expect(() => getMaxUploadBytes()).toThrow(RangeError)
  })

  it("throws RangeError on negative value", () => {
    process.env[ENV_KEY] = "-1"
    expect(() => getMaxUploadBytes()).toThrow(RangeError)
  })

  it("throws RangeError on non-numeric value", () => {
    process.env[ENV_KEY] = "abc"
    expect(() => getMaxUploadBytes()).toThrow(RangeError)
  })

  it("caches the resolved value (env change after first call has no effect)", () => {
    process.env[ENV_KEY] = String(7 * 1024 * 1024)
    const first = getMaxUploadBytes()
    process.env[ENV_KEY] = String(8 * 1024 * 1024)
    const second = getMaxUploadBytes()
    expect(first).toBe(7 * 1024 * 1024)
    expect(second).toBe(7 * 1024 * 1024) // cached, env mutation ignored
  })
})
