import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

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

type RecoverLogger = {
  warn?: (message: string) => void
  error?: (message: string) => void
}

function resolveLogger(req: MedusaRequest): RecoverLogger | null {
  try {
    return (req.scope.resolve(ContainerRegistrationKeys.LOGGER) as RecoverLogger) ?? null
  } catch {
    return null
  }
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
    const dispatched = await dispatchRecoverMagicLinkEmail({
      scope: req.scope,
      to: email,
      locale,
      token,
      marketId,
    })
    if (!dispatched) {
      // Story 2.2 (AC5 poz.2): no-op dispatchu przestaje być niewidzialny.
      resolveLogger(req)?.warn?.(
        `[magic-link] recover e-mail not dispatched (notification module unavailable) market_id=${marketId}`
      )
    }
  } catch (err) {
    // Story 2.2 (AC5 poz.2): catch DOSTAJE ŚLAD (dziś był całkowicie cichy —
    // dług obserwowalności z inwentaryzacji 2.1). Po rejestracji modułu tu lądują
    // realne błędy providera (BREVO_*, HTTP) — bez logu operator nie miał
    // żadnego sygnału, że recover-maile nie wychodzą.
    //
    // Odpowiedź POZOSTAJE bez zmian: enumeration-safe i fail-closed —
    // logujemy WYŁĄCZNIE market_id i klasę/kod błędu, NIGDY adresu e-mail,
    // istnienia konta ani tokenu.
    resolveLogger(req)?.error?.(
      `[magic-link] recover dispatch failed market_id=${marketId} ` +
        `error=${(err as Error)?.name ?? "Error"} ` +
        `code=${String((err as { error_code?: unknown; code?: unknown })?.error_code ?? (err as { code?: unknown })?.code ?? "unknown")}`
    )
  }

  success(res)
}
