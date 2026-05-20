import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"

import { generateMagicLink } from "../../../../lib/auth/magic-link"
import { dispatchRecoverMagicLinkEmail } from "../../../../lib/auth/recover-magic-link-email"
import { scopeCustomerEmail } from "../../../../lib/customer-scoped-email"
import { marketContextStorage } from "../../../../lib/market-context"

type CustomerRecord = {
  id?: string
  email?: string | null
}

type CustomerModuleService = {
  listCustomers: (
    filters?: Record<string, unknown>,
    config?: Record<string, unknown>
  ) => Promise<CustomerRecord[]>
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/

function bodyValue(req: MedusaRequest, key: string): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[key]
  return typeof value === "string" ? value.trim() : ""
}

function resolveCustomerService(req: MedusaRequest): CustomerModuleService | null {
  try {
    const service = req.scope.resolve(Modules.CUSTOMER) as
      | CustomerModuleService
      | undefined
    return typeof service?.listCustomers === "function" ? service : null
  } catch {
    return null
  }
}

async function findCustomerByEmail(
  service: CustomerModuleService,
  email: string,
  marketId: string
): Promise<CustomerRecord | null> {
  const scopedEmail = scopeCustomerEmail(email, marketId)
  const customers = await service.listCustomers(
    { email: scopedEmail },
    { take: 1 }
  )
  return customers?.[0] ?? null
}

function success(res: MedusaResponse): void {
  res.status(202).json({ success: true })
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const purpose = bodyValue(req, "purpose")
  const email = bodyValue(req, "email").toLowerCase()
  const locale = bodyValue(req, "locale") || "pl"

  if (purpose !== "recover" || !EMAIL_PATTERN.test(email)) {
    res.status(400).json({
      code: "INVALID_RECOVER_REQUEST",
      message: "Valid recover purpose and email are required",
    })
    return
  }

  const marketId = marketContextStorage.getStore()?.market_id?.trim()
  if (!marketId) {
    res.status(403).json({
      code: "MARKET_CONTEXT_REQUIRED",
      message: "Market context required",
    })
    return
  }

  const customerService = resolveCustomerService(req)
  if (!customerService) {
    success(res)
    return
  }

  let customer: CustomerRecord | null = null
  try {
    customer = await findCustomerByEmail(customerService, email, marketId)
  } catch {
    success(res)
    return
  }

  if (!customer?.id) {
    success(res)
    return
  }

  try {
    const token = await generateMagicLink("recover", {
      customer_id: customer.id,
      market_id: marketId,
    })
    await dispatchRecoverMagicLinkEmail({
      scope: req.scope,
      to: email,
      locale,
      token,
    })
  } catch {
    // Enumeration-safe and fail-closed: no token leaves the backend and the
    // user-facing request result remains indistinguishable.
  }

  success(res)
}
