import type {
  WalletInvalidationReason,
  WalletLocale,
  WalletPayload,
} from "./payload"

export interface WalletPassProvider {
  issueSaveUrl(
    payload: WalletPayload,
    locale: WalletLocale
  ): Promise<{ save_url: string }>

  invalidate(
    entitlement_instance_id: string,
    reason: WalletInvalidationReason
  ): Promise<void>
}

export type IWalletProvider = WalletPassProvider
