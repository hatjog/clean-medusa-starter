import crypto from "node:crypto"

import forge from "node-forge"
import JSZip from "jszip"

import { normalizeWalletLocale, type AuditEnvelope, type WalletBarcodeFormat, type WalletInvalidationReason, type WalletLocale, type WalletPayload } from "../payload"
import type { WalletPassProvider } from "../provider"

const PASS_MIME_TYPE = "application/vnd.apple.pkpass"
const DEFAULT_PASS_IDENTIFIER = "pass.com.gp.stub"
const DEFAULT_APPLE_TEAM = "STUBTEAMID1"
const DEFAULT_ORGANIZATION_NAME = "Grow Platform"
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax69kAAAAAASUVORK5CYII=",
  "base64"
)

const LOCALE_DIRECTORIES: Record<WalletLocale, string> = {
  "pl-PL": "pl.lproj",
  "en-US": "en.lproj",
  "uk-UA": "uk.lproj",
  "de-DE": "de.lproj",
}

export interface AppleWalletProviderConfig {
  passTypeIdentifier?: string
  teamIdentifier?: string
  organizationName?: string
  signingContextFactory?: () => AppleSigningContext
}

export interface AppleSigningContext {
  signerCert: forge.pki.Certificate
  signerKey: forge.pki.rsa.PrivateKey
  wwdrCert: forge.pki.Certificate
}

type PassFileMap = Record<string, Buffer>

export class AppleWalletProvider implements WalletPassProvider {
  private readonly passTypeIdentifier: string
  private readonly teamIdentifier: string
  private readonly organizationName: string
  private readonly signingContextFactory: () => AppleSigningContext

  constructor(config: AppleWalletProviderConfig = {}) {
    this.passTypeIdentifier =
      config.passTypeIdentifier ?? DEFAULT_PASS_IDENTIFIER
    this.teamIdentifier = config.teamIdentifier ?? DEFAULT_APPLE_TEAM
    this.organizationName = config.organizationName ?? DEFAULT_ORGANIZATION_NAME
    this.signingContextFactory =
      config.signingContextFactory ?? createStubSigningContext
  }

  async issueSaveUrl(
    payload: WalletPayload,
    locale: WalletLocale
  ): Promise<{ save_url: string }> {
    const effective_locale = normalizeWalletLocale(locale)
    const files = this.createPassFiles(payload, effective_locale)
    const manifest = createManifest(files)
    const signing_context = this.signingContextFactory()
    const signature = signManifest(manifest, signing_context)

    files["manifest.json"] = Buffer.from(
      JSON.stringify(manifest, null, 2),
      "utf8"
    )
    files.signature = signature

    const archive = await createPkpassArchive(files)

    return {
      save_url: `data:${PASS_MIME_TYPE};base64,${archive.toString("base64")}`,
    }
  }

  /**
   * Apple Wallet nie udostępnia odpowiednika Google REST invalidation dla lokalnego
   * `.pkpass`. Klient odświeża stan przy kolejnym pobraniu, więc v1.10.0 zwraca
   * audytowalny noop zamiast udawać server-side revoke.
   */
  async invalidate(
    entitlement_instance_id: string,
    reason: WalletInvalidationReason
  ): Promise<{ audit_event: AuditEnvelope }> {
    return {
      audit_event: {
        event_type: "wallet.pass_invalidated",
        entitlement_instance_id,
        provider: "apple",
        reason,
        timestamp: new Date().toISOString(),
        outcome: "success",
      },
    }
  }

  private createPassFiles(
    payload: WalletPayload,
    effective_locale: WalletLocale
  ): PassFileMap {
    const pass_json = this.createPassJson(payload, effective_locale)
    const files: PassFileMap = {
      "pass.json": Buffer.from(JSON.stringify(pass_json, null, 2), "utf8"),
      "icon.png": PLACEHOLDER_PNG,
      "logo.png": PLACEHOLDER_PNG,
    }

    for (const [locale, directory] of Object.entries(LOCALE_DIRECTORIES)) {
      files[`${directory}/pass.strings`] = Buffer.from(
        createPassStrings(payload, locale as WalletLocale),
        "utf8"
      )
    }

    return files
  }

  private createPassJson(payload: WalletPayload, locale: WalletLocale) {
    const barcode = payload.barcode ?? payload.barcode_spec

    return {
      formatVersion: 1,
      passTypeIdentifier: this.passTypeIdentifier,
      serialNumber: payload.entitlement_instance_id,
      teamIdentifier: this.teamIdentifier,
      organizationName: this.organizationName,
      description: payload.title,
      logoText: this.organizationName,
      foregroundColor: normalizeHexColor(payload.branding.accent_color),
      backgroundColor: normalizeHexColor(payload.branding.primary_color),
      labelColor: normalizeHexColor(payload.branding.accent_color),
      expirationDate: resolveExpirationDate(payload),
      voided: payload.status === "REVOKED" || payload.status === "REFUNDED",
      webServiceURL: payload.deep_link,
      relevantText: payload.deep_link,
      barcodes: [
        {
          format: toAppleBarcodeFormat(barcode.format),
          message: barcode.value,
          messageEncoding: "iso-8859-1",
          altText: payload.code,
        },
      ],
      storeCard: {
        primaryFields: [
          {
            key: "title",
            label: "Voucher",
            value: payload.title,
          },
        ],
        secondaryFields: [
          {
            key: "code",
            label: "Kod",
            value: payload.code,
          },
          {
            key: "status",
            label: "Status",
            value: payload.status,
          },
        ],
        auxiliaryFields: [
          {
            key: "locale",
            label: "Locale",
            value: locale,
          },
        ],
        backFields: [
          {
            key: "deep_link",
            label: "Link",
            value: payload.deep_link,
          },
        ],
      },
    }
  }
}

/**
 * TODO(v1.11.0+): zastąpić stub realnym Apple-issued Pass Type ID Certificate,
 * kluczem prywatnym z Secret Managera i certyfikatem intermediate po Apple
 * Developer Program enrollment. Ten stub jest wyłącznie ścieżką code-complete
 * i testową dla `WALLET_APPLE_ENABLED=false`.
 */
export function createStubSigningContext(): AppleSigningContext {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, workers: 0 })
  const signerCert = forge.pki.createCertificate()
  signerCert.publicKey = keys.publicKey
  signerCert.serialNumber = "01"
  signerCert.validity.notBefore = new Date()
  signerCert.validity.notAfter = new Date(
    signerCert.validity.notBefore.getTime() + 365 * 24 * 60 * 60 * 1000
  )
  const attrs = [
    { name: "commonName", value: "GP-Apple-Wallet-Stub" },
    { name: "organizationName", value: DEFAULT_ORGANIZATION_NAME },
  ]
  signerCert.setSubject(attrs)
  signerCert.setIssuer(attrs)
  signerCert.sign(keys.privateKey, forge.md.sha256.create())

  return {
    signerCert,
    signerKey: keys.privateKey,
    wwdrCert: signerCert,
  }
}

function createManifest(files: PassFileMap): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([name, content]) => [
      name,
      crypto.createHash("sha1").update(content).digest("hex"),
    ])
  )
}

function signManifest(
  manifest: Record<string, string>,
  context: AppleSigningContext
): Buffer {
  const p7 = forge.pkcs7.createSignedData()
  p7.content = forge.util.createBuffer(JSON.stringify(manifest), "utf8")
  p7.addCertificate(context.signerCert)
  p7.addCertificate(context.wwdrCert)
  p7.addSigner({
    key: context.signerKey,
    certificate: context.signerCert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      {
        type: forge.pki.oids.contentType,
        value: forge.pki.oids.data,
      },
      {
        type: forge.pki.oids.messageDigest,
      },
    ],
  })
  p7.sign({ detached: true })

  return Buffer.from(
    forge.asn1.toDer(p7.toAsn1()).getBytes(),
    "binary"
  )
}

async function createPkpassArchive(files: PassFileMap): Promise<Buffer> {
  const zip = new JSZip()

  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content)
  }

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  })
}

function createPassStrings(payload: WalletPayload, locale: WalletLocale): string {
  const labels: Record<WalletLocale, Record<string, string>> = {
    "pl-PL": { voucher: "Voucher", code: "Kod", status: "Status" },
    "en-US": { voucher: "Voucher", code: "Code", status: "Status" },
    "uk-UA": { voucher: "Voucher", code: "Kod", status: "Status" },
    "de-DE": { voucher: "Gutschein", code: "Code", status: "Status" },
  }
  const text = labels[locale]

  return [
    `"Voucher" = "${escapePassString(text.voucher)}";`,
    `"Kod" = "${escapePassString(text.code)}";`,
    `"Status" = "${escapePassString(text.status)}";`,
    `"Tytul" = "${escapePassString(payload.title)}";`,
  ].join("\n")
}

function toAppleBarcodeFormat(format: WalletBarcodeFormat): string {
  return format === "PDF417" ? "PKBarcodeFormatPDF417" : "PKBarcodeFormatQR"
}

function resolveExpirationDate(payload: WalletPayload): string {
  if (payload.status === "EXPIRED") {
    return new Date(0).toISOString()
  }

  return new Date(payload.expires_at).toISOString()
}

function normalizeHexColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#000000"
}

function escapePassString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}
