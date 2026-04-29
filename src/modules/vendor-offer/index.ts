/**
 * vendor-offer module barrel export.
 *
 * @see ADR-070 — vendor-selection-policy (v1.5.0 schema-only, v1.6.0 runtime).
 * @see _bmad-output/implementation-artifacts/v150/STORY-4-1-MULTI-VENDOR-FOUNDATION-SCHEMA.md
 *
 * Public surface: types, lifecycle predicates, service façade.
 * Server-safe imports only — no DB clients, no env reads. The barrel is safe
 * to import from server-side code paths; storefront client bundles MUST NOT
 * pull this in (verified via Next.js build analyzer in upstream callsites).
 *
 * v1.5.0 behavior: write path guarded; v1.6.0 flag flip unlocks runtime.
 */
export type {
  VendorOffer,
  VendorOfferDraft,
  VendorOfferErrorCode,
  VendorOfferLifecycleState,
  VendorOfferUpdate,
} from "./types"
export { VendorOfferError } from "./types"

export {
  allowedNextStates,
  assertCanTransition,
  canTransition,
  isTerminal,
} from "./lifecycle"

export type { VendorOfferRepositoryPort, VendorOfferRuntimeFlags } from "./vendor-offer.service"
export { defaultSignatureFn, VendorOfferService } from "./vendor-offer.service"
