import type {
  PostHogCaptureClient,
  SentryCaptureClient,
  WalletCounter,
  WalletCounterProps,
} from "./types"

let posthogClient: PostHogCaptureClient | null = null
let sentryClient: SentryCaptureClient | null = null

export function setWalletPostHogClient(
  client: PostHogCaptureClient | null
): void {
  posthogClient = client
}

export function setWalletSentryClient(client: SentryCaptureClient | null): void {
  sentryClient = client
}

export function emitWalletCounter(
  counter: WalletCounter,
  props: WalletCounterProps
): void {
  try {
    const client = posthogClient ?? createPostHogClientFromEnv()
    if (!client) return

    client.capture({
      distinctId: `actor:P4:${props.entitlement_instance_id}`,
      event: `wallet.${counter}`,
      properties: {
        ...props,
        error_message:
          "error_message" in props
            ? sanitizeWalletErrorMessage(props.error_message)
            : undefined,
      },
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
  const apiKey = process.env.POSTHOG_API_KEY
  if (!apiKey) return null

  try {
    // Optional runtime dependency from the backend workspace; keeping it lazy
    // prevents tests and package consumers from needing PostHog configured.
    const { PostHog } = require("posthog-node") as {
      PostHog: new (
        key: string,
        options?: { host?: string }
      ) => PostHogCaptureClient
    }
    posthogClient = new PostHog(apiKey, {
      host: process.env.POSTHOG_HOST,
    })
    return posthogClient
  } catch (err) {
    sentryClient?.captureMessage("posthog_emit_failed", {
      extra: { counter: "init", err },
    })
    return null
  }
}
