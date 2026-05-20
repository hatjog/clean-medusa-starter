import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import {
  verifyMagicLink,
  type MagicLinkVerificationReason,
} from "../../../../../lib/auth/magic-link"
import { issueRecoverCustomerSessionToken } from "../../../../../lib/auth/recover-magic-link-session"
import { marketContextStorage } from "../../../../../lib/market-context"

function bodyValue(req: MedusaRequest, key: string): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[key]
  return typeof value === "string" ? value.trim() : ""
}

function invalid(res: MedusaResponse, reason: MagicLinkVerificationReason = "invalid"): void {
  res.status(200).json({ valid: false, reason })
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const token = bodyValue(req, "token")
  if (!token) {
    invalid(res)
    return
  }

  const marketId = marketContextStorage.getStore()?.market_id?.trim() ?? null
  if (!marketId) {
    invalid(res)
    return
  }

  const verification = await verifyMagicLink(token)
  if (!verification.valid) {
    invalid(res, verification.reason)
    return
  }

  const subjectMarketId = verification.subject.market_id
  const customerId = verification.subject.customer_id
  if (
    verification.purpose !== "recover" ||
    typeof customerId !== "string" ||
    !customerId.trim() ||
    typeof subjectMarketId !== "string" ||
    subjectMarketId.trim() !== marketId
  ) {
    invalid(res)
    return
  }

  const authToken = issueRecoverCustomerSessionToken(req, customerId.trim())
  if (!authToken) {
    invalid(res)
    return
  }

  res.status(200).json({ valid: true, auth_token: authToken })
}
