import {
  classifyPaymentAttempt,
  classifyStripeFailure,
  extractStripeFailureDetails,
  redactFailureCode,
} from "../../../lib/payment/failure-classification"

describe("Stripe payment failure classification", () => {
  it("redacts failure_code at the first provider detail separator", () => {
    expect(redactFailureCode("card_declined: insufficient_funds")).toBe("card_declined")
  })

  it("classifies insufficient_funds as retryable", () => {
    expect(
      classifyStripeFailure({
        failure_code: "card_declined",
        decline_code: "insufficient_funds",
      }).classification
    ).toBe("retryable")
  })

  it("classifies 3DS authentication failure as retryable", () => {
    expect(
      classifyStripeFailure({
        failure_code: "payment_intent_authentication_failure",
        decline_code: null,
      }).classification
    ).toBe("retryable")
  })

  it("classifies hard decline and fraud indicators as non-retryable", () => {
    expect(
      classifyStripeFailure({ failure_code: "card_declined", decline_code: "fraudulent" })
        .classification
    ).toBe("non_retryable")
    expect(
      classifyStripeFailure({ failure_code: "card_declined", decline_code: "lost_card" })
        .classification
    ).toBe("non_retryable")
  })

  it("does not treat missing failure metadata as retryable", () => {
    expect(classifyStripeFailure({}).classification).toBe("support_required")
  })

  it("extracts nested Stripe last_payment_error without raw message text", () => {
    const details = extractStripeFailureDetails({
      last_payment_error: {
        code: "card_declined: raw provider sentence",
        decline_code: "insufficient_funds",
        message: "Your card has insufficient funds.",
      },
    })

    expect(details).toEqual({
      failure_code: "card_declined",
      decline_code: "insufficient_funds",
    })
  })

  it("classifies processing attempt as pending when no failure metadata exists", () => {
    expect(
      classifyPaymentAttempt({
        status: "pending",
        data: { status: "processing" },
        context: {},
      }).classification
    ).toBe("pending")
  })

  it("keeps pending PSP status ahead of stale historical last_payment_error", () => {
    expect(
      classifyPaymentAttempt({
        status: "pending",
        data: {
          status: "processing",
          last_payment_error: {
            code: "card_declined",
            decline_code: "insufficient_funds",
          },
        },
        context: {},
      }).classification
    ).toBe("pending")
  })
})
