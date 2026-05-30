import {
  GoogleWalletProvider,
  loadGoogleWalletProviderConfigFromEnv,
  type WalletPayload,
} from "../.."

const describeLive =
  process.env.GOOGLE_WALLET_LIVE === "1" ? describe : describe.skip

describeLive("GoogleWalletProvider live Demo Issuer smoke", () => {
  it("generuje realny save_url z parsowalnym JWT", async () => {
    const provider = new GoogleWalletProvider(loadGoogleWalletProviderConfigFromEnv())
    const payload: WalletPayload & {
      salon_name: string
      salon_address: string
    } = {
      entitlement_instance_id: `ei_live_${Date.now()}`,
      code: "BB-LIVE-0001",
      title: "Voucher testowy BonBeauty",
      status: "ACTIVE",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      deep_link: "https://bonbeauty.example/pl/vouchers/BB-LIVE-0001",
      barcode_spec: { format: "QR", value: "BB-LIVE-0001" },
      qr_code: "BB-LIVE-0001",
      branding: {
        logo_url: "",
        primary_color: "#F5E6D3",
        accent_color: "#C9A227",
      },
      locale: "pl-PL",
      salon_name: "BonBeauty",
      salon_address: "Warszawa",
    }

    const result = await provider.issueSaveUrl(payload, "pl-PL")
    const jwt = result.save_url.replace("https://pay.google.com/gp/v/save/", "")

    expect(result.save_url).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//)
    expect(jwt.split(".")).toHaveLength(3)
  })
})
