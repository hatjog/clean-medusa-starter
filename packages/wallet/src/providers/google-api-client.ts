import { google, type walletobjects_v1 } from "googleapis"

import type { GoogleWalletProviderConfig } from "./google-config"

export const GOOGLE_WALLET_OBJECTS_SCOPE =
  "https://www.googleapis.com/auth/wallet_object.issuer"

export interface GoogleWalletApiSurface {
  offerclass: {
    insert(
      params: { requestBody?: walletobjects_v1.Schema$OfferClass },
      options?: GoogleWalletRequestOptions
    ): Promise<unknown>
  }
  offerobject: {
    patch(
      params: {
        resourceId?: string
        requestBody?: walletobjects_v1.Schema$OfferObject
      },
      options?: GoogleWalletRequestOptions
    ): Promise<unknown>
  }
}

export interface GoogleWalletRequestOptions {
  timeout?: number
  signal?: AbortSignal
}

export interface GoogleWalletApiClientOptions {
  walletobjects?: GoogleWalletApiSurface
  retry_delay_ms?: number
  delay?: (ms: number) => Promise<void>
}

export class GoogleWalletApiError extends Error {
  constructor(
    readonly error_code: "GOOGLE_WALLET_API_ERROR" | "GOOGLE_WALLET_RATE_LIMITED",
    message: string,
    readonly status?: number,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = "GoogleWalletApiError"
  }
}

export class GoogleWalletApiClient {
  private readonly config: GoogleWalletProviderConfig
  private readonly retry_delay_ms: number
  private readonly delay: (ms: number) => Promise<void>
  private walletobjects?: GoogleWalletApiSurface
  private readonly upserted_class_ids = new Set<string>()

  // M3: konstruktor przyjmuje już-zresolvowany config (provider robi resolve raz
  // i przekazuje wynik) — eliminuje powtórzoną walidację per request.
  constructor(
    config: GoogleWalletProviderConfig,
    options: GoogleWalletApiClientOptions = {}
  ) {
    this.config = config
    this.walletobjects = options.walletobjects
    this.retry_delay_ms = options.retry_delay_ms ?? 250
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async upsertOfferClass(offerClass: walletobjects_v1.Schema$OfferClass): Promise<void> {
    if (!offerClass.id) {
      throw new GoogleWalletApiError(
        "GOOGLE_WALLET_API_ERROR",
        "OfferClass id is required before upsert"
      )
    }

    if (this.upserted_class_ids.has(offerClass.id)) return

    await this.runWithRetry(async () => {
      try {
        await this.getWalletObjects().offerclass.insert(
          { requestBody: offerClass },
          this.createRequestOptions()
        )
      } catch (error) {
        if (statusOf(error) === 409) return
        throw error
      }
    })

    this.upserted_class_ids.add(offerClass.id)
  }

  async patchOfferObject(
    objectId: string,
    patch: walletobjects_v1.Schema$OfferObject
  ): Promise<void> {
    await this.runWithRetry(async () => {
      try {
        await this.getWalletObjects().offerobject.patch(
          {
            resourceId: objectId,
            requestBody: patch,
          },
          this.createRequestOptions()
        )
      } catch (error) {
        if (statusOf(error) === 404) return
        throw error
      }
    })
  }

  private getWalletObjects(): GoogleWalletApiSurface {
    if (this.walletobjects) return this.walletobjects

    const auth = new google.auth.JWT({
      email: this.config.service_account_email,
      key: this.config.private_key,
      scopes: [GOOGLE_WALLET_OBJECTS_SCOPE],
    })

    this.walletobjects = google.walletobjects({
      version: "v1",
      auth,
    }) as unknown as GoogleWalletApiSurface

    return this.walletobjects
  }

  private createRequestOptions(): GoogleWalletRequestOptions {
    return {
      timeout: this.config.request_timeout_ms,
      signal:
        typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
          ? AbortSignal.timeout(this.config.request_timeout_ms ?? 2_000)
          : undefined,
    }
  }

  private async runWithRetry(operation: () => Promise<void>): Promise<void> {
    try {
      await operation()
    } catch (firstError) {
      const firstStatus = statusOf(firstError)
      if (!isRetryableStatus(firstStatus)) {
        throw this.toApiError(firstError)
      }

      await this.delay(this.retry_delay_ms)

      try {
        await operation()
      } catch (secondError) {
        throw this.toApiError(secondError)
      }
    }
  }

  private toApiError(error: unknown): GoogleWalletApiError {
    const status = statusOf(error)
    const rateLimited = status === 429

    return new GoogleWalletApiError(
      rateLimited ? "GOOGLE_WALLET_RATE_LIMITED" : "GOOGLE_WALLET_API_ERROR",
      rateLimited
        ? "Google Wallet API rate limit was not recovered by retry"
        : "Google Wallet API request failed",
      status,
      error
    )
  }
}

export function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const candidate = error as {
    code?: unknown
    status?: unknown
    response?: { status?: unknown }
  }
  const status = candidate.response?.status ?? candidate.status ?? candidate.code
  return typeof status === "number" ? status : undefined
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500)
}
