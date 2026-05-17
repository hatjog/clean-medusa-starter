import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"

import {
  emitStripePaymentAuditStep,
  persistStripePaymentAuditStep,
  type StripePaymentAuditPayload,
  type StripePaymentAuditResult,
} from "./stripe-payment-audit"

export const failPaymentWorkflow = createWorkflow<
  StripePaymentAuditPayload,
  StripePaymentAuditResult,
  []
>("gp-fail-payment-workflow", function (payload) {
  const result = persistStripePaymentAuditStep({
    eventType: "payment.failed",
    payload,
  })
  emitStripePaymentAuditStep({ result, payload })
  return new WorkflowResponse(result)
})
