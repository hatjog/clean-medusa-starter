import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { randomUUID } from "node:crypto";

import { marketContextStorage } from "../../../lib/market-context";
import {
  ConsentTransactionError,
  type PauseState,
  type RecordConsentInput,
  type VoucherPiiService,
} from "../../../modules/voucher-pii";

/**
 * POST /store/voucher-pii-consent — STORY-2-2 D-66 endpoint.
 *
 * Accepts an action-discriminated payload (TF-208 Story 4.4 harmonisation):
 *   action='grant'    → recordConsentTransaction (D-66 chained Postgres tx)
 *   action='withdraw' → lookupConsentSnapshot + recordWithdrawalTransaction
 *   action='pause'    → recordPauseAudit (SC-3 lightweight audit row)
 *
 * Backward compat: if body has market_id but no action, legacy grant path is used.
 *
 * Returns:
 *   201 + { consent_audit_id, recipient_pii_id, delivery_decision_id }  on grant success
 *   201 + { withdrawal_audit_id }                                        on withdraw success
 *   201 + { pause_audit_id }                                             on pause success
 *   4xx + { error, message }                                             on validation failure
 *   5xx + { error, code }                                                on tx failure
 *
 * Per R-NEW-6 R1 F4: NEVER 200 + silent fallback. Audit failure → propagate.
 *
 * Auth: x-publishable-api-key enforced via marketGuardMiddleware on /store/*.
 * TF-209 (Story 4.4): storefront migrated to sdk.client.fetch for auto key injection.
 *
 * NFR-SEC-5/6: CSP report-only header + frame-ancestors `'none'` on all responses.
 */

type ConsentAction = "grant" | "withdraw" | "pause";

interface RawBody {
  action?: unknown;
  token?: unknown;
  market_id?: unknown;
  order_id?: unknown;
  entitlement_id?: unknown;
  recipient_email?: unknown;
  recipient_phone?: unknown;
  locale?: unknown;
  is_gift?: unknown;
  compensates_audit_id?: unknown;
  pause_state?: unknown;
  surface?: unknown;
  occurred_at?: unknown;
  schema_version?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isKnownAction(v: unknown): v is ConsentAction {
  return v === "grant" || v === "withdraw" || v === "pause";
}

function isKnownPauseState(v: unknown): v is PauseState {
  return (
    v === "considering" || v === "paused" || v === "timeout" || v === "withdrawn"
  );
}

type GrantLegacyValidated = RecordConsentInput & {
  action: "grant";
  token: string;
  source: "legacy-body";
};
type GrantTokenValidated = {
  action: "grant";
  token: string;
  locale: string;
  source: "claim-token";
};
type WithdrawValidated = {
  action: "withdraw";
  token: string;
  compensates_audit_id: string;
  locale: string;
};
type PauseValidated = {
  action: "pause";
  token: string;
  locale: string;
  pause_state: PauseState;
  market_id: string;
  request_id: string;
};
type ValidatedBody = GrantLegacyValidated | GrantTokenValidated | WithdrawValidated | PauseValidated;

type EntitlementConsentSnapshot = {
  entitlement_id: string;
  market_id: string;
  order_id: string;
  buyer_email: string | null;
  buyer_is_recipient: boolean;
};

function validateGrantBody(body: RawBody): GrantLegacyValidated | GrantTokenValidated | string {
  if (!isNonEmptyString(body.market_id)) {
    if (!isNonEmptyString(body.token)) return "token required for grant";
    if (!isNonEmptyString(body.locale)) return "locale required";
    return {
      action: "grant",
      token: body.token,
      locale: body.locale,
      source: "claim-token",
    };
  }
  if (!isNonEmptyString(body.order_id)) return "order_id required";
  if (!isNonEmptyString(body.entitlement_id)) return "entitlement_id required";
  if (!isNonEmptyString(body.locale)) return "locale required";
  if (typeof body.is_gift !== "boolean") return "is_gift must be boolean";

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

  const token = isNonEmptyString(body.token) ? body.token : "";

  return {
    action: "grant",
    token,
    source: "legacy-body",
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

function validateWithdrawBody(body: RawBody): WithdrawValidated | string {
  if (!isNonEmptyString(body.compensates_audit_id)) {
    return "compensates_audit_id required for withdraw";
  }
  if (!isNonEmptyString(body.locale)) return "locale required";
  const token = isNonEmptyString(body.token) ? body.token : "";
  return {
    action: "withdraw",
    token,
    compensates_audit_id: body.compensates_audit_id,
    locale: body.locale,
  };
}

function validatePauseBody(
  body: RawBody,
  marketCtx: string | null
): PauseValidated | string {
  if (!isNonEmptyString(body.token)) return "token required for pause";
  if (!isNonEmptyString(body.locale)) return "locale required";
  if (!isKnownPauseState(body.pause_state)) {
    return "pause_state must be one of: considering, paused, timeout, withdrawn";
  }
  // market_id: prefer body field, fall back to market context resolved from publishable key.
  const market_id = isNonEmptyString(body.market_id)
    ? body.market_id
    : marketCtx ?? "";
  if (!market_id) return "market_id required for pause (or send x-publishable-api-key)";

  return {
    action: "pause",
    token: body.token,
    locale: body.locale,
    pause_state: body.pause_state,
    market_id,
    request_id: randomUUID(),
  };
}

function validateBody(body: RawBody, marketCtx: string | null): ValidatedBody | string {
  const action = body.action;

  // Backward compat: no action field + market_id present → legacy grant path.
  if (!isKnownAction(action)) {
    if (isNonEmptyString(body.market_id)) {
      const result = validateGrantBody(body);
      if (typeof result === "string") return result;
      return result;
    }
    return "action must be one of: grant, withdraw, pause";
  }

  if (action === "grant") return validateGrantBody(body);
  if (action === "withdraw") return validateWithdrawBody(body);
  return validatePauseBody(body, marketCtx);
}

function setSecurityHeaders(res: MedusaResponse): void {
  res.setHeader(
    "Content-Security-Policy-Report-Only",
    "default-src 'self'; frame-ancestors 'none'"
  );
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function resolveService(req: MedusaRequest): VoucherPiiService | null {
  const scope = (req as unknown as { scope?: { resolve?: (k: string) => unknown } }).scope;
  try {
    const resolved = scope?.resolve?.("voucher_pii") as VoucherPiiService | undefined;
    return resolved ?? null;
  } catch {
    return null;
  }
}

function resolveDb(req: MedusaRequest): { raw: (sql: string, params?: unknown[]) => Promise<unknown> } | null {
  const scope = (req as unknown as { scope?: { resolve?: (k: string) => unknown } }).scope;
  try {
    const resolved = scope?.resolve?.(ContainerRegistrationKeys.PG_CONNECTION) as
      | { raw: (sql: string, params?: unknown[]) => Promise<unknown> }
      | undefined;
    return resolved ?? null;
  } catch {
    return null;
  }
}

async function lookupEntitlementByClaimToken(
  db: { raw: (sql: string, params?: unknown[]) => Promise<unknown> },
  token: string
): Promise<EntitlementConsentSnapshot | null> {
  const sql = `
    SELECT
      entitlement_id::text AS entitlement_id,
      market_id::text AS market_id,
      order_id::text AS order_id,
      buyer_email::text AS buyer_email,
      COALESCE(buyer_is_recipient, false) AS buyer_is_recipient
    FROM gp_core.entitlements
    WHERE claim_token::text = $1
    LIMIT 1
  `;
  const result = await db.raw(sql, [token]);
  const rows = Array.isArray((result as { rows?: unknown[] })?.rows)
    ? ((result as { rows: unknown[] }).rows)
    : Array.isArray(result)
      ? (result as unknown[])
      : [];
  const row = rows[0] as Partial<EntitlementConsentSnapshot> | undefined;
  if (
    !row?.entitlement_id ||
    !row.market_id ||
    !row.order_id
  ) {
    return null;
  }
  return {
    entitlement_id: String(row.entitlement_id),
    market_id: String(row.market_id),
    order_id: String(row.order_id),
    buyer_email: row.buyer_email == null ? null : String(row.buyer_email),
    buyer_is_recipient: Boolean(row.buyer_is_recipient),
  };
}

function inputFromEntitlement(
  validation: GrantTokenValidated,
  entitlement: EntitlementConsentSnapshot
): RecordConsentInput {
  return {
    market_id: entitlement.market_id,
    order_id: entitlement.order_id,
    entitlement_id: entitlement.entitlement_id,
    recipient_email: entitlement.buyer_is_recipient ? entitlement.buyer_email : null,
    recipient_phone: null,
    locale: validation.locale,
    is_gift: !entitlement.buyer_is_recipient,
    request_id: randomUUID(),
  };
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  setSecurityHeaders(res);

  const marketCtx = marketContextStorage.getStore();
  const marketId = marketCtx?.market_id ?? null;

  const validation = validateBody(req.body as RawBody, marketId);
  if (typeof validation === "string") {
    res.status(400).json({ error: "validation_failed", message: validation });
    return;
  }

  const service = resolveService(req);
  if (!service) {
    res.status(503).json({
      error: "service_unavailable",
      code: "voucher_pii_service_not_registered",
    });
    return;
  }

  try {
    if (validation.action === "grant") {
      let input: RecordConsentInput;
      if (validation.source === "legacy-body") {
        input = validation;
      } else {
        const db = resolveDb(req);
        if (!db) {
          res.status(503).json({
            error: "service_unavailable",
            code: "gp_core_entitlement_lookup_unavailable",
          });
          return;
        }
        const entitlement = await lookupEntitlementByClaimToken(db, validation.token);
        if (!entitlement) {
          res.status(404).json({
            error: "entitlement_not_found",
            message: "Consent token not found",
          });
          return;
        }
        if (marketId && entitlement.market_id !== marketId) {
          res.status(404).json({
            error: "entitlement_not_found",
            message: "Consent token not found",
          });
          return;
        }
        input = inputFromEntitlement(validation, entitlement);
      }

      const result = await service.recordConsentTransaction(input);
      res.status(201).json({
        audit_id: result.consent_audit_id,
        consent_audit_id: result.consent_audit_id,
        recipient_pii_id: result.recipient_pii_id,
        delivery_decision_id: result.delivery_decision_id,
        latency_ms: result.latency_ms,
      });
      return;
    }

    if (validation.action === "withdraw") {
      const snapshot = await service.lookupConsentSnapshot(
        validation.compensates_audit_id
      );
      if (!snapshot?.audit_confirmed) {
        res.status(404).json({
          error: "consent_not_found",
          message: "Original consent audit not found or already withdrawn",
        });
        return;
      }
      const result = await service.recordWithdrawalTransaction({
        market_id: snapshot.market_id,
        order_id: snapshot.order_id ?? validation.token,
        consent_audit_id: validation.compensates_audit_id,
        request_id: randomUUID(),
        withdrawal_path: "immediate",
      });
      res.status(201).json({
        withdrawal_audit_id: result.withdrawal_audit_id,
        latency_ms: result.latency_ms,
        in_flight_dispatch_aborted: result.in_flight_dispatch_aborted,
      });
      return;
    }

    // action === 'pause'
    const result = await service.recordPauseAudit(validation);
    res.status(201).json({
      pause_audit_id: result.pause_audit_id,
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
