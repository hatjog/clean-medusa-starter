/**
 * Story v160-cleanup-15f — AC1+AC4+AC5 unit coverage.
 *
 *   - request-log-aggregator: ring-buffer + p95/5xx-rate stats
 *   - cohort-metrics-aggregator: real status mapping (green/yellow/red/unknown)
 *   - security-gate-verifier: behavior probe asserting bucket-drain refusal
 *
 * Notes:
 *   - DB-backed phase-b-smoke-gate-aggregator and security probes that
 *     require live env (CAPTCHA, CSRF probe URL, gp-config fixture) are
 *     covered by integration tests gated on env presence — out of scope
 *     for this unit suite.
 */

import { describe, it, expect, beforeEach } from "@jest/globals"

import {
  computeWindowStats,
  recordRequest,
  _resetForTest,
} from "../../../src/lib/request-log-aggregator"
import { computeCohortMetrics } from "../../../src/lib/cohort-metrics-aggregator"
import { verifyGate } from "../../../src/lib/security-gate-verifier"

describe("request-log-aggregator (cleanup-15f AC1)", () => {
  beforeEach(() => {
    _resetForTest()
  })

  it("returns null stats when no samples in window", () => {
    const stats = computeWindowStats(60_000)
    expect(stats.sample_size).toBe(0)
    expect(stats.p95_latency_ms).toBeNull()
    expect(stats.error_rate_5xx_pct).toBeNull()
  })

  it("computes p95 latency from samples", () => {
    const now = Date.now()
    const durations = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    for (const d of durations) {
      recordRequest({ ts: now, duration_ms: d, status_code: 200 })
    }
    const stats = computeWindowStats(60_000, undefined, now + 1)
    expect(stats.sample_size).toBe(10)
    // p95 of sorted [100..1000] step 100; index = floor(10*0.95) = 9 → 1000
    expect(stats.p95_latency_ms).toBe(1000)
    expect(stats.error_rate_5xx_pct).toBe(0)
  })

  it("computes 5xx rate from samples", () => {
    const now = Date.now()
    for (let i = 0; i < 10; i++) {
      recordRequest({ ts: now, duration_ms: 100, status_code: i < 2 ? 503 : 200 })
    }
    const stats = computeWindowStats(60_000, undefined, now + 1)
    expect(stats.error_rate_5xx_pct).toBe(20)
  })

  it("excludes samples outside window", () => {
    const now = Date.now()
    recordRequest({ ts: now - 120_000, duration_ms: 100, status_code: 200 })
    recordRequest({ ts: now, duration_ms: 200, status_code: 200 })
    const stats = computeWindowStats(60_000, undefined, now + 1)
    expect(stats.sample_size).toBe(1)
    expect(stats.p95_latency_ms).toBe(200)
  })
})

describe("cohort-metrics-aggregator (cleanup-15f AC1)", () => {
  beforeEach(() => {
    _resetForTest()
  })

  it("returns unknown status when no samples", async () => {
    const result = await computeCohortMetrics()
    expect(result.cohorts.pre_flip_baseline.p95_latency_ms.status).toBe("unknown")
    expect(result.cohorts.pre_flip_baseline.error_rate_pct.status).toBe("unknown")
  })

  it("classifies p95 latency green when < 500ms", async () => {
    const now = Date.now()
    for (let i = 0; i < 20; i++) {
      recordRequest({ ts: now - 1000, duration_ms: 100, status_code: 200 })
    }
    const result = await computeCohortMetrics()
    expect(result.cohorts.pre_flip_baseline.p95_latency_ms.status).toBe("green")
    expect(result.cohorts.pre_flip_baseline.p95_latency_ms.value).toBe(100)
  })

  it("classifies p95 latency red when > 750ms", async () => {
    const now = Date.now()
    for (let i = 0; i < 20; i++) {
      recordRequest({ ts: now - 1000, duration_ms: 1500, status_code: 200 })
    }
    const result = await computeCohortMetrics()
    expect(result.cohorts.pre_flip_baseline.p95_latency_ms.status).toBe("red")
  })

  it("classifies error rate green when ≤ 1.0%", async () => {
    const now = Date.now()
    for (let i = 0; i < 100; i++) {
      recordRequest({ ts: now - 1000, duration_ms: 100, status_code: 200 })
    }
    const result = await computeCohortMetrics()
    expect(result.cohorts.pre_flip_baseline.error_rate_pct.status).toBe("green")
    expect(result.cohorts.pre_flip_baseline.error_rate_pct.value).toBe(0)
  })

  it("classifies error rate red when > 2.0%", async () => {
    const now = Date.now()
    for (let i = 0; i < 100; i++) {
      recordRequest({
        ts: now - 1000,
        duration_ms: 100,
        status_code: i < 5 ? 503 : 200,
      })
    }
    const result = await computeCohortMetrics()
    expect(result.cohorts.pre_flip_baseline.error_rate_pct.status).toBe("red")
    expect(result.cohorts.pre_flip_baseline.error_rate_pct.value).toBe(5)
  })
})

describe("security-gate-verifier (cleanup-15f AC4)", () => {
  it("rate_limiting probe asserts bucket drain + N+1 refusal (behavior, not presence)", async () => {
    const result = await verifyGate("rate_limiting")
    expect(result.gate).toBe("rate_limiting")
    expect(result.status).toBe("pass")
    expect(result.evidence?.n_plus_1_allowed).toBe(false)
    expect(result.evidence?.n_plus_1_retry_after_ms).toBeGreaterThan(0)
  })

  it("captcha probe returns skip when provider env absent (counts as fail in aggregate)", async () => {
    const captchaProvider = process.env.GP_RECIPIENT_CLAIM_CAPTCHA_PROVIDER
    delete process.env.GP_RECIPIENT_CLAIM_CAPTCHA_PROVIDER
    try {
      const result = await verifyGate("captcha")
      expect(result.gate).toBe("captcha")
      expect(result.status).toBe("skip")
    } finally {
      if (captchaProvider) {
        process.env.GP_RECIPIENT_CLAIM_CAPTCHA_PROVIDER = captchaProvider
      }
    }
  })

  it("csrf probe returns skip when probe URL absent", async () => {
    const prior = {
      fixturePath: process.env.GP_SEC_GATE_CSRF_FIXTURE_PATH,
      probeUrl: process.env.GP_SEC_GATE_CSRF_PROBE_URL,
      allowedOrigin: process.env.GP_SEC_GATE_CSRF_ALLOWED_ORIGIN,
      probeToken: process.env.GP_SEC_GATE_CSRF_PROBE_TOKEN,
      probeSecret: process.env.GP_SEC_GATE_CSRF_PROBE_SECRET,
      storefrontUrl: process.env.STOREFRONT_URL,
      storeCors: process.env.STORE_CORS,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
      port: process.env.PORT,
    }
    delete process.env.GP_SEC_GATE_CSRF_FIXTURE_PATH
    delete process.env.GP_SEC_GATE_CSRF_PROBE_URL
    delete process.env.GP_SEC_GATE_CSRF_ALLOWED_ORIGIN
    delete process.env.GP_SEC_GATE_CSRF_PROBE_TOKEN
    delete process.env.GP_SEC_GATE_CSRF_PROBE_SECRET
    delete process.env.STOREFRONT_URL
    delete process.env.STORE_CORS
    delete process.env.JWT_SECRET
    delete process.env.COOKIE_SECRET
    delete process.env.PORT
    try {
      const result = await verifyGate("csrf")
      expect(result.gate).toBe("csrf")
      expect(result.status).toBe("skip")
    } finally {
      if (prior.fixturePath) process.env.GP_SEC_GATE_CSRF_FIXTURE_PATH = prior.fixturePath
      if (prior.probeUrl) process.env.GP_SEC_GATE_CSRF_PROBE_URL = prior.probeUrl
      if (prior.allowedOrigin) {
        process.env.GP_SEC_GATE_CSRF_ALLOWED_ORIGIN = prior.allowedOrigin
      }
      if (prior.probeToken) process.env.GP_SEC_GATE_CSRF_PROBE_TOKEN = prior.probeToken
      if (prior.probeSecret) {
        process.env.GP_SEC_GATE_CSRF_PROBE_SECRET = prior.probeSecret
      }
      if (prior.storefrontUrl) process.env.STOREFRONT_URL = prior.storefrontUrl
      if (prior.storeCors) process.env.STORE_CORS = prior.storeCors
      if (prior.jwtSecret) process.env.JWT_SECRET = prior.jwtSecret
      if (prior.cookieSecret) process.env.COOKIE_SECRET = prior.cookieSecret
      if (prior.port) process.env.PORT = prior.port
    }
  })

  it("gp_config_signing probe returns skip when pubkey or fixture path absent", async () => {
    const pubkey = process.env.GP_CONFIG_VERIFY_PUBKEY
    const fixturePath = process.env.GP_SEC_GATE_GP_CONFIG_FIXTURE_PATH
    delete process.env.GP_CONFIG_VERIFY_PUBKEY
    delete process.env.GP_SEC_GATE_GP_CONFIG_FIXTURE_PATH
    try {
      const result = await verifyGate("gp_config_signing")
      expect(result.gate).toBe("gp_config_signing")
      expect(result.status).toBe("skip")
    } finally {
      if (pubkey) process.env.GP_CONFIG_VERIFY_PUBKEY = pubkey
      if (fixturePath) {
        process.env.GP_SEC_GATE_GP_CONFIG_FIXTURE_PATH = fixturePath
      }
    }
  })
})
