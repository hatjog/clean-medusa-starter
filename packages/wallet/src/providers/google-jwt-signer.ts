import { createSign } from "node:crypto"

import type { walletobjects_v1 } from "googleapis"

import type { GoogleWalletProviderConfig } from "./google-config"
import { resolveGoogleWalletProviderConfig } from "./google-config"
import type { GoogleOfferObject } from "./google-offer-class-mapper"

export interface GoogleWalletJWTClaims {
  iss: string
  aud: "google"
  typ: "savetowallet"
  iat: number
  origins?: string[]
  payload: {
    offerObjects: GoogleOfferObject[]
    offerClasses?: walletobjects_v1.Schema$OfferClass[]
  }
}

export interface SignSaveJWTOptions {
  offerClass?: walletobjects_v1.Schema$OfferClass
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

export function signSaveJWT(
  offerObject: GoogleOfferObject,
  configInput: Partial<GoogleWalletProviderConfig>,
  options: SignSaveJWTOptions = {}
): string {
  const config = resolveGoogleWalletProviderConfig(configInput)
  const issuedAt = Math.floor((options.now?.() ?? new Date()).getTime() / 1_000)
  const claims: GoogleWalletJWTClaims = {
    iss: config.service_account_email,
    aud: "google",
    typ: "savetowallet",
    iat: issuedAt,
    origins: options.origins,
    payload: {
      offerObjects: [offerObject],
      offerClasses: options.offerClass ? [options.offerClass] : undefined,
    },
  }

  try {
    return [
      base64UrlEncode({ alg: "RS256", typ: "JWT" }),
      base64UrlEncode(removeUndefined(claims)),
      signPayload(claims, config.private_key),
    ].join(".")
  } catch (error) {
    throw new GoogleWalletSigningError(
      "Google Wallet save JWT could not be signed with RS256",
      error
    )
  }
}

function signPayload(claims: GoogleWalletJWTClaims, privateKey: string): string {
  const encodedHeader = base64UrlEncode({ alg: "RS256", typ: "JWT" })
  const encodedClaims = base64UrlEncode(removeUndefined(claims))
  const signer = createSign("RSA-SHA256")
  signer.update(`${encodedHeader}.${encodedClaims}`)
  signer.end()

  return signer.sign(privateKey).toString("base64url")
}

function base64UrlEncode(value: unknown): string {
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
