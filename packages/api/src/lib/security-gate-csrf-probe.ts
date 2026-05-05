import * as crypto from "node:crypto"

const DEFAULT_ROUTE_PATH = "/security-gates/csrf-probe"
const DEFAULT_PURPOSE = "gp-security-gates-csrf-probe-v1"

function trimValue(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed.replace(/\/+$/, "") : null
}

function firstOrigin(csv: string | undefined): string | null {
  return (
    csv
      ?.split(",")
      .map((item) => trimValue(item))
      .find((item): item is string => Boolean(item)) ?? null
  )
}

export function resolveCsrfProbeAllowedOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return (
    trimValue(env.GP_SEC_GATE_CSRF_ALLOWED_ORIGIN) ??
    trimValue(env.STOREFRONT_URL) ??
    firstOrigin(env.STORE_CORS)
  )
}

export function deriveCsrfProbeToken(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = trimValue(env.GP_SEC_GATE_CSRF_PROBE_TOKEN)
  if (explicit) {
    return explicit
  }

  const allowedOrigin = resolveCsrfProbeAllowedOrigin(env)
  const secret =
    trimValue(env.GP_SEC_GATE_CSRF_PROBE_SECRET) ??
    trimValue(env.JWT_SECRET) ??
    trimValue(env.COOKIE_SECRET)

  if (!allowedOrigin || !secret) {
    return null
  }

  return crypto
    .createHash("sha256")
    .update(`${DEFAULT_PURPOSE}:${allowedOrigin}:${secret}`)
    .digest("hex")
}

export function resolveCsrfProbeUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = trimValue(env.GP_SEC_GATE_CSRF_PROBE_URL)
  if (explicit) {
    return explicit
  }

  const port = trimValue(env.PORT)
  return port ? `http://127.0.0.1:${port}${DEFAULT_ROUTE_PATH}` : null
}
