import * as fs from "node:fs/promises"
import * as path from "node:path"

import {
  GET,
  POST,
} from "../../packages/api/src/api/admin/operator/security-gates/route"
import {
  deriveCsrfProbeToken,
  resolveCsrfProbeAllowedOrigin,
  resolveCsrfProbeUrl,
} from "../../packages/api/src/lib/security-gate-csrf-probe"
import {
  materializeGpConfigSigningArtifact,
} from "../../packages/api/src/scripts/materialize-gp-config-signing-artifact"

type JsonResponse = {
  statusCode: number
  body: unknown
  status: (code: number) => JsonResponse
  json: (payload: unknown) => unknown
}

type Issue = {
  gate: "captcha" | "csrf" | "gp_config_signing"
  level: "missing" | "rejected"
  detail: string
}

type HttpProbeFixture = {
  negative?: { url?: string }
  positive?: { url?: string }
}

function parseEnvValue(raw: string): string {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }

  return trimmed
}

async function loadEnvFileIfPresent(filePath: string): Promise<void> {
  try {
    const raw = await fs.readFile(filePath, "utf8")
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) {
        continue
      }

      const separator = trimmed.indexOf("=")
      if (separator <= 0) {
        continue
      }

      const key = trimmed.slice(0, separator).trim()
      if (!key || process.env[key] !== undefined) {
        continue
      }

      process.env[key] = parseEnvValue(trimmed.slice(separator + 1))
    }
  } catch {
    // Ignore missing local env files; the helper will report remaining gaps.
  }
}

async function bootstrapLocalEnv(): Promise<void> {
  await loadEnvFileIfPresent(path.join(process.cwd(), ".env"))
  await loadEnvFileIfPresent(path.join(process.cwd(), ".env.local"))
}

function createResponse(label: string): JsonResponse {
  return {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      console.log(`\n=== ${label} ===`)
      console.log(JSON.stringify(payload, null, 2))
      return payload
    },
  }
}

async function fileExists(filePath: string | undefined): Promise<boolean> {
  if (!filePath) {
    return false
  }

  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function isHarnessUrl(url: string | undefined): boolean {
  if (!url) {
    return false
  }

  return url.includes("127.0.0.1:9137") || url.includes("/captcha/positive") || url.includes("/csrf/positive")
}

async function rejectHarnessFixture(
  gate: "captcha" | "csrf",
  fixturePath: string | undefined,
): Promise<Issue | null> {
  if (!fixturePath) {
    return null
  }

  if (!(await fileExists(fixturePath))) {
    return {
      gate,
      level: "missing",
      detail: `${fixturePath} does not exist`,
    }
  }

  if (process.env.ALLOW_HARNESS_FIXTURES === "1") {
    return null
  }

  const raw = await fs.readFile(fixturePath, "utf8")
  const parsed = JSON.parse(raw) as HttpProbeFixture

  if (isHarnessUrl(parsed.negative?.url) || isHarnessUrl(parsed.positive?.url)) {
    return {
      gate,
      level: "rejected",
      detail:
        `${fixturePath} appears to point at the local harness (127.0.0.1:9137 or probe stub paths). Set ALLOW_HARNESS_FIXTURES=1 only if you intentionally want the old harness mode.`,
    }
  }

  return null
}

async function collectIssues(): Promise<Issue[]> {
  const issues: Issue[] = []

  const captchaFixturePath = process.env.GP_SEC_GATE_CAPTCHA_FIXTURE_PATH
  const csrfFixturePath = process.env.GP_SEC_GATE_CSRF_FIXTURE_PATH
  const signingFixturePath = process.env.GP_SEC_GATE_GP_CONFIG_FIXTURE_PATH
  const captchaProvider = process.env.GP_RECIPIENT_CLAIM_CAPTCHA_PROVIDER
  const recaptchaSecret = process.env.RECAPTCHA_SECRET_KEY
  const hcaptchaSecret = process.env.HCAPTCHA_SECRET
  const csrfProbeUrl = resolveCsrfProbeUrl(process.env)
  const csrfAllowedOrigin = resolveCsrfProbeAllowedOrigin(process.env)
  const csrfProbeToken = deriveCsrfProbeToken(process.env)
  const signingPubkey = process.env.GP_CONFIG_VERIFY_PUBKEY

  const captchaFixtureIssue = await rejectHarnessFixture("captcha", captchaFixturePath)
  if (captchaFixtureIssue) {
    issues.push(captchaFixtureIssue)
  }

  const csrfFixtureIssue = await rejectHarnessFixture("csrf", csrfFixturePath)
  if (csrfFixtureIssue) {
    issues.push(csrfFixtureIssue)
  }

  const captchaProviderReady =
    (captchaProvider === "recaptcha" && Boolean(recaptchaSecret)) ||
    (captchaProvider === "hcaptcha" && Boolean(hcaptchaSecret))
  const captchaFixtureReady = Boolean(captchaFixturePath) && (await fileExists(captchaFixturePath))
  if (!captchaProviderReady && !captchaFixtureReady) {
    issues.push({
      gate: "captcha",
      level: "missing",
      detail:
        "configure GP_RECIPIENT_CLAIM_CAPTCHA_PROVIDER with RECAPTCHA_SECRET_KEY|HCAPTCHA_SECRET, or point GP_SEC_GATE_CAPTCHA_FIXTURE_PATH at a real non-harness fixture",
    })
  }

  const csrfFixtureReady = Boolean(csrfFixturePath) && (await fileExists(csrfFixturePath))
  if ((!csrfProbeUrl || !csrfAllowedOrigin || !csrfProbeToken) && !csrfFixtureReady) {
    issues.push({
      gate: "csrf",
      level: "missing",
      detail:
        "configure STOREFRONT_URL/STORE_CORS plus JWT_SECRET|COOKIE_SECRET, or override GP_SEC_GATE_CSRF_PROBE_URL|GP_SEC_GATE_CSRF_ALLOWED_ORIGIN|GP_SEC_GATE_CSRF_PROBE_TOKEN, or point GP_SEC_GATE_CSRF_FIXTURE_PATH at a real non-harness fixture",
    })
  }

  const signingFixtureReady = Boolean(signingFixturePath) && (await fileExists(signingFixturePath))
  if (!signingPubkey || !signingFixtureReady) {
    issues.push({
      gate: "gp_config_signing",
      level: "missing",
      detail:
        "configure both GP_CONFIG_VERIFY_PUBKEY and GP_SEC_GATE_GP_CONFIG_FIXTURE_PATH with a real signed gp-config artifact",
    })
  }

  return issues
}

async function ensureGpConfigSigningInputs(): Promise<void> {
  if (process.env.GP_CONFIG_VERIFY_PUBKEY && process.env.GP_SEC_GATE_GP_CONFIG_FIXTURE_PATH) {
    return
  }

  const result = await materializeGpConfigSigningArtifact({
    configRoot: process.env.GP_CONFIG_ROOT,
    instanceId: process.env.GP_INSTANCE_ID,
    allowEphemeralKey: true,
  })

  process.env.GP_CONFIG_VERIFY_PUBKEY = result.publicKey
  process.env.GP_SEC_GATE_GP_CONFIG_FIXTURE_PATH = result.fixturePath
  process.env.GP_CONFIG_ARTIFACT_PATH = result.artifactPath
}

function printConfigurationSummary(): void {
  const rows = [
    {
      gate: "captcha",
      mode: process.env.GP_SEC_GATE_CAPTCHA_FIXTURE_PATH
        ? `fixture:${process.env.GP_SEC_GATE_CAPTCHA_FIXTURE_PATH}`
        : process.env.GP_RECIPIENT_CLAIM_CAPTCHA_PROVIDER
          ? `provider:${process.env.GP_RECIPIENT_CLAIM_CAPTCHA_PROVIDER}`
          : "missing",
    },
    {
      gate: "csrf",
      mode: process.env.GP_SEC_GATE_CSRF_FIXTURE_PATH
        ? `fixture:${process.env.GP_SEC_GATE_CSRF_FIXTURE_PATH}`
        : resolveCsrfProbeUrl(process.env)
          ? `probe:${resolveCsrfProbeUrl(process.env)}`
          : "missing",
    },
    {
      gate: "gp_config_signing",
      mode:
        process.env.GP_SEC_GATE_GP_CONFIG_FIXTURE_PATH && process.env.GP_CONFIG_VERIFY_PUBKEY
          ? `artifact:${process.env.GP_SEC_GATE_GP_CONFIG_FIXTURE_PATH}`
          : "missing",
    },
  ]

  console.log("Runtime security-gates input summary:")
  console.table(rows)
}

async function main(): Promise<void> {
  await bootstrapLocalEnv()
  await ensureGpConfigSigningInputs()
  printConfigurationSummary()

  const issues = await collectIssues()
  if (issues.length > 0) {
    console.error("\nRuntime rerun prerequisites are not satisfied:")
    for (const issue of issues) {
      console.error(`- [${issue.gate}] ${issue.level}: ${issue.detail}`)
    }
    process.exitCode = 2
    return
  }

  const actorId = process.env.GP_SEC_GATE_RERUN_ACTOR_ID ?? "copilot-runtime-rerun"

  const postRes = createResponse("POST /admin/operator/security-gates")
  await POST(
    {
      body: {},
      auth_context: { actor_id: actorId },
    } as never,
    postRes as never,
  )

  const getRes = createResponse("GET /admin/operator/security-gates")
  await GET({} as never, getRes as never)

  const postBody = postRes.body as {
    overall?: string
    gates?: Array<{ gate: string; status: string }>
  }
  const allPass =
    postBody.overall === "pass" &&
    Array.isArray(postBody.gates) &&
    postBody.gates.every((gate) => gate.status === "pass")

  if (!allPass) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})