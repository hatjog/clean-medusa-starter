/**
 * verify-offer-signature.ts — convenience re-export wrapper used by consumers
 * that only need verification (subscriber audit trail validators, replay
 * tooling). Keeps the import surface narrow while sharing the underlying impl
 * with `sign-offer.ts`.
 *
 * @see specs/adr/2026-04-30-adr-079-mor-runtime-per-offer-signature.md
 */

export {
  verifySignature,
  computeKeyFingerprint,
  readSigningKey,
  readPreviousSigningKey,
} from "./sign-offer"
export type { SignOfferInput, SignedOffer } from "./sign-offer"
