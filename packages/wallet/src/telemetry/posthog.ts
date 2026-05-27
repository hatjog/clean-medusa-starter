import type {
  PostHogCaptureClient,
  SentryCaptureClient,
  WalletCounter,
  WalletCounterProps,
} from "./types"

let posthogClient: PostHogCaptureClient | null = null
let sentryClient: SentryCaptureClient | null = null
let envInitAttempted = false

export function setWalletPostHogClient(
  client: PostHogCaptureClient | null
): void {
  posthogClient = client
  // Reset env init guard so subsequent emits do not silently revive a
  // process-wide singleton after test cleanup. (F12)
  envInitAttempted = client !== null
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
  }
}

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

    const properties: Record<string, unknown> = { ...rest }
    if (typeof error_message === "string") {
      properties.error_message = sanitizeWalletErrorMessage(error_message)
    }
    if (typeof gate_reason === "string") {
      properties.gate_reason = gate_reason
    }

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

export function sanitizeWalletErrorMessage(message: unknown): string {
  const input = String(message ?? "unknown_error")
  return input
    .replace(/[\w.-]+@[\w.-]+/g, "<redacted_email>")
    .replace(/\+?\d[\d\s-]{7,}/g, "<redacted_phone>")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "<entitlement_id>"
    )
    .slice(0, 120)
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
