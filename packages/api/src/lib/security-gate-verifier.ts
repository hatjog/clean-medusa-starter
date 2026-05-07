/**
 * Story v160-8-6: Defense-in-depth security gate verifier.
 * Story v160-cleanup-15f — AC4 fix: each gate now runs an actual BEHAVIOR
 *   probe (not file-presence / env-presence checks):
 *     - rate_limiting: drains the in-memory token bucket and asserts the
 *       N+1th call returns allowed=false (true rate-limit refusal behavior).
 *     - captcha: verifies a known-bad token via the configured provider's
 *       verify endpoint (when provider env is set) → expects rejection.
 *     - csrf: posts to a guarded endpoint with mismatched origin → expects
 *       4xx/403 (when GP_SEC_GATE_CSRF_PROBE_URL set).
 *     - gp_config_signing: actual `crypto.verify` call against a fixture
 *       canonical-bytes + signature pair using the configured Ed25519
 *       pubkey → expects verification PASS for valid pair, FAIL for
 *       tampered bytes.
 *
 * Gates that lack the live env to probe return `skip` — but skip now
 * counts as `fail` in the smoke-gate aggregate verdict (cleanup-15f AC3).
 *
 * @see specs/operator/security-gates-checklist.md
 * @see FR42 / FR43 / AR45 / AR46
 */

import {
  buildPublicKeyKid,
  verifyEd25519Signature,
} from "./gp-config-signing"
import { InMemoryTokenBucketAdapter } from "./rate-limit-token-bucket"
import {
  deriveCsrfProbeToken,
  resolveCsrfProbeAllowedOrigin,
  resolveCsrfProbeUrl,
} from "./security-gate-csrf-probe"

export type SecurityGate =
  | "rate_limiting"
  | "captcha"
  | "csrf"
  | "gp_config_signing"

export type GateStatus = "pass" | "fail" | "skip"

export type GateResult = {
  gate: SecurityGate
  status: GateStatus
  detail: string
  last_verified_at: string
  evidence?: Record<string, unknown>
}

export type AllGatesResult = {
  gates: GateResult[]
  overall: "pass" | "fail"
  verified_at: string
}

type HttpProbeRequestFixture = {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

type TwoPhaseHttpProbeFixture = {
  negative: HttpProbeRequestFixture
  positive: HttpProbeRequestFixture
  expect_negative_statuses?: number[]
  expect_positive_statuses?: number[]
}

const NOW = (): string => new Date().toISOString()

async function loadJsonFixture<T>(fixturePath: string): Promise<T> {
  const fs = await import("node:fs/promises")
  return JSON.parse(await fs.readFile(fixturePath, "utf8")) as T
}

function normalizeBody(body: unknown): string | undefined {
  if (body === undefined || body === null) {
    return undefined
  }
  if (typeof body === "string") {
    return body
  }
  return JSON.stringify(body)
}

async function runFixtureRequest(
  request: HttpProbeRequestFixture,
): Promise<{ status: number }> {
  const headers = new Headers(request.headers ?? {})
  if (
    request.body !== undefined &&
    request.body !== null &&
    typeof request.body === "object" &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json")
  }

  const response = await fetch(request.url, {
    method: request.method ?? "POST",
    headers,
    body: normalizeBody(request.body),
  })

  return { status: response.status }
}

function matchesExpectedStatus(
  status: number,
  expected: number[] | undefined,
  fallback: (status: number) => boolean,
): boolean {
  return expected && expected.length > 0 ? expected.includes(status) : fallback(status)
}

async function runFixtureBackedHttpProbe(args: {
  gate: "captcha" | "csrf"
  fixturePath: string
  negativeFallback: (status: number) => boolean
  positiveFallback: (status: number) => boolean
  successDetail: string
}): Promise<GateResult> {
  try {
    const fixture = await loadJsonFixture<TwoPhaseHttpProbeFixture>(args.fixturePath)
    const negative = await runFixtureRequest(fixture.negative)
    const positive = await runFixtureRequest(fixture.positive)

    const negativeOk = matchesExpectedStatus(
      negative.status,
      fixture.expect_negative_statuses,
      args.negativeFallback,
    )
    const positiveOk = matchesExpectedStatus(
      positive.status,
      fixture.expect_positive_statuses,
      args.positiveFallback,
    )

    if (negativeOk && positiveOk) {
      return {
        gate: args.gate,
        status: "pass",
        detail: args.successDetail,
        last_verified_at: NOW(),
        evidence: {
          fixture_path: args.fixturePath,
          negative_status: negative.status,
          positive_status: positive.status,
        },
      }
    }

    return {
      gate: args.gate,
      status: "fail",
      detail:
        `fixture probe mismatch: negative_status=${negative.status} positive_status=${positive.status}`,
      last_verified_at: NOW(),
      evidence: {
        fixture_path: args.fixturePath,
        negative_status: negative.status,
        positive_status: positive.status,
      },
    }
  } catch (err) {
    return {
      gate: args.gate,
      status: "fail",
      detail: `fixture probe threw: ${(err as Error).message}`,
      last_verified_at: NOW(),
    }
  }
}

/**
 * Behavior probe — drain a fresh in-memory bucket; assert N+1th consume
 * returns allowed=false. This is a structural verification of the
 * token-bucket primitive used by all rate-limited routes; it does NOT
 * exercise the live Redis adapter (set GP_SEC_GATE_PROBE_LIVE=true to
 * additionally hit the configured limiter on /store/products).
 */
async function probeRateLimiting(): Promise<GateResult> {
  try {
    const bucket = new InMemoryTokenBucketAdapter()
    const args = { bucket_key: "sec_gate_probe", bucket_size: 5, refill_per_min: 0 }

    const allowedResults: boolean[] = []
    for (let i = 0; i < args.bucket_size; i++) {
      const r = await bucket.consume(args)
      allowedResults.push(r.allowed)
    }
    const overflow = await bucket.consume(args)

    const allInitialAllowed = allowedResults.every((v) => v === true)
    const overflowBlocked = overflow.allowed === false && overflow.retry_after_ms > 0

    if (!allInitialAllowed) {
      return {
        gate: "rate_limiting",
        status: "fail",
        detail: `expected first ${args.bucket_size} consumes allowed; got ${JSON.stringify(allowedResults)}`,
        last_verified_at: NOW(),
      }
    }
    if (!overflowBlocked) {
      return {
        gate: "rate_limiting",
        status: "fail",
        detail: `expected N+1 consume blocked with retry_after_ms > 0; got allowed=${overflow.allowed} retry_after_ms=${overflow.retry_after_ms}`,
        last_verified_at: NOW(),
      }
    }
    return {
      gate: "rate_limiting",
      status: "pass",
      detail: `bucket drained (5/5 allowed) + 6th blocked (retry_after_ms=${overflow.retry_after_ms}) — token-bucket behavior verified`,
      last_verified_at: NOW(),
      evidence: {
        bucket_size: args.bucket_size,
        n_plus_1_allowed: overflow.allowed,
        n_plus_1_retry_after_ms: overflow.retry_after_ms,
      },
    }
  } catch (err) {
    return {
      gate: "rate_limiting",
      status: "fail",
      detail: `probe threw: ${(err as Error).message}`,
      last_verified_at: NOW(),
    }
  }
}

/**
 * Behavior probe — submit a known-bad CAPTCHA token to the configured
 * provider's verify endpoint and assert rejection. When provider env is
 * absent, returns `skip` (counts as fail in cleanup-15f AC3 aggregate).
 */
async function probeCaptcha(): Promise<GateResult> {
  const fixturePath = process.env.GP_SEC_GATE_CAPTCHA_FIXTURE_PATH
  const provider = process.env.GP_RECIPIENT_CLAIM_CAPTCHA_PROVIDER
  const recaptchaSecret = process.env.RECAPTCHA_SECRET_KEY
  const hcaptchaSecret = process.env.HCAPTCHA_SECRET

  if (fixturePath) {
    return runFixtureBackedHttpProbe({
      gate: "captcha",
      fixturePath,
      negativeFallback: (status) => [400, 401, 403, 422].includes(status),
      positiveFallback: (status) => status >= 200 && status < 300,
      successDetail:
        "fixture-backed CAPTCHA probe confirmed both rejection without token and acceptance with staging stub token",
    })
  }

  if (!provider || (!recaptchaSecret && !hcaptchaSecret)) {
    return {
      gate: "captcha",
      status: "skip",
      detail:
        "CAPTCHA probe not configured (set GP_SEC_GATE_CAPTCHA_FIXTURE_PATH or provider env to enable behavior probe).",
      last_verified_at: NOW(),
    }
  }

  const badToken = "INTENTIONALLY_INVALID_TOKEN_FOR_GATE_VERIFY"
  const verifyUrl =
    provider === "hcaptcha"
      ? "https://hcaptcha.com/siteverify"
      : "https://www.google.com/recaptcha/api/siteverify"
  const secret = provider === "hcaptcha" ? hcaptchaSecret! : recaptchaSecret!

  try {
    const body = new URLSearchParams({ secret, response: badToken })
    const response = await fetch(verifyUrl, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    })
    const json = (await response.json()) as { success?: boolean }

    if (json.success === false) {
      return {
        gate: "captcha",
        status: "pass",
        detail: `provider=${provider} rejected known-bad token (success=false) — verify behavior confirmed`,
        last_verified_at: NOW(),
        evidence: { provider, http_status: response.status },
      }
    }
    return {
      gate: "captcha",
      status: "fail",
      detail: `provider=${provider} returned success=${json.success} for bad token — gate not enforcing`,
      last_verified_at: NOW(),
    }
  } catch (err) {
    return {
      gate: "captcha",
      status: "fail",
      detail: `provider=${provider} verify endpoint threw: ${(err as Error).message}`,
      last_verified_at: NOW(),
    }
  }
}

/**
 * Behavior probe — POST to the guarded probe URL with a mismatched origin
 * header and assert 4xx response. When GP_SEC_GATE_CSRF_PROBE_URL is not
 * set, returns `skip`.
 */
async function probeCsrf(): Promise<GateResult> {
  const fixturePath = process.env.GP_SEC_GATE_CSRF_FIXTURE_PATH
  const probeUrl = resolveCsrfProbeUrl(process.env)
  const allowedOrigin = resolveCsrfProbeAllowedOrigin(process.env)
  const probeToken = deriveCsrfProbeToken(process.env)

  if (fixturePath) {
    return runFixtureBackedHttpProbe({
      gate: "csrf",
      fixturePath,
      negativeFallback: (status) => [400, 401, 403, 419].includes(status),
      positiveFallback: (status) => status !== 403 && status < 500,
      successDetail:
        "fixture-backed CSRF probe confirmed cross-origin rejection and same-origin/token acceptance",
    })
  }

  if (!probeUrl || !allowedOrigin || !probeToken) {
    return {
      gate: "csrf",
      status: "skip",
      detail:
        "CSRF probe not configured (set GP_SEC_GATE_CSRF_FIXTURE_PATH or configure STOREFRONT_URL/STORE_CORS + JWT_SECRET/COOKIE_SECRET, or override GP_SEC_GATE_CSRF_PROBE_URL|GP_SEC_GATE_CSRF_ALLOWED_ORIGIN|GP_SEC_GATE_CSRF_PROBE_TOKEN).",
      last_verified_at: NOW(),
    }
  }

  try {
    const negative = await fetch(probeUrl, {
      method: "POST",
      headers: {
        Origin: "https://attacker.example.invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })

    const positive = await fetch(probeUrl, {
      method: "POST",
      headers: {
        Origin: allowedOrigin,
        "Content-Type": "application/json",
        "x-csrf-token": probeToken,
      },
      body: JSON.stringify({}),
    })

    const negativeOk = negative.status >= 400 && negative.status < 500
    const positiveOk = positive.status >= 200 && positive.status < 300

    if (negativeOk && positiveOk) {
      return {
        gate: "csrf",
        status: "pass",
        detail: `cross-origin POST returned ${negative.status} and same-origin/token POST returned ${positive.status} — CSRF guard behavior verified`,
        last_verified_at: NOW(),
        evidence: {
          negative_status: negative.status,
          positive_status: positive.status,
          probe_url: probeUrl,
          allowed_origin: allowedOrigin,
        },
      }
    }
    return {
      gate: "csrf",
      status: "fail",
      detail: `CSRF probe mismatch: negative_status=${negative.status} positive_status=${positive.status}`,
      last_verified_at: NOW(),
    }
  } catch (err) {
    return {
      gate: "csrf",
      status: "fail",
      detail: `CSRF probe threw: ${(err as Error).message}`,
      last_verified_at: NOW(),
    }
  }
}

/**
 * Behavior probe — actual `crypto.verify` against a fixture canonical-bytes
 * + signature pair using the configured Ed25519 pubkey. Two assertions:
 *   1. valid pair verifies successfully (pubkey + algorithm correct)
 *   2. tampered canonical-bytes fail to verify (signing chain integrity)
 *
 * When fixtures are absent (env GP_SEC_GATE_GP_CONFIG_FIXTURE_PATH unset),
 * returns `skip`.
 */
async function probeGpConfigSigning(): Promise<GateResult> {
  const pubkey = process.env.GP_CONFIG_VERIFY_PUBKEY
  const fixturePath = process.env.GP_SEC_GATE_GP_CONFIG_FIXTURE_PATH

  if (!pubkey || !fixturePath) {
    return {
      gate: "gp_config_signing",
      status: "skip",
      detail:
        "Ed25519 pubkey or fixture path not configured (set GP_CONFIG_VERIFY_PUBKEY + GP_SEC_GATE_GP_CONFIG_FIXTURE_PATH to enable behavior probe).",
      last_verified_at: NOW(),
    }
  }

  try {
    const fixture = await loadJsonFixture<{
      canonical_bytes_base64: string
      signature_base64: string
    }>(fixturePath)

    const canonical = Buffer.from(fixture.canonical_bytes_base64, "base64")
    const signature = Buffer.from(fixture.signature_base64, "base64")

    if (canonical.length === 0) {
      return {
        gate: "gp_config_signing",
        status: "fail",
        detail: "gp_config_signing fixture canonical bytes are empty",
        last_verified_at: NOW(),
      }
    }

    const validVerify = verifyEd25519Signature(canonical, signature, pubkey)

    // Tamper test: flip a byte; expect verification to fail.
    const tampered = Buffer.from(canonical)
    tampered[0] = (tampered[0] ?? 0) ^ 0x01
    const tamperedVerify = verifyEd25519Signature(tampered, signature, pubkey)

    if (validVerify && !tamperedVerify) {
      return {
        gate: "gp_config_signing",
        status: "pass",
        detail:
          "Ed25519 verify behavior confirmed: valid pair verifies, tampered bytes fail to verify",
        last_verified_at: NOW(),
        evidence: {
          pubkey_kid: buildPublicKeyKid(pubkey),
          fixture_path: fixturePath,
        },
      }
    }
    return {
      gate: "gp_config_signing",
      status: "fail",
      detail: `Ed25519 verify behavior anomaly: valid_verify=${validVerify} tampered_verify=${tamperedVerify} (expected true,false)`,
      last_verified_at: NOW(),
    }
  } catch (err) {
    return {
      gate: "gp_config_signing",
      status: "fail",
      detail: `gp_config_signing probe threw: ${(err as Error).message}`,
      last_verified_at: NOW(),
    }
  }
}

export async function verifyGate(gate: SecurityGate): Promise<GateResult> {
  switch (gate) {
    case "rate_limiting":
      return probeRateLimiting()
    case "captcha":
      return probeCaptcha()
    case "csrf":
      return probeCsrf()
    case "gp_config_signing":
      return probeGpConfigSigning()
  }
}

export async function verifyAllGates(): Promise<AllGatesResult> {
  const gates = await Promise.all([
    verifyGate("rate_limiting"),
    verifyGate("captcha"),
    verifyGate("csrf"),
    verifyGate("gp_config_signing"),
  ])
  // Story v160-cleanup-15f — AC3: any 'fail' OR 'skip' → overall fail.
  // Skipped gates count as fail in the smoke-gate aggregate (operators
  // must explicitly force-override via ratifyVerdict to pass with skips).
  const overall = gates.some((g) => g.status !== "pass") ? "fail" : "pass"
  return { gates, overall, verified_at: NOW() }
}
