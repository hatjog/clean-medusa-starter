import { createVerify, generateKeyPairSync } from "node:crypto"

import {
  GoogleWalletSigningError,
  signSaveJWT,
} from "../google-jwt-signer"
import {
  GoogleWalletConfigMissingError,
  resolveGoogleWalletProviderConfig,
  type GoogleWalletProviderConfig,
} from "../google-config"
import type { GoogleOfferObject } from "../google-offer-class-mapper"

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
})

const privateKeyPem = privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string

const config: GoogleWalletProviderConfig = {
  issuer_id: "3388000000022223333",
  service_account_email: "wallet-demo@example.iam.gserviceaccount.com",
  private_key: privateKeyPem,
  class_id_template: "{issuer_id}.bonbeauty_voucher_v1",
  origin_save_base: "https://pay.google.com/gp/v/save/",
}

const offerObject: GoogleOfferObject = {
  id: "3388000000022223333.bonbeauty_voucher_v1.ei_123",
  classId: "3388000000022223333.bonbeauty_voucher_v1",
  state: "ACTIVE",
  redemptionCode: "BB-2026-0001",
  barcode: { type: "QR_CODE", value: "QR-BB-2026-0001" },
}

describe("signSaveJWT", () => {
  it("podpisuje JWT RS256 z claimami Google Wallet save link (L3: bez offerClasses w payload)", () => {
    const token = signSaveJWT(offerObject, config, {
      now: () => new Date("2026-05-27T10:00:00.000Z"),
    })
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".")

    expect(decodeJwtPart(encodedHeader)).toEqual({
      alg: "RS256",
      typ: "JWT",
    })
    const decodedPayload = decodeJwtPart(encodedPayload)
    expect(decodedPayload).toMatchObject({
      iss: "wallet-demo@example.iam.gserviceaccount.com",
      aud: "google",
      typ: "savetowallet",
      iat: 1779876000,
      payload: {
        offerObjects: [
          {
            id: "3388000000022223333.bonbeauty_voucher_v1.ei_123",
            classId: "3388000000022223333.bonbeauty_voucher_v1",
            redemptionCode: "BB-2026-0001",
          },
        ],
      },
    })
    // L3: OfferClass leci wyłącznie HTTP-em — JWT payload nie zawiera offerClasses.
    expect(
      (decodedPayload.payload as Record<string, unknown>).offerClasses
    ).toBeUndefined()

    const verifier = createVerify("RSA-SHA256")
    verifier.update(`${encodedHeader}.${encodedPayload}`)
    verifier.end()
    expect(
      verifier.verify(publicKey, Buffer.from(encodedSignature, "base64url"))
    ).toBe(true)
  })

  it("rzuca typed signing error gdy podpis nie może być wykonany (np. niepoprawny PEM po bypass)", () => {
    expect(() =>
      signSaveJWT(offerObject, {
        ...config,
        private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----",
      })
    ).toThrow(
      expect.objectContaining({
        name: "GoogleWalletSigningError",
        error_code: "GOOGLE_WALLET_SIGNING_FAILED",
      } satisfies Partial<GoogleWalletSigningError>)
    )
  })

  it("L5: resolveGoogleWalletProviderConfig fail-fast gdy private_key nie zawiera PEM headera", () => {
    expect(() =>
      resolveGoogleWalletProviderConfig({
        issuer_id: "3388000000022223333",
        service_account_email: "wallet-demo@example.iam.gserviceaccount.com",
        private_key: "not-a-pem-key",
        class_id_template: "{issuer_id}.bonbeauty_voucher_v1",
      })
    ).toThrow(
      expect.objectContaining({
        name: "GoogleWalletConfigMissingError",
        error_code: "GOOGLE_WALLET_CONFIG_MISSING",
      } satisfies Partial<GoogleWalletConfigMissingError>)
    )
  })
})

function decodeJwtPart(part: string | undefined): Record<string, unknown> {
  if (!part) throw new Error("JWT part is missing")
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >
}
