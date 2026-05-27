import { createVerify, generateKeyPairSync } from "node:crypto"

import {
  GoogleWalletSigningError,
  signSaveJWT,
} from "../google-jwt-signer"
import type { GoogleWalletProviderConfig } from "../google-config"
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
  localizedTitle: {
    defaultValue: { language: "pl-PL", value: "Voucher spa" },
    translatedValues: [
      { language: "pl-PL", value: "Voucher spa" },
      { language: "en-US", value: "Spa voucher" },
      { language: "uk-UA", value: "Спа ваучер" },
      { language: "de-DE", value: "Spa Gutschein" },
    ],
  },
  provider: "BonBeauty",
  merchantLocations: [{ address: "ul. Testowa 1, Warszawa" }],
  hexBackgroundColor: "#F5E6D3",
  barcode: { type: "QR_CODE", value: "QR-BB-2026-0001" },
}

describe("signSaveJWT", () => {
  it("podpisuje JWT RS256 z claimami Google Wallet save link", () => {
    const token = signSaveJWT(offerObject, config, {
      offerClass: {
        id: "3388000000022223333.bonbeauty_voucher_v1",
        issuerName: "Grow Platform",
        provider: "BonBeauty",
        title: "Voucher spa",
        reviewStatus: "UNDER_REVIEW",
        redemptionChannel: "BOTH",
      },
      now: () => new Date("2026-05-27T10:00:00.000Z"),
    })
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".")

    expect(decodeJwtPart(encodedHeader)).toEqual({
      alg: "RS256",
      typ: "JWT",
    })
    expect(decodeJwtPart(encodedPayload)).toMatchObject({
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
        offerClasses: [
          {
            id: "3388000000022223333.bonbeauty_voucher_v1",
          },
        ],
      },
    })

    const verifier = createVerify("RSA-SHA256")
    verifier.update(`${encodedHeader}.${encodedPayload}`)
    verifier.end()
    expect(
      verifier.verify(publicKey, Buffer.from(encodedSignature, "base64url"))
    ).toBe(true)
  })

  it("rzuca typed signing error dla malformed private key", () => {
    expect(() =>
      signSaveJWT(offerObject, {
        ...config,
        private_key: "not-a-pem-key",
      })
    ).toThrow(
      expect.objectContaining({
        name: "GoogleWalletSigningError",
        error_code: "GOOGLE_WALLET_SIGNING_FAILED",
      } satisfies Partial<GoogleWalletSigningError>)
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
