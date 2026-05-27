import crypto from "node:crypto"

import JSZip from "jszip"

import {
  DefaultWalletPassFacade,
  UnsupportedWalletProviderError,
  WalletPassGenerationError,
  type WalletPassProvider,
  type WalletPayload,
  type WalletPayloadBuilder,
} from "../.."
import { createWalletProviderRegistry } from "../../registry"
import {
  AppleWalletProvider,
  createStubSigningContext,
} from "../apple"

const signingContext = createStubSigningContext()

const payload: WalletPayload = {
  entitlement_instance_id: "ei_apple_123",
  code: "TESTCODE1",
  title: "Test voucher PL",
  status: "ACTIVE",
  expires_at: "2027-01-01T00:00:00.000Z",
  deep_link: "https://gp.example/voucher/TESTCODE1",
  barcode_spec: { format: "QR", value: "TESTCODE1" },
  qr_code: "TESTCODE1",
  branding: {
    logo_url: "https://stub.example/logo.png",
    primary_color: "#0077FF",
    accent_color: "#FFFFFF",
  },
  locale: "pl-PL",
}

describe("AppleWalletProvider", () => {
  it("generuje data URL z poprawną strukturą .pkpass", async () => {
    const provider = createAppleProvider()

    const result = await provider.issueSaveUrl(payload, "pl-PL")
    const zip = await unzipPkpass(result.save_url)
    const passJson = await readJson(zip, "pass.json")
    const manifest = await readJson(zip, "manifest.json")

    expect(passJson).toMatchObject({
      formatVersion: 1,
      passTypeIdentifier: "pass.com.gp.stub",
      serialNumber: "ei_apple_123",
      teamIdentifier: "STUBTEAMID1",
      organizationName: "Grow Platform",
      description: "Test voucher PL",
      storeCard: expect.any(Object),
    })
    expect(await hasNonEmptyFile(zip, "signature")).toBe(true)
    expect(await hasNonEmptyFile(zip, "icon.png")).toBe(true)
    expect(await hasNonEmptyFile(zip, "logo.png")).toBe(true)
    expect(zip.file("pl.lproj/pass.strings")).not.toBeNull()
    expect(zip.file("en.lproj/pass.strings")).not.toBeNull()
    expect(zip.file("uk.lproj/pass.strings")).not.toBeNull()
    expect(zip.file("de.lproj/pass.strings")).not.toBeNull()
    await expectManifestHashesToMatch(zip, manifest)
  })

  it("normalizuje locale poza kanoniczną czwórką do pl-PL w polu pomocniczym", async () => {
    const provider = createAppleProvider()

    const result = await provider.issueSaveUrl(payload, "fr-FR" as never)
    const zip = await unzipPkpass(result.save_url)
    const passJson = await readJson(zip, "pass.json")

    expect(passJson.storeCard.auxiliaryFields).toContainEqual({
      key: "locale",
      label: "Locale",
      value: "pl-PL",
    })
  })

  it.each([
    ["REVOKED" as const, true, "2027-01-01T00:00:00.000Z"],
    ["REFUNDED" as const, true, "2027-01-01T00:00:00.000Z"],
    ["EXPIRED" as const, false, "1970-01-01T00:00:00.000Z"],
  ])("odzwierciedla status %s w pass.json", async (status, voided, expirationDate) => {
    const provider = createAppleProvider()
    const result = await provider.issueSaveUrl({ ...payload, status }, "pl-PL")
    const zip = await unzipPkpass(result.save_url)
    const passJson = await readJson(zip, "pass.json")

    expect(passJson.voided).toBe(voided)
    expect(passJson.expirationDate).toBe(expirationDate)
  })

  it("zwraca audytowalny noop dla invalidate", async () => {
    const provider = createAppleProvider()

    const result = await provider.invalidate("ei_apple_123", "revoked")

    expect(result.audit_event).toMatchObject({
      event_type: "wallet.pass_invalidated",
      entitlement_instance_id: "ei_apple_123",
      provider: "apple",
      reason: "revoked",
      outcome: "success",
    })
  })

  it("dostarcza audit envelope sukcesu przez WalletPassFacade", async () => {
    const facade = new DefaultWalletPassFacade(
      { apple: createAppleProvider() },
      createBuilder(),
      { now: () => new Date("2026-05-27T10:00:00.000Z") }
    )

    const result = await facade.generatePass("ei_apple_123", "apple", "pl-PL")

    expect(result.audit_event).toMatchObject({
      event_type: "wallet.pass_generated",
      entitlement_instance_id: "ei_apple_123",
      provider: "apple",
      save_url: expect.stringMatching(
        /^data:application\/vnd\.apple\.pkpass;base64,/
      ),
      timestamp: "2026-05-27T10:00:00.000Z",
      outcome: "success",
      requested_locale: "pl-PL",
      effective_locale: "pl-PL",
    })
  })

  it("dostarcza audit envelope błędu przez WalletPassFacade", async () => {
    const provider = new AppleWalletProvider({
      signingContextFactory: () => {
        throw new Error("stub signing unavailable")
      },
    })
    const facade = new DefaultWalletPassFacade(
      { apple: provider },
      createBuilder(),
      { now: () => new Date("2026-05-27T10:00:00.000Z") }
    )

    await expect(
      facade.generatePass("ei_apple_123", "apple", "pl-PL")
    ).rejects.toMatchObject({
      name: "WalletPassGenerationError",
      audit_event: {
        event_type: "wallet.pass_failed",
        entitlement_instance_id: "ei_apple_123",
        provider: "apple",
        timestamp: "2026-05-27T10:00:00.000Z",
        outcome: "failure",
        error_code: "Error",
        error_message: "stub signing unavailable",
      },
    } satisfies Partial<WalletPassGenerationError>)
  })
})

describe("createWalletProviderRegistry", () => {
  it("nie rejestruje Apple, gdy WALLET_APPLE_ENABLED nie jest true", () => {
    const google = createGoogleProvider()

    const registry = createWalletProviderRegistry(
      { WALLET_APPLE_ENABLED: "false" },
      { google }
    )

    expect(registry.google).toBe(google)
    expect(registry.apple).toBeUndefined()
  })

  it("rejestruje Apple tylko po jawnej fladze true", () => {
    const registry = createWalletProviderRegistry({
      WALLET_APPLE_ENABLED: "true",
    })

    expect(registry.apple).toBeInstanceOf(AppleWalletProvider)
  })

  it("flag-off powoduje PROVIDER_NOT_REGISTERED w facade", async () => {
    const facade = new DefaultWalletPassFacade(
      createWalletProviderRegistry({ WALLET_APPLE_ENABLED: "false" }, {
        google: createGoogleProvider(),
      }),
      createBuilder(),
      { now: () => new Date("2026-05-27T10:00:00.000Z") }
    )

    await expect(
      facade.generatePass("ei_apple_123", "apple", "pl-PL")
    ).rejects.toMatchObject({
      name: "UnsupportedWalletProviderError",
      audit_event: {
        event_type: "wallet.pass_failed",
        provider: "apple",
        error_code: "PROVIDER_NOT_REGISTERED",
      },
    })
  })
})

function createAppleProvider(): AppleWalletProvider {
  return new AppleWalletProvider({
    signingContextFactory: () => signingContext,
  })
}

function createGoogleProvider(): WalletPassProvider {
  return {
    issueSaveUrl: async () => ({
      save_url: "https://pay.google.com/gp/v/save/stub",
    }),
    invalidate: async () => undefined,
  }
}

function createBuilder(): WalletPayloadBuilder {
  return {
    build: () => payload,
    buildFromEntitlement: async () => payload,
  }
}

async function unzipPkpass(saveUrl: string): Promise<JSZip> {
  const prefix = "data:application/vnd.apple.pkpass;base64,"
  expect(saveUrl.startsWith(prefix)).toBe(true)
  return JSZip.loadAsync(Buffer.from(saveUrl.slice(prefix.length), "base64"))
}

async function readJson(zip: JSZip, path: string) {
  const content = await zip.file(path)?.async("string")
  expect(content).toBeDefined()
  return JSON.parse(content as string)
}

async function hasNonEmptyFile(zip: JSZip, path: string): Promise<boolean> {
  const content = await zip.file(path)?.async("nodebuffer")
  return Boolean(content?.length)
}

async function expectManifestHashesToMatch(
  zip: JSZip,
  manifest: Record<string, string>
): Promise<void> {
  for (const [path, expectedHash] of Object.entries(manifest)) {
    const content = await zip.file(path)?.async("nodebuffer")
    expect(content).toBeDefined()
    expect(crypto.createHash("sha1").update(content as Buffer).digest("hex")).toBe(
      expectedHash
    )
  }
}
