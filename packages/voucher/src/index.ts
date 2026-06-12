import type { EntitlementInstanceRow } from "../../api/src/modules/voucher/models/entitlement"

export type LocalizedWalletText =
  | string
  | Partial<Record<string, string>>
  | Record<string, string>

export type EntitlementInstanceWalletMetadata = {
  code?: string
  title?: LocalizedWalletText
  entitlement_type?: string
  status?: "ACTIVE" | "EXPIRED" | "REVOKED" | "REFUNDED"
  expires_at?: string | Date | null
  salon_name?: string
  salon_address?: string
  deep_link?: string
  barcode_spec?: {
    format: "QR" | "PDF417"
    value: string
  }
  branding?: {
    logo_url?: string
    primary_color?: string
    accent_color?: string
  }
  latitude?: number
  longitude?: number
}

export type EntitlementInstance = Pick<EntitlementInstanceRow, "id"> & {
  code?: string
  title?: LocalizedWalletText
  market_id?: EntitlementInstanceRow["market_id"]
  entitlement_type?: string
  status?: "ACTIVE" | "EXPIRED" | "REVOKED" | "REFUNDED"
  state?: EntitlementInstanceRow["state"] | string
  expires_at?: EntitlementInstanceRow["expires_at"] | string | null
  salon_name?: string
  salon_address?: string
  deep_link?: string
  barcode_spec?: EntitlementInstanceWalletMetadata["barcode_spec"]
  branding?: EntitlementInstanceWalletMetadata["branding"]
  latitude?: number
  longitude?: number
  metadata?: {
    wallet?: EntitlementInstanceWalletMetadata
    gp?: {
      market_id?: string
      entitlement_type?: string
      wallet?: EntitlementInstanceWalletMetadata
    }
  } & Record<string, unknown>
}

export interface EntitlementInstanceReadModel {
  getById(entitlement_instance_id: string): Promise<EntitlementInstance | null>
}
