import {
  GOOGLE_WALLET_DEFAULT_BACKGROUND,
  GoogleWalletPayloadError,
  buildGoogleOfferClass,
  buildOfferClassPayload,
  type GoogleWalletMarketBranding,
  type GoogleWalletPayloadFields,
} from "../google-offer-class-mapper"
import type { WalletPayload } from "../../payload"

const now = new Date("2026-05-27T10:00:00.000Z")

const payload: WalletPayload & GoogleWalletPayloadFields = {
  entitlement_instance_id: "ei_123",
  code: "BB-2026-0001",
  title: "Voucher spa",
  status: "ACTIVE",
  expires_at: "2026-12-31T23:59:59.000Z",
  deep_link: "https://bonbeauty.example/pl/vouchers/BB-2026-0001",
  barcode_spec: { format: "QR", value: "QR-BB-2026-0001" },
  qr_code: "QR-BB-2026-0001",
  branding: {
    logo_url: "https://assets.example/brand-logo.png",
    primary_color: "#111827",
    accent_color: "#C9A227",
  },
  locale: "pl-PL",
  salon_name: "BonBeauty Mokotow",
  salon_address: "ul. Testowa 1, Warszawa",
  latitude: 52.2297,
  longitude: 21.0122,
}

const branding: GoogleWalletMarketBranding = {
  class_id: "3388000000022223333.bonbeauty_voucher_v1",
  object_id: "3388000000022223333.bonbeauty_voucher_v1.ei_123",
  issuer_name: "Grow Platform",
  background: "#F5E6D3",
  logo: "https://assets.example/wallet-logo.png",
  localized_titles: {
    "pl-PL": "Voucher spa",
    "en-US": "Spa voucher",
    "uk-UA": "Спа ваучер",
    "de-DE": "Spa Gutschein",
  },
  now: () => now,
}

describe("Google Wallet OfferClass mapper", () => {
  it("mapuje WalletPayload na OfferObject z kodem, terminem, lokalizacja i brandingiem", () => {
    const offerObject = buildOfferClassPayload(payload, "pl-PL", branding)

    expect(offerObject).toMatchObject({
      id: "3388000000022223333.bonbeauty_voucher_v1.ei_123",
      classId: "3388000000022223333.bonbeauty_voucher_v1",
      state: "ACTIVE",
      redemptionCode: "BB-2026-0001",
      smartTapRedemptionValue: "BB-2026-0001",
      validTimeInterval: {
        start: { date: "2026-05-27T10:00:00.000Z" },
        end: { date: "2026-12-31T23:59:59.000Z" },
      },
      provider: "BonBeauty Mokotow",
      hexBackgroundColor: "#F5E6D3",
      barcode: {
        type: "QR_CODE",
        value: "QR-BB-2026-0001",
      },
      linksModuleData: {
        uris: [
          {
            id: "voucher_deep_link",
            uri: "https://bonbeauty.example/pl/vouchers/BB-2026-0001",
          },
        ],
      },
      merchantLocations: [
        {
          address: "ul. Testowa 1, Warszawa",
          latitude: 52.2297,
          longitude: 21.0122,
        },
      ],
    })
  })

  it("ustawia OfferClass z localizedTitle dla czterech kanonicznych locale", () => {
    const offerClass = buildGoogleOfferClass(payload, "pl-PL", branding)

    expect(offerClass).toMatchObject({
      id: "3388000000022223333.bonbeauty_voucher_v1",
      issuerName: "Grow Platform",
      provider: "BonBeauty Mokotow",
      reviewStatus: "UNDER_REVIEW",
      redemptionChannel: "BOTH",
      titleImage: {
        sourceUri: { uri: "https://assets.example/wallet-logo.png" },
      },
    })
    expect(offerClass.localizedTitle?.translatedValues).toEqual([
      { language: "pl-PL", value: "Voucher spa" },
      { language: "en-US", value: "Spa voucher" },
      { language: "uk-UA", value: "Спа ваучер" },
      { language: "de-DE", value: "Spa Gutschein" },
    ])
  })

  it("uzywa warm cream fallback i pomija logo, gdy market nie ma wallet branding", () => {
    const offerObject = buildOfferClassPayload(
      {
        ...payload,
        branding: { ...payload.branding, logo_url: "" },
      },
      "en-US",
      {
        class_id: branding.class_id,
        object_id: branding.object_id,
        issuer_name: branding.issuer_name,
        salon_name: "BonBeauty",
        salon_address: "Warszawa",
        now: () => now,
      }
    )

    expect(offerObject.hexBackgroundColor).toBe(GOOGLE_WALLET_DEFAULT_BACKGROUND)
    expect(offerObject.logo).toBeUndefined()
  })

  it("nie serializuje PII odbiorcy nawet gdy read model dostarczy nadmiarowe pola", () => {
    const payloadWithPii = {
      ...payload,
      recipient_email: "recipient@example.test",
      recipient_phone: "+48123123123",
      recipient_name: "Jan Kowalski",
      recipient_address: "ul. Prywatna 99",
    } as unknown as WalletPayload &
      GoogleWalletPayloadFields &
      Record<string, unknown>

    const serialized = JSON.stringify(
      buildOfferClassPayload(payloadWithPii, "pl-PL", branding)
    )

    expect(serialized).not.toContain("recipient@example.test")
    expect(serialized).not.toContain("+48123123123")
    expect(serialized).not.toContain("Jan Kowalski")
    expect(serialized).not.toContain("ul. Prywatna 99")
  })

  it("odrzuca probe wstrzykniecia PII przez branding map", () => {
    expect(() =>
      buildOfferClassPayload(payload, "pl-PL", {
        ...branding,
        recipient_email: "recipient@example.test",
      })
    ).toThrow(
      expect.objectContaining({
        name: "GoogleWalletPayloadError",
        error_code: "GOOGLE_WALLET_PII_FORBIDDEN",
      } satisfies Partial<GoogleWalletPayloadError>)
    )
  })

  it("fail-closed, gdy payload nie ma salon_name albo salon_address", () => {
    const payloadWithoutSalon = {
      ...payload,
      salon_name: undefined,
      salon_address: undefined,
    }

    expect(() =>
      buildOfferClassPayload(payloadWithoutSalon, "pl-PL", {
        class_id: branding.class_id,
        object_id: branding.object_id,
        issuer_name: branding.issuer_name,
      })
    ).toThrow(
      expect.objectContaining({
        name: "GoogleWalletPayloadError",
        error_code: "GOOGLE_WALLET_SALON_NAME_MISSING",
      } satisfies Partial<GoogleWalletPayloadError>)
    )
  })
})
