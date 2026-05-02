/**
 * /admin/mor-policy/evaluate — D-71 smoke endpoint for the runtime evaluator.
 *
 * @see _bmad-output/implementation-artifacts/v150/STORY-3-1-VENDOR-MOR-RUNTIME.md
 *
 * Operational use:
 *  - admin sanity-check after deploy / signing-key rotation (ADR-079 §runbook)
 *  - integration test seam dla AC-MOR-INTERFACE-01 evidence capture
 *  - NOT a customer endpoint; auth = admin role; not exposed via storefront
 *
 * Response body mirrors `mor.policy.evaluated.v1` payload + signature so ops
 * can verify rotation correctness without DB access.
 */

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  MorPolicyEvaluator,
  type EvaluationRequest,
  type OfferContext,
} from "../../../../modules/mor-policy"

interface EvaluateBody {
  order_id: string
  market_id: string
  evaluation_request_id: string
  product_category?: "voucher" | "goods" | "digital" | "subscription" | "other"
  offer_contexts: OfferContext[]
}

export async function POST(
  req: MedusaRequest<EvaluateBody>,
  res: MedusaResponse
): Promise<void> {
  const body = req.body ?? ({} as EvaluateBody)

  const required: Array<keyof EvaluateBody> = [
    "order_id",
    "market_id",
    "evaluation_request_id",
    "offer_contexts",
  ]
  for (const f of required) {
    if (!body[f]) {
      res.status(400).json({
        error: "invalid_request",
        message: `Missing required field: ${String(f)}`,
      })
      return
    }
  }

  if (!Array.isArray(body.offer_contexts) || body.offer_contexts.length === 0) {
    res.status(400).json({
      error: "invalid_request",
      message: "offer_context cannot be empty array",
    })
    return
  }

  const evaluator = new MorPolicyEvaluator()
  const request: EvaluationRequest = {
    order_id: body.order_id,
    market_id: body.market_id,
    evaluation_request_id: body.evaluation_request_id,
    base_context: {
      market_id: body.market_id,
      product_category: body.product_category,
    },
    offer_contexts: body.offer_contexts,
  }

  try {
    const outcomes = await evaluator.evaluate(request)
    res.status(200).json({ outcomes })
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error"
    res.status(500).json({
      error: "evaluation_failed",
      message,
    })
  }
}
