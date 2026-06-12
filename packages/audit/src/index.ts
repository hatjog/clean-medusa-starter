export enum AuditProvider {
  APPLE = "apple",
  BREVO = "brevo",
  GOOGLE = "google",
  RESEND = "resend",
  SAMSUNG = "samsung",
}

export type AuditProviderValue = `${AuditProvider}`

export type AuditEnvelope<TFields extends object = Record<string, never>> = {
  event_type: string
  provider: AuditProviderValue
} & TFields

export function toAuditProvider(value: string): AuditProviderValue {
  switch (value) {
    case AuditProvider.APPLE:
      return AuditProvider.APPLE
    case AuditProvider.BREVO:
      return AuditProvider.BREVO
    case AuditProvider.GOOGLE:
      return AuditProvider.GOOGLE
    case AuditProvider.RESEND:
      return AuditProvider.RESEND
    case AuditProvider.SAMSUNG:
      return AuditProvider.SAMSUNG
    default:
      throw new Error(`Unsupported audit provider: ${value}`)
  }
}
