import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { randomUUID } from "node:crypto";

import {
  ConsentTransactionError,
  type RecordConsentInput,
  type VoucherPiiService,
} from "../../../modules/voucher-pii";

/**
 * POST /store/voucher-pii-consent — STORY-2-2 D-66 endpoint.
 *
 * Story 2.1's Server Action POSTs the consent moment payload here. Returns
 *   201 + { consent_audit_id, recipient_pii_id, delivery_decision_id }  on success
 *   5xx + { error: 'error-audit-failed', code }                         on ROLLBACK
 *
 * Per R-NEW-6 R1 F4: NEVER 200 + silent fallback. Audit failure → propagate.
 *
 * NFR-SEC-5/6: CSP report-only header + frame-ancestors `'none'` set on the
 * response (consent moment may be embedded; same-origin only).
 *
 * Request body (zod-validated; canonical schema is
 * `specs/contracts/events/schemas/payloads/gp.voucher.consent_recorded.v1.schema.json`
 * — codegen via STORY-1-2 will replace the inline guard once landed).
 */

interface ConsentRequestBody {
  market_id?: unknown;
  order_id?: unknown;
  entitlement_id?: unknown;
  recipient_email?: unknown;
  recipient_phone?: unknown;
  locale?: unknown;
  is_gift?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function validateBody(body: ConsentRequestBody): RecordConsentInput | string {
  if (!isNonEmptyString(body.market_id)) return "market_id required";
  if (!isNonEmptyString(body.order_id)) return "order_id required";
  if (!isNonEmptyString(body.entitlement_id)) return "entitlement_id required";
  if (!isNonEmptyString(body.locale)) return "locale required";
  if (typeof body.is_gift !== "boolean") return "is_gift must be boolean";
  // Email + phone are optional but must be string|null when present.
  const recipient_email =
    body.recipient_email === null || body.recipient_email === undefined
      ? null
      : typeof body.recipient_email === "string"
        ? body.recipient_email
        : "INVALID";
  if (recipient_email === "INVALID") return "recipient_email must be string or null";
  const recipient_phone =
    body.recipient_phone === null || body.recipient_phone === undefined
      ? null
      : typeof body.recipient_phone === "string"
        ? body.recipient_phone
        : "INVALID";
  if (recipient_phone === "INVALID") return "recipient_phone must be string or null";

  return {
    market_id: body.market_id,
    order_id: body.order_id,
    entitlement_id: body.entitlement_id,
    recipient_email,
    recipient_phone,
    locale: body.locale,
    is_gift: body.is_gift,
    request_id: randomUUID(),
  };
}

function setSecurityHeaders(res: MedusaResponse): void {
  // NFR-SEC-5 — CSP report-only on the consent route only.
  res.setHeader(
    "Content-Security-Policy-Report-Only",
    "default-src 'self'; frame-ancestors 'none'"
  );
  // NFR-SEC-6 — frame-ancestors `'none'` (clickjacking defence).
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function resolveService(req: MedusaRequest): VoucherPiiService | null {
  // Medusa container resolution. Service is registered via loader at boot
  // (TODO(MEDUSA-CONTAINER): wire `voucher_pii` key in src/loaders).
  const scope = (req as unknown as { scope?: { resolve?: (k: string) => unknown } })
    .scope;
  try {
    const resolved = scope?.resolve?.("voucher_pii") as
      | VoucherPiiService
      | undefined;
    return resolved ?? null;
  } catch {
    return null;
  }
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  setSecurityHeaders(res);

  const validation = validateBody(req.body as ConsentRequestBody);
  if (typeof validation === "string") {
    res.status(400).json({ error: "validation_failed", message: validation });
    return;
  }

  const service = resolveService(req);
  if (!service) {
    // Service not wired — fail loud (NEVER silent fallback per R-NEW-6 R1 F4).
    res.status(503).json({
      error: "service_unavailable",
      code: "voucher_pii_service_not_registered",
    });
    return;
  }

  try {
    const result = await service.recordConsentTransaction(validation);
    res.status(201).json({
      consent_audit_id: result.consent_audit_id,
      recipient_pii_id: result.recipient_pii_id,
      delivery_decision_id: result.delivery_decision_id,
      latency_ms: result.latency_ms,
    });
  } catch (err) {
    if (err instanceof ConsentTransactionError) {
      res.status(500).json({
        error: "error-audit-failed",
        code: err.code,
        message: err.message,
      });
      return;
    }
    res.status(500).json({
      error: "error-audit-failed",
      code: "unknown",
      message: (err as Error)?.message ?? "unknown error",
    });
  }
}
