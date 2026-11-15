/**
 * payment-charge-fact.ts — v1.16.0 Story 8.3 (FR-15, AD-18, NFR-4, ADR-233).
 *
 * "Was the buyer's money taken?" after an interrupted 3DS return. The answer
 * comes from the PSP read on the BACKEND (Stripe secret per market), never
 * from `redirect_status` in the storefront URL (browser input, ADR-233).
 *
 * Three disjoint answers — there is NO default to "not charged":
 *  - `charged`     every PaymentIntent of the cart is `succeeded` or
 *                  `requires_capture` (money taken or held);
 *  - `not_charged` every PaymentIntent is in a state that cannot move money
 *                  without a new buyer action (`requires_payment_method`,
 *                  `requires_confirmation`, `requires_action`, `canceled`);
 *  - `unknown`     anything else: `processing`, a mix, an unknown/future
 *                  status, no PaymentIntent proof, or a failed PSP read.
 *
 * The same status sets drive the re-initialisation guard
 * (`payment-session-reinit-guard.ts`): a PaymentIntent that is charged OR may
 * still become charged (`processing`) must not be replaced by a new one —
 * Medusa's `createPaymentSessionsWorkflow` deletes the existing session and
 * creates a NEW PaymentIntent, which is exactly a second charge for the same
 * purchase.
 */

/** Money taken or held by the PSP. Mirrors `PSP_TERMINAL_SUCCESS_STATUSES`. */
export const CHARGED_PAYMENT_INTENT_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "requires_capture",
])

/** States in which no money moved and none can move without the buyer. */
export const NOT_CHARGED_PAYMENT_INTENT_STATUSES: ReadonlySet<string> = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "canceled",
])

/**
 * PaymentIntent states that forbid creating a replacement PaymentIntent:
 * charged, or still able to become charged on its own.
 */
export const PAYMENT_INTENT_IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set([
  ...CHARGED_PAYMENT_INTENT_STATUSES,
  "processing",
])

export type PaymentChargeFact = "charged" | "not_charged" | "unknown"

export type PaymentChargeReason =
  | "all_intents_charged"
  | "all_intents_not_charged"
  | "intent_processing"
  | "intent_status_mixed"
  | "intent_status_unrecognised"
  | "no_payment_intent"
  | "psp_status_unavailable"

export type PaymentChargeClassification = {
  charge: PaymentChargeFact
  reason: PaymentChargeReason
}

/**
 * Pure classification of PaymentIntent statuses read from the PSP.
 * `statuses === null` means the PSP read failed ⇒ `unknown`, never
 * `not_charged`.
 */
export function classifyPaymentCharge(
  statuses: ReadonlyArray<string> | null
): PaymentChargeClassification {
  if (statuses === null) return { charge: "unknown", reason: "psp_status_unavailable" }
  if (statuses.length === 0) return { charge: "unknown", reason: "no_payment_intent" }
  if (statuses.every(s => CHARGED_PAYMENT_INTENT_STATUSES.has(s))) {
    return { charge: "charged", reason: "all_intents_charged" }
  }
  if (statuses.every(s => NOT_CHARGED_PAYMENT_INTENT_STATUSES.has(s))) {
    return { charge: "not_charged", reason: "all_intents_not_charged" }
  }
  if (statuses.some(s => s === "processing")) {
    return { charge: "unknown", reason: "intent_processing" }
  }
  const known = (s: string) =>
    CHARGED_PAYMENT_INTENT_STATUSES.has(s) || NOT_CHARGED_PAYMENT_INTENT_STATUSES.has(s)
  if (statuses.every(known)) return { charge: "unknown", reason: "intent_status_mixed" }
  return { charge: "unknown", reason: "intent_status_unrecognised" }
}

/** Ids of PaymentIntents that must not be replaced (charged or in flight). */
export function inFlightPaymentIntentIds(
  intentIds: ReadonlyArray<string>,
  statuses: ReadonlyArray<string>
): string[] {
  return intentIds.filter((_, i) => PAYMENT_INTENT_IN_FLIGHT_STATUSES.has(statuses[i]))
}
