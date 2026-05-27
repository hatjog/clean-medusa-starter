import type {
  AuditEnvelope,
  WalletInvalidationReason,
  WalletLocale,
  WalletPayload,
} from "./payload"

/**
 * Provider-neutral port dla wallet adaptera (Google / Apple).
 * D-108 canonical name = `WalletPassProvider`. Story brief mówił `IWalletProvider`,
 * ale w v1.10.0 trzymamy się jednego publicznego nazewnictwa zgodnego z architekturą.
 */
export interface WalletPassProvider {
  issueSaveUrl(
    payload: WalletPayload,
    locale: WalletLocale
  ): Promise<{ save_url: string }>

  invalidate(
    entitlement_instance_id: string,
    reason: WalletInvalidationReason
  ): Promise<void | { audit_event: AuditEnvelope }>
}
