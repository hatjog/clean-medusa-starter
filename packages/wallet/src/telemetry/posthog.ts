import type {
  PostHogCaptureClient,
  SentryCaptureClient,
  WalletCounter,
  WalletCounterProps,
} from "./types"

// P5: SERVER-ONLY MODULE. This file lazy-`require`s `posthog-node` and reads
// `POSTHOG_API_KEY` from `process.env`. Importing it from a browser bundle is
// a build-time error indicator: Next.js / Webpack should never resolve this
// path on the client. Consumers needing a frontend telemetry helper MUST use
// `apps/web/src/lib/telemetry/wallet.ts` or
// `GP/storefront/src/lib/telemetry/wallet.ts` (posthog-js based), not this
// package. The marker below short-circuits any accidental client-bundle
// import (e.g. via barrel re-export drift) before it can leak the secret.
if (typeof process === "undefined" || typeof (process as { env?: unknown }).env === "undefined") {
  throw new Error(
    "@gp/wallet/telemetry/posthog is a server-only module and must not be imported from a browser bundle"
  )
}

let posthogClient: PostHogCaptureClient | null = null
let sentryClient: SentryCaptureClient | null = null
let envInitAttempted = false

export function setWalletPostHogClient(
  client: PostHogCaptureClient | null
): void {
  posthogClient = client
  // P6: `envInitAttempted` is now monotonic — it transitions to `true` the
  // first time `createPostHogClientFromEnv` runs and stays `true` for the
  // process lifetime. Passing `null` does NOT reset the guard, otherwise
  // subsequent emits in production code paths would re-init the env-driven
  // client behind the back of an explicit override. Tests that want the
  // env-driven singleton revived should call `resetWalletPostHogEnvInit()`.
  if (client !== null) envInitAttempted = true
}

/**
 * P6: test-only helper to reset the env-init guard. Production code MUST NOT
 * call this; the guard is monotonic on purpose so accidental late env reads
 * do not silently swap clients during a request lifecycle.
 */
export function resetWalletPostHogEnvInit(): void {
  envInitAttempted = false
}

export function setWalletSentryClient(client: SentryCaptureClient | null): void {
  sentryClient = client
}

export async function shutdownWalletPostHogClient(): Promise<void> {
  const client = posthogClient
  if (!client) return
  try {
    if (typeof client.shutdown === "function") {
      await client.shutdown()
    } else if (typeof client.flush === "function") {
      await client.flush()
    }
  } catch (err) {
    sentryClient?.captureMessage("posthog_emit_failed", {
      extra: { counter: "shutdown", err },
    })
  } finally {
    // P21: drop the reference after shutdown so the next emit either creates
    // a fresh client from env or noops. Without this, callers that shutdown
    // during SIGTERM could still see late emits attempt to enqueue against a
    // closed underlying PostHog client.
    posthogClient = null
  }
}

// P12: per-counter property whitelist. The backend emits only the properties
// the dashboard panels read; anything else is dropped to prevent accidental
// leaks if a caller passes through extraneous fields.
const COMMON_KEYS = [
  "provider",
  "market",
  "locale",
  "actor",
  "entitlement_type",
  "entitlement_instance_id",
] as const
const COUNTER_EXTRAS: Record<WalletCounter, readonly string[]> = {
  pass_generated: [],
  pass_failed: ["failure_code", "error_message"],
  pass_gated: ["gate_reason"],
}

const ALLOWED_GATE_REASONS = new Set([
  "market_not_pilot",
  "apple_disabled",
  "release_pre_flag_flip",
  "lifecycle_invalidated",
])

const ALLOWED_FAILURE_CODES = new Set([
  "provider_error",
  "network",
  "policy_deny",
  "auth_expired",
  "client_error",
])

export function emitWalletCounter(
  counter: WalletCounter,
  props: WalletCounterProps
): void {
  try {
    const client = posthogClient ?? createPostHogClientFromEnv()
    if (!client) return

    const { error_message, gate_reason, ...rest } = props as WalletCounterProps & {
      error_message?: string
      gate_reason?: string
    }

    // P12: whitelist-first construction.
    const allowed = new Set<string>([
      ...COMMON_KEYS,
      ...COUNTER_EXTRAS[counter],
    ])
    const properties: Record<string, unknown> = {}
    for (const key of Object.keys(rest)) {
      if (allowed.has(key)) {
        properties[key] = (rest as Record<string, unknown>)[key]
      }
    }

    if (counter === "pass_failed") {
      if (typeof error_message === "string" && error_message.trim().length > 0) {
        // P9: drop empty error_message rather than ship empty.
        properties.error_message = sanitizeWalletErrorMessage(error_message)
      }
      const code = (rest as { failure_code?: unknown }).failure_code
      if (
        typeof code !== "string" ||
        !ALLOWED_FAILURE_CODES.has(code as string)
      ) {
        // P12 + P25: runtime guard — reject unknown failure_code values.
        return
      }
    }
    if (counter === "pass_gated") {
      // P12: validate gate_reason against the WalletFeaturePolicy enumeration.
      if (typeof gate_reason !== "string" || !ALLOWED_GATE_REASONS.has(gate_reason)) {
        return
      }
      properties.gate_reason = gate_reason
    }

    // P1 + P7: distinct_id = `actor:P4:<entitlement_instance_id>` — actor
    // prefix is the deterministic salt that scopes the funnel join to the
    // P4 recipient action without leaking PII (D-110 invariant).
    client.capture({
      distinctId: `actor:P4:${props.entitlement_instance_id}`,
      event: `wallet.${counter}`,
      properties,
    })
  } catch (err) {
    sentryClient?.captureMessage("posthog_emit_failed", {
      extra: { counter, err },
    })
  }
}

// P4/P8/P23/P24: harden sanitizer.
// - email: anchored TLD-aware match (no longer eats arbitrary tokens with @).
// - phone: tolerate spaces/dots/dashes/parens around 7+ digit runs.
// - uuid: any 8-4-4-4-12 hex (v1..v5 + non-canonical).
// - truncation: grapheme-aware (Intl.Segmenter when present, Array.from
//   fallback for code-point safety).
const SANITIZE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const SANITIZE_PHONE =
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3}[\s.-]?\d{2,4}[\s.-]?\d{2,4}/g
const SANITIZE_UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

export function sanitizeWalletErrorMessage(message: unknown): string {
  const redacted = String(message ?? "unknown_error")
    .replace(SANITIZE_EMAIL, "<redacted_email>")
    .replace(SANITIZE_PHONE, (match) => {
      // Preserve short numeric tokens (e.g. HTTP status codes).
      const digits = match.replace(/\D/g, "")
      return digits.length >= 7 ? "<redacted_phone>" : match
    })
    .replace(SANITIZE_UUID, "<entitlement_id>")
  return truncateGraphemes(redacted, 120)
}

// P8: grapheme-aware truncation. Prefer Intl.Segmenter; fall back to
// Array.from which iterates by code point (no surrogate pair splits).
function truncateGraphemes(input: string, limit: number): string {
  if (input.length <= limit) return input
  const SegmenterCtor = (globalThis as { Intl?: { Segmenter?: unknown } }).Intl
    ?.Segmenter as
    | (new (
        locale?: string,
        options?: { granularity?: string }
      ) => { segment(s: string): Iterable<{ segment: string }> })
    | undefined
  if (typeof SegmenterCtor === "function") {
    const segmenter = new SegmenterCtor(undefined, { granularity: "grapheme" })
    const out: string[] = []
    let total = 0
    for (const { segment } of segmenter.segment(input)) {
      if (total + segment.length > limit) break
      out.push(segment)
      total += segment.length
    }
    return out.join("")
  }
  return Array.from(input).slice(0, limit).join("")
}

function createPostHogClientFromEnv(): PostHogCaptureClient | null {
  if (envInitAttempted) return posthogClient
  envInitAttempted = true

  const apiKey = process.env.POSTHOG_API_KEY
  if (!apiKey) return null

  try {
    // The @gp/wallet package is compiled to CommonJS (tsconfig module:Node16,
    // no "type": "module" in backend package.json); `require` is therefore
    // available at runtime. The dependency stays lazy so tests and consumers
    // without PostHog configured do not pay an import cost.
    const { PostHog } = require("posthog-node") as {
      PostHog: new (
        key: string,
        options?: {
          host?: string
          flushAt?: number
          flushInterval?: number
        }
      ) => PostHogCaptureClient
    }
    // flushAt:1 ships counters immediately rather than buffering up to 20
    // events (default), reducing event loss on SIGTERM in short-lived
    // workers and avoiding flaky test timing.
    posthogClient = new PostHog(apiKey, {
      host: process.env.POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
    })
    return posthogClient
  } catch (err) {
    sentryClient?.captureMessage("posthog_emit_failed", {
      extra: { counter: "init", err },
    })
    return null
  }
}
