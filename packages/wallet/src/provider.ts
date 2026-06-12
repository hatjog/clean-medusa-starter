import type {
  WalletAuditEnvelope,
  WalletInvalidationReason,
  WalletLocale,
  WalletPayload,
} from "./payload"

export interface WalletPassIssueResult {
  save_url: string
  audit_event?: WalletAuditEnvelope | unknown
}

export interface WalletPassInvalidateResult {
  audit_event?: WalletAuditEnvelope | unknown
}

/**
 * Provider-neutral port dla wallet adaptera (Google / Apple).
 * D-108 canonical name = `WalletPassProvider`. Story brief mówił `IWalletProvider`,
 * ale w v1.10.0 trzymamy się jednego publicznego nazewnictwa zgodnego z architekturą.
 */
export interface WalletPassProvider {
  issueSaveUrl(
    payload: WalletPayload,
    locale: WalletLocale
  ): Promise<WalletPassIssueResult>

  invalidate(
    entitlement_instance_id: string,
    reason: WalletInvalidationReason
  ): Promise<void | WalletPassInvalidateResult>
}
