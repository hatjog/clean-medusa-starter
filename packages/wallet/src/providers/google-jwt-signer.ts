import { createSign } from "node:crypto"

import type { GoogleWalletProviderConfig } from "./google-config"
import type { GoogleOfferObject } from "./google-offer-class-mapper"

export interface GoogleWalletJWTClaims {
  iss: string
  aud: "google"
  typ: "savetowallet"
  iat: number
  origins?: string[]
  payload: {
    offerObjects: GoogleOfferObject[]
  }
}

export interface SignSaveJWTOptions {
  now?: () => Date
  origins?: string[]
}

export class GoogleWalletSigningError extends Error {
  readonly error_code = "GOOGLE_WALLET_SIGNING_FAILED"

  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = "GoogleWalletSigningError"
  }
}

// M3: signer przyjmuje już-zresolvowany config (provider robi resolve raz w
// konstruktorze) — eliminuje powtórzoną walidację konfiguracji per request.
// L3: payload.offerClasses zostało usunięte z JWT — OfferClass leci wyłącznie
// HTTP-em (upsertOfferClass z idempotency 409→success), jeden kanał mutacji.
export function signSaveJWT(
  offerObject: GoogleOfferObject,
  config: GoogleWalletProviderConfig,
  options: SignSaveJWTOptions = {}
): string {
  const issuedAt = Math.floor((options.now?.() ?? new Date()).getTime() / 1_000)
  const claims: GoogleWalletJWTClaims = {
    iss: config.service_account_email,
    aud: "google",
    typ: "savetowallet",
    iat: issuedAt,
    origins: options.origins,
    payload: {
      offerObjects: [offerObject],
    },
  }

  try {
    // L1: jeden punkt serializacji unsigned segmentu — header i claims używają
    // identycznej ścieżki encodingu (no drift między tym co kodujemy a tym co
    // podpisujemy).
    const encodedHeader = serializeUnsignedSegment({ alg: "RS256", typ: "JWT" })
    const encodedClaims = serializeUnsignedSegment(claims)
    const signer = createSign("RSA-SHA256")
    signer.update(`${encodedHeader}.${encodedClaims}`)
    signer.end()
    const signature = signer.sign(config.private_key).toString("base64url")

    return [encodedHeader, encodedClaims, signature].join(".")
  } catch (error) {
    throw new GoogleWalletSigningError(
      "Google Wallet save JWT could not be signed with RS256",
      error
    )
  }
}

function serializeUnsignedSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(removeUndefined(value))).toString(
    "base64url"
  )
}

function removeUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUndefined)
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, removeUndefined(entry)])
    )
  }

  return value
}
