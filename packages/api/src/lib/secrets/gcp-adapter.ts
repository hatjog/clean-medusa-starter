import { SecretManagerServiceClient } from "@google-cloud/secret-manager"
import {
  SecretsAdapter,
  SecretNotConfiguredError,
  MarketId,
  SecretType,
} from "./index"

/**
 * AC4 — GCP Secret Manager adapter. CODE-COMPLETE for v1.8.0 but NOT activated
 * at runtime: SECRETS_ADAPTER=env is the v1.8.0 default and no runbook/env
 * sets `gcp`. Activation is v1.10.0+ production deploy debt (D9, F16).
 *
 * AC5 — Import isolation: this module imports @google-cloud/secret-manager
 * (a devDependency, NOT a runtime dependency). It MUST only ever be reached
 * via the dynamic `import()` inside the loader's `gcp` branch so the SDK
 * never enters the env-runtime module graph. It is intentionally NOT
 * re-exported from the secrets barrel (index.ts).
 */

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes per AC4

type SecretIdParts = { market: MarketId; type: SecretType }

interface CacheEntry {
  value: string
  expiresAt: number
}

/**
 * Maps (market, type) to a GCP Secret Manager secret id. Mirrors the env
 * adapter's logical key so operators have a 1:1 mental model:
 *   STRIPE_SECRET_KEY_BONBEAUTY  ↔  stripe-secret-key-bonbeauty
 */
function secretIdFor({ market, type }: SecretIdParts): string {
  const typeSegment: Record<SecretType, string> = {
    secret: "stripe-secret-key",
    publishable: "stripe-publishable-key",
    webhook: "stripe-webhook-key",
  }
  return `${typeSegment[type]}-${market.toLowerCase()}`
}

function cacheKey(market: MarketId, type: SecretType): string {
  return `${market}:${type}`
}

export class GcpSecretsAdapter implements SecretsAdapter {
  private readonly client: SecretManagerServiceClient
  private readonly projectId: string
  private readonly cache = new Map<string, CacheEntry>()

  constructor(client?: SecretManagerServiceClient) {
    // GOOGLE_CLOUD_PROJECT / GCP_PROJECT_ID are the standard ADC project envs.
    const projectId =
      process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT
    if (!projectId) {
      // Fail-fast: a gcp adapter with no project is unusable. Names only the
      // missing key, never echoes any env value (same policy as env-adapter).
      throw new SecretNotConfiguredError("GCP_PROJECT_ID")
    }
    this.projectId = projectId
    this.client = client ?? new SecretManagerServiceClient()
  }

  async getStripeKey(market: MarketId, type: SecretType): Promise<string> {
    const key = cacheKey(market, type)
    const now = Date.now()

    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > now) {
      return cached.value
    }

    const secretId = secretIdFor({ market, type })
    const name = `projects/${this.projectId}/secrets/${secretId}/versions/latest`

    let payload: string | undefined
    try {
      const [response] = await this.client.accessSecretVersion({ name })
      const data = response.payload?.data
      payload =
        typeof data === "string" ? data : data ? Buffer.from(data).toString("utf8") : undefined
    } catch (err) {
      // Do not leak the underlying GCP error detail (may contain the resource
      // path / project). Fail-fast with the stable contract error.
      throw new SecretNotConfiguredError(secretId)
    }

    if (!payload) {
      throw new SecretNotConfiguredError(secretId)
    }

    this.cache.set(key, { value: payload, expiresAt: now + CACHE_TTL_MS })
    return payload
  }
}
