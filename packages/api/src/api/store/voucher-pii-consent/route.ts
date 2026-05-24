import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { createHash, randomUUID } from "node:crypto";

import { marketContextStorage } from "../../../lib/market-context";
import {
  ConsentTransactionError,
  type PauseState,
  type RecordConsentInput,
  type VoucherPiiService,
} from "../../../modules/voucher-pii";

/**
 * Resolve a per-request correlation id from caller-supplied headers (Story 4.4
 * review F9 — NFR-OBS-5 trace propagation). Preference order:
 *   1. Idempotency-Key (collapses retries; storefront ships this).
 *   2. x-request-id (canonical trace id header).
 *   3. randomUUID() — last-resort fallback.
 */
function resolveRequestId(req: MedusaRequest): string {
  const headers = (req as unknown as { headers?: Record<string, unknown> }).headers ?? {};
  const idem = headers["idempotency-key"];
  if (typeof idem === "string" && idem.length > 0 && idem.length <= 200) return idem;
  const traceId = headers["x-request-id"];
  if (typeof traceId === "string" && traceId.length > 0 && traceId.length <= 200) return traceId;
  return randomUUID();
}

/**
 * Hash a sensitive token for audit-row persistence (Story 4.4 review F5).
 * Raw consent claim tokens are credentials — they MUST NOT land in the audit
 * JSONB payload. We persist `sha256(token)` so the chain still binds to the
 * token identity without storing the credential.
 */
function hashToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

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

type ProvenanceFields = {
  surface?: "js" | "no-js";
  occurred_at?: string;
  schema_version?: 1;
};
type GrantLegacyValidated = RecordConsentInput & {
  action: "grant";
  token: string;
  source: "legacy-body";
} & ProvenanceFields;
type GrantTokenValidated = {
  action: "grant";
  token: string;
  locale: string;
  source: "claim-token";
} & ProvenanceFields;
type WithdrawValidated = {
  action: "withdraw";
  token: string;
  compensates_audit_id: string;
  locale: string;
} & ProvenanceFields;
type PauseValidated = {
  action: "pause";
  token: string;
  locale: string;
  pause_state: PauseState;
  market_id: string;
  request_id: string;
} & ProvenanceFields;
type ValidatedBody = GrantLegacyValidated | GrantTokenValidated | WithdrawValidated | PauseValidated;

type EntitlementConsentSnapshot = {
  entitlement_id: string;
  market_id: string;
  order_id: string;
  buyer_email: string | null;
  buyer_is_recipient: boolean;
};

/**
 * Validate provenance fields shipped by storefront `buildAuditPayload`
 * (Story 4.4 review F6). All three are optional in the wire schema but must
 * be strictly typed when present. `schema_version` must equal 1 — future
 * versions require a new contract.
 */
function validateProvenance(body: RawBody): ProvenanceFields | string {
  const out: ProvenanceFields = {};
  if (body.surface !== undefined) {
    if (body.surface !== "js" && body.surface !== "no-js") {
      return "surface must be 'js' or 'no-js'";
    }
    out.surface = body.surface;
  }
  if (body.occurred_at !== undefined) {
    if (typeof body.occurred_at !== "string" || body.occurred_at.length === 0) {
      return "occurred_at must be ISO-8601 string";
    }
    const parsed = Date.parse(body.occurred_at);
    if (Number.isNaN(parsed)) return "occurred_at must be ISO-8601 string";
    out.occurred_at = body.occurred_at;
  }
  if (body.schema_version !== undefined) {
    if (body.schema_version !== 1) return "schema_version must be 1";
    out.schema_version = 1;
  }
  return out;
}

function validateGrantBody(body: RawBody): GrantLegacyValidated | GrantTokenValidated | string {
  const prov = validateProvenance(body);
  if (typeof prov === "string") return prov;
  if (!isNonEmptyString(body.market_id)) {
    if (!isNonEmptyString(body.token)) return "token required for grant";
    if (!isNonEmptyString(body.locale)) return "locale required";
    return {
      action: "grant",
      token: body.token,
      locale: body.locale,
      source: "claim-token",
      ...prov,
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
    ...prov,
  };
}

function validateWithdrawBody(body: RawBody): WithdrawValidated | string {
  const prov = validateProvenance(body);
  if (typeof prov === "string") return prov;
  if (!isNonEmptyString(body.compensates_audit_id)) {
    return "compensates_audit_id required for withdraw";
  }
  if (!isNonEmptyString(body.locale)) return "locale required";
  // Review F3: withdraw MUST carry the consent token so we can prove the caller
  // holds the credential bound to the audit row being withdrawn. Empty-token
  // withdraws are rejected.
  if (!isNonEmptyString(body.token)) {
    return "token required for withdraw";
  }
  return {
    action: "withdraw",
    token: body.token,
    compensates_audit_id: body.compensates_audit_id,
    locale: body.locale,
    ...prov,
  };
}

function validatePauseBody(
  body: RawBody,
  marketCtx: string | null,
  request_id: string
): PauseValidated | string {
  const prov = validateProvenance(body);
  if (typeof prov === "string") return prov;
  if (!isNonEmptyString(body.token)) return "token required for pause";
  if (!isNonEmptyString(body.locale)) return "locale required";
  if (!isKnownPauseState(body.pause_state)) {
    return "pause_state must be one of: considering, paused, timeout, withdrawn";
  }
  // Review F4: market_id is ALWAYS derived from the publishable-key context.
  // Body-supplied market_id is rejected when it disagrees with the key context
  // (defence in depth against cross-market audit injection).
  if (!marketCtx) {
    return "market_id required for pause (or send x-publishable-api-key)";
  }
  if (isNonEmptyString(body.market_id) && body.market_id !== marketCtx) {
    return "market_id in body does not match publishable-key context";
  }

  return {
    action: "pause",
    token: body.token,
    locale: body.locale,
    pause_state: body.pause_state,
    market_id: marketCtx,
    request_id,
    ...prov,
  };
}

function validateBody(
  body: RawBody,
  marketCtx: string | null,
  request_id: string
): ValidatedBody | string {
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
  return validatePauseBody(body, marketCtx, request_id);
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
  // v1.9.0 Wave F6 HIGH-01 / CC-2 #1 — System 1 elimination.
  //
  // The legacy implementation read from `gp_core.entitlements` (ADR-052
  // deprecated System 1) and ignored the Layer 4 substrate where Stripe Path Y
  // actually writes. Result: a voucher issued by the live capture path was
  // invisible to this consent lookup, so every recipient hitting the consent
  // surface for a freshly-issued voucher fell through to the legacy table —
  // empty — and got `404` even though the entitlement existed.
  //
  // Post-F6 we read from `entitlement_instance` (Layer 4 / gp_mercur), join
  // the `voucher` projection for buyer-email surfacing, and resolve
  // `buyer_is_recipient` from policy_snapshot. Migration
  // `1778926200000_add_claim_token_to_entitlement_instance.ts` populates the
  // column at issue-time. Legacy rows (pre-F6) carry NULL claim_token and are
  // not reachable through this path — apps/web claim flow has been migrated
  // accordingly (System 1 read-paths are now stubs).
  //
  // Review F11 (preserved): explicit ORDER BY makes the LIMIT 1 deterministic
  // even if the UNIQUE invariant on claim_token is somehow violated. Newest
  // row wins.
  const sql = `
    SELECT
      ei.id::text AS entitlement_id,
      ei.market_id::text AS market_id,
      ei.order_id::text AS order_id,
      v.seller_handle AS buyer_email_hint,
      COALESCE(
        (ei.policy_snapshot->>'buyer_is_recipient')::boolean,
        false
      ) AS buyer_is_recipient,
      ei.policy_snapshot->>'buyer_email' AS buyer_email
    FROM entitlement_instance ei
    LEFT JOIN voucher v ON v.code = (ei.policy_snapshot->>'voucher_code')
    WHERE ei.claim_token = $1::uuid
      AND ei.claim_token_revoked_at IS NULL
    ORDER BY ei.created_at DESC NULLS LAST
    LIMIT 1
  `;
  const result = await db.raw(sql, [token]);
  const rows = Array.isArray((result as { rows?: unknown[] })?.rows)
    ? ((result as { rows: unknown[] }).rows)
    : Array.isArray(result)
      ? (result as unknown[])
      : [];
  const row = rows[0] as
    | (Partial<EntitlementConsentSnapshot> & { buyer_email_hint?: string | null })
    | undefined;
  if (
    !row?.entitlement_id ||
    !row.market_id ||
    !row.order_id
  ) {
    return null;
  }
  const buyerEmail = row.buyer_email ?? row.buyer_email_hint ?? null;
  return {
    entitlement_id: String(row.entitlement_id),
    market_id: String(row.market_id),
    order_id: String(row.order_id),
    buyer_email: buyerEmail == null ? null : String(buyerEmail),
    buyer_is_recipient: Boolean(row.buyer_is_recipient),
  };
}

function inputFromEntitlement(
  validation: GrantTokenValidated,
  entitlement: EntitlementConsentSnapshot,
  request_id: string
): RecordConsentInput {
  // Review F17 NOTE: when `buyer_is_recipient=false` (gift), recipient_email is
  // null here by design — gift recipients are onboarded through a separate
  // claim flow that captures the recipient PII outside this consent surface.
  return {
    market_id: entitlement.market_id,
    order_id: entitlement.order_id,
    entitlement_id: entitlement.entitlement_id,
    recipient_email: entitlement.buyer_is_recipient ? entitlement.buyer_email : null,
    recipient_phone: null,
    locale: validation.locale,
    is_gift: !entitlement.buyer_is_recipient,
    request_id,
  };
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  setSecurityHeaders(res);

  const marketCtx = marketContextStorage.getStore();
  const marketId = marketCtx?.market_id ?? null;

  // Review F9: derive a stable per-request correlation id from caller headers
  // before validation so all downstream service calls share the same id and
  // double-submits with the same Idempotency-Key collapse (F8).
  const requestId = resolveRequestId(req);

  const validation = validateBody(req.body as RawBody, marketId, requestId);
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
        input = { ...validation, request_id: requestId };
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
        input = inputFromEntitlement(validation, entitlement, requestId);
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

      // Review F2: enforce that the snapshot's market matches the caller's
      // publishable-key-derived market. Mismatch leaks as a generic 404 to
      // avoid disclosing audit-id existence cross-market.
      if (marketId && snapshot.market_id !== marketId) {
        res.status(404).json({
          error: "consent_not_found",
          message: "Original consent audit not found or already withdrawn",
        });
        return;
      }

      // Review F1: refuse to fabricate order_id from a token when the snapshot
      // doesn't carry one. The canonical schema requires `order_id` minLength 1.
      if (!snapshot.order_id || snapshot.order_id.length === 0) {
        res.status(409).json({
          error: "consent_incomplete",
          code: "missing_order_id",
          message: "Original consent audit has no order_id; cannot record withdrawal.",
        });
        return;
      }

      // Review F3: bind the withdrawal to proof of possession of the claim
      // token. Look up the entitlement for the supplied token; reject when
      // the resolved entitlement does not match the snapshot's market+order.
      const db = resolveDb(req);
      if (!db) {
        res.status(503).json({
          error: "service_unavailable",
          code: "gp_core_entitlement_lookup_unavailable",
        });
        return;
      }
      const entitlement = await lookupEntitlementByClaimToken(db, validation.token);
      if (
        !entitlement ||
        entitlement.market_id !== snapshot.market_id ||
        entitlement.order_id !== snapshot.order_id
      ) {
        res.status(404).json({
          error: "consent_not_found",
          message: "Original consent audit not found or already withdrawn",
        });
        return;
      }

      const result = await service.recordWithdrawalTransaction({
        market_id: snapshot.market_id,
        order_id: snapshot.order_id,
        consent_audit_id: validation.compensates_audit_id,
        request_id: requestId,
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
    // Review F5: persist `token_hash` instead of the raw token; the service
    // already accepts a `token` field that lands in the audit JSONB. We pass
    // the hash so the audit chain cannot be used to replay the credential.
    const result = await service.recordPauseAudit({
      market_id: validation.market_id,
      token: hashToken(validation.token),
      locale: validation.locale,
      pause_state: validation.pause_state,
      request_id: requestId,
    });
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
