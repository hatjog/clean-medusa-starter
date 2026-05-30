import crypto from "node:crypto"

import forge from "node-forge"
import JSZip from "jszip"

import { normalizeWalletLocale, type WalletBarcodeFormat, type WalletInvalidationReason, type WalletLocale, type WalletPayload } from "../payload"
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

const LABEL_KEYS = {
  VOUCHER: "LABEL_VOUCHER",
  CODE: "LABEL_CODE",
  STATUS: "LABEL_STATUS",
  TITLE: "LABEL_TITLE",
} as const

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

/**
 * AppleWalletProvider — producer kontraktu `WalletPassProvider` dla Apple `.pkpass`.
 *
 * Kontrakt audytu: provider zwraca wyłącznie `{ save_url }`. Audytowalny
 * `AuditEnvelope` (success/failure/invalidate) jest wytwarzany przez
 * `WalletPassFacade`, nie przez provider. Producenci downstream MUSZĄ wywoływać
 * provider tylko za pośrednictwem facade (per Story 3.1 D-108). Bezpośrednie
 * wywołanie providera poza facade pomija envelope i telemetrię D-112.
 */
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
    const manifestBytes = Buffer.from(
      JSON.stringify(manifest, null, 2),
      "utf8"
    )
    const signing_context = this.signingContextFactory()
    const signature = signManifest(manifestBytes, signing_context)

    files["manifest.json"] = manifestBytes
    files.signature = signature

    const archive = await createPkpassArchive(files)

    return {
      save_url: `data:${PASS_MIME_TYPE};base64,${archive.toString("base64")}`,
    }
  }

  /**
   * Apple Wallet nie udostępnia odpowiednika Google REST invalidation dla lokalnego
   * `.pkpass`. Klient odświeża stan przy kolejnym pobraniu, więc v1.10.0 zwraca
   * void (noop) — audytowalny envelope produkuje `WalletPassFacade` zgodnie
   * z portem `WalletPassProvider` ze Story 3.1.
   */
  async invalidate(
    _entitlement_instance_id: string,
    _reason: WalletInvalidationReason
  ): Promise<void> {
    return
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
    if (!barcode || typeof barcode.value !== "string" || barcode.value.length === 0) {
      throw new Error(
        "WalletPayload.barcode_spec.value is required for Apple pass.json"
      )
    }

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
            label: LABEL_KEYS.VOUCHER,
            value: payload.title,
          },
        ],
        secondaryFields: [
          {
            key: "code",
            label: LABEL_KEYS.CODE,
            value: payload.code,
          },
          {
            key: "status",
            label: LABEL_KEYS.STATUS,
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

let cachedStubContext: AppleSigningContext | undefined

/**
 * TODO(v1.11.0+): zastąpić stub realnym Apple-issued Pass Type ID Certificate,
 * kluczem prywatnym z Secret Managera i certyfikatem intermediate po Apple
 * Developer Program enrollment. Ten stub jest wyłącznie ścieżką code-complete
 * i testową dla `WALLET_APPLE_ENABLED=false`. Cache modułowy unika regeneracji
 * 2048-bitowego RSA keypair przy każdym wywołaniu (synchroniczne ~200-500ms).
 *
 * FIXME(v1.11.0+): replace `wwdrCert` (currently a second self-signed stub
 * with distinct CN, NIE realny Apple WWDR intermediate) with the real Apple
 * Worldwide Developer Relations Certification Authority intermediate cert
 * before flipping `WALLET_APPLE_ENABLED=true`.
 */
export function createStubSigningContext(): AppleSigningContext {
  if (cachedStubContext) {
    return cachedStubContext
  }

  const signerKeys = forge.pki.rsa.generateKeyPair({ bits: 2048, workers: 0 })
  const signerCert = buildSelfSignedCertificate(signerKeys, {
    commonName: "GP-Apple-Wallet-Stub",
    serialNumber: "01",
  })

  const wwdrKeys = forge.pki.rsa.generateKeyPair({ bits: 2048, workers: 0 })
  const wwdrCert = buildSelfSignedCertificate(wwdrKeys, {
    commonName: "GP-Apple-WWDR-Stub",
    serialNumber: "02",
  })

  cachedStubContext = {
    signerCert,
    signerKey: signerKeys.privateKey,
    wwdrCert,
  }

  return cachedStubContext
}

function buildSelfSignedCertificate(
  keys: forge.pki.rsa.KeyPair,
  attrs: { commonName: string; serialNumber: string }
): forge.pki.Certificate {
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = attrs.serialNumber
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(
    cert.validity.notBefore.getTime() + 365 * 24 * 60 * 60 * 1000
  )
  const subject = [
    { name: "commonName", value: attrs.commonName },
    { name: "organizationName", value: DEFAULT_ORGANIZATION_NAME },
  ]
  cert.setSubject(subject)
  cert.setIssuer(subject)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return cert
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
  manifestBytes: Buffer,
  context: AppleSigningContext
): Buffer {
  const p7 = forge.pkcs7.createSignedData()
  p7.content = forge.util.createBuffer(
    manifestBytes.toString("binary"),
    "raw"
  )
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
    "uk-UA": { voucher: "Ваучер", code: "Код", status: "Статус" },
    "de-DE": { voucher: "Gutschein", code: "Code", status: "Status" },
  }
  const text = labels[locale]

  return [
    `"${LABEL_KEYS.VOUCHER}" = "${escapePassString(text.voucher)}";`,
    `"${LABEL_KEYS.CODE}" = "${escapePassString(text.code)}";`,
    `"${LABEL_KEYS.STATUS}" = "${escapePassString(text.status)}";`,
    `"${LABEL_KEYS.TITLE}" = "${escapePassString(payload.title)}";`,
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

export const __test_only__ = {
  resetStubSigningContextCache(): void {
    cachedStubContext = undefined
  },
}
