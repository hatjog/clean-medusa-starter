import type {
  PostHogCaptureClient,
  SentryCaptureClient,
  WalletCounter,
  WalletCounterProps,
} from "./types"

// P5 / R-H1: SERVER-ONLY MODULE. This file lazy-`require`s `posthog-node` and
// reads `POSTHOG_API_KEY` from `process.env`. Importing it from a browser
// bundle is a build-time error indicator: Next.js / Webpack should never
// resolve this path on the client.
//
// R-H1 (phase-4): the previous guard checked `typeof process === "undefined"`
// which FAILS to fire in Next.js / Webpack browser bundles where `process` is
// polyfilled to `{env:{}}`. Additionally, that check FALSE-POSITIVE crashes
// in alternative server runtimes (Vercel Edge, Cloudflare Workers, Deno)
// where `process` may be missing. The correct invariant for "this is a
// browser bundle" is "either `window` or `document` is defined". We also rely
// on `"sideEffects"` in package.json so this guard is preserved through
// tree-shaking.
if (typeof window !== "undefined" || typeof document !== "undefined") {
  throw new Error(
    "@gp/wallet/telemetry/posthog is server-only — do not import from browser code."
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
 * P6: helper to reset the env-init guard.
 *
 * Production code paths SHOULD NOT call this directly; the guard is monotonic
 * during a normal request lifecycle so accidental late env reads do not
 * silently swap clients. However, `shutdownWalletPostHogClient` calls it
 * automatically (R-M6) so that a graceful resume after intentional shutdown
 * is possible.
 *
 * R-M10 (phase-4): test files MUST call this in `beforeEach` to avoid jest
 * worker pollution from earlier suites that flipped `envInitAttempted=true`.
 */
export function resetWalletPostHogEnvInit(): void {
  envInitAttempted = false
}

export function setWalletSentryClient(client: SentryCaptureClient | null): void {
  sentryClient = client
}

/**
 * Shut down the configured PostHog client (flush pending events). After this
 * runs, subsequent `emitWalletCounter` calls will either re-init from
 * `POSTHOG_API_KEY` env (R-M6 graceful resume) or no-op when no env config
 * is present.
 *
 * R-M5 (phase-4): null the reference BEFORE awaiting shutdown so a concurrent
 * emit observing the live reference cannot enqueue against a closed client.
 * R-M6 (phase-4): also reset `envInitAttempted` so the next emit can rebuild
 * the env-driven singleton — shutdown IS a reset signal.
 */
export async function shutdownWalletPostHogClient(): Promise<void> {
  const client = posthogClient
  // R-M5: null FIRST so concurrent emits see a clean slate.
  posthogClient = null
  // R-M6: shutdown resets the env-init guard so post-shutdown emits can
  // re-init the client (otherwise the monotonic guard from P6 prevents any
  // production resume).
  envInitAttempted = false
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
        // P12 + P25 + R-H5: runtime guard — reject unknown failure_code
        // values. R-H5 (phase-4): also mirror to Sentry so the validator
        // rejection is observable instead of a silent counter hole.
        sentryClient?.captureMessage("wallet_counter_validator_rejected", {
          extra: {
            counter,
            failure_code: code,
            gate_reason: undefined,
          },
        })
        return
      }
    }
    if (counter === "pass_gated") {
      // P12: validate gate_reason against the WalletFeaturePolicy enumeration.
      if (typeof gate_reason !== "string" || !ALLOWED_GATE_REASONS.has(gate_reason)) {
        // R-H5 (phase-4): mirror validator rejection to Sentry.
        sentryClient?.captureMessage("wallet_counter_validator_rejected", {
          extra: {
            counter,
            failure_code: undefined,
            gate_reason,
          },
        })
        return
      }
      properties.gate_reason = gate_reason
    }

    // P1 + P7 + R-M4: distinct_id = `actor:P4:<entitlement_instance_id>`.
    // R-M4 (phase-4): when entitlement_instance_id is empty, the distinct_id
    // would collapse to `actor:P4:` and every empty-id event would merge into
    // the same PostHog person. For `pass_failed`/`pass_gated` we substitute a
    // random anon suffix so each failure stays distinct. For `pass_generated`
    // we skip emit entirely (no point counting a generation for unknown
    // entitlement; impossible by upstream API contract anyway).
    const distinctId = buildWalletDistinctId(
      counter,
      props.entitlement_instance_id
    )
    if (distinctId === null) return
    client.capture({
      distinctId,
      event: `wallet.${counter}`,
      properties,
    })
  } catch (err) {
    sentryClient?.captureMessage("posthog_emit_failed", {
      extra: { counter, err },
    })
  }
}

// P4/P8/P23/P24 + R-M2: harden sanitizer.
// - email: anchored TLD-aware match (no longer eats arbitrary tokens with @).
// - phone (R-M2 phase-4): more conservative pattern requiring word-boundary
//   anchors + a phone-shaped format. The previous regex `(?:\+?\d{1,3}...)`
//   over-matched dates (2026-05-28), IPv4 literals (127.0.0.1:8080), epoch
//   timestamps (1700000000), and Stripe IDs (pi_3OAbCdEf1234567890). We
//   prefer false-negative (some phones pass un-redacted) over false-positive
//   (timestamps over-redacted).
// - uuid: any 8-4-4-4-12 hex (v1..v5 + non-canonical).
// - truncation: grapheme-aware (R-M1: count GRAPHEMES, not UTF-16 code
//   units — single emoji is `.length === 2` and was breaking the 120-grapheme
//   contract).
const SANITIZE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
// R-M2 (phase-4): two alternatives, both require at least one separator so
// pure 10-digit digit-runs (epoch timestamps, Stripe id substrings) do not
// match. (a) international: `+CC <2-3 digit><sep><3><sep><3-4>` covers
// Polish +48 501 222 333 and similar. (b) US-style: `(NNN) NNN-NNNN` or
// `NNN-NNN-NNNN` with mandatory separators.
const SANITIZE_PHONE =
  /\+\d{1,3}[\s.-]\d{2,3}[\s.-]\d{3}[\s.-]\d{3,4}\b|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g
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

// P8 + R-M1: grapheme-aware truncation. Prefer Intl.Segmenter; fall back to
// Array.from which iterates by code point (no surrogate pair splits).
//
// R-M1 (phase-4): the previous implementation accounted `segment.length`
// (UTF-16 code units) against `limit` — a single emoji has `.length === 2`,
// ZWJ sequences are 4+, so the limit functionally degenerated to
// `.slice(0, 120)` and the "120 graphemes" promise was broken. We now count
// GRAPHEMES (one increment per segment) and concatenate the segment string.
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
    let out = ""
    let count = 0
    for (const { segment } of segmenter.segment(input)) {
      if (++count > limit) break
      out += segment
    }
    return out
  }
  // Fallback: code-point slice (no surrogate splits but does not collapse ZWJ).
  return Array.from(input).slice(0, limit).join("")
}

/**
 * R-M4 (phase-4): caller-aware distinct_id construction. Empty / missing
 * `entitlement_instance_id` would otherwise collapse every event into the
 * single PostHog person `actor:P4:`. Strategy:
 * - `pass_generated`: return null → caller skips emit (no signal lost; in
 *   practice this branch is unreachable because upstream validation rejects
 *   empty ids, but we defend it).
 * - `pass_failed` / `pass_gated`: return `actor:P4:anon-<uuid>` so each
 *   failure stays addressable in the funnel without merging.
 */
function buildWalletDistinctId(
  counter: WalletCounter,
  entitlement_instance_id: unknown
): string | null {
  const id = String(entitlement_instance_id ?? "")
  if (id.length > 0) return `actor:P4:${id}`
  if (counter === "pass_generated") return null
  // Synthesise an anon suffix so failure/gate counts are not merged into one
  // person. Prefer crypto.randomUUID when available, otherwise a timestamp+
  // random fallback (still distinct per call).
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto
  const suffix =
    typeof cryptoRef?.randomUUID === "function"
      ? cryptoRef.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `actor:P4:anon-${suffix}`
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
